import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test: mock the auth guard and the MySQL pool. The real
// docAttachmentRepo runs against the mocked `query`, so the repo round-trip and
// the route handlers are exercised without live infra.
vi.mock('../src/api/guard.js', () => ({
  requireDocRole: vi.fn(),
}))
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { presignHandler, readHandler } from '../src/api/routes/attachments.js'
import { requireDocRole } from '../src/api/guard.js'
import { docAttachmentRepo } from '../src/db/repos/docAttachmentRepo.js'
import { query } from '../src/db/pool.js'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'
import { verifySignedUrl } from '../src/storage/objectStore.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c
      return this
    },
    json(b: unknown) {
      this.body = b
      return this
    },
  }
  return res
}

function req(params: Record<string, string>, body?: unknown) {
  return { uid: 'u_writer', params, body } as never
}

const writerGuard = { meta: { doc_id: 'd_1' }, role: 'writer' } as never

beforeEach(() => {
  vi.mocked(requireDocRole).mockReset()
  vi.mocked(query).mockReset()
  vi.mocked(query).mockResolvedValue([] as never)
})

describe('POST presign validation (§3.5 step 1)', () => {
  beforeEach(() => vi.mocked(requireDocRole).mockResolvedValue(writerGuard))

  it('rejects a disallowed mime with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'x.exe', mime: 'application/x-msdownload', sizeBytes: 10 }), res as never)
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('mime_not_allowed')
  })

  it('rejects oversize sizeBytes with 400', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'big.png', mime: 'image/png', sizeBytes: 999 * 1024 * 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: string }).error).toBe('size_too_large')
  })

  it('rejects a non-positive / non-number sizeBytes with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: 'a.png', mime: 'image/png', sizeBytes: 0 }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty fileName with 400', async () => {
    const res = mockRes()
    await presignHandler(req({ docId: 'd_1' }, { fileName: '', mime: 'image/png', sizeBytes: 10 }), res as never)
    expect(res.statusCode).toBe(400)
  })

  it('sanitizes a path-traversal fileName so the object key cannot escape', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: '../../etc/passwd', mime: 'image/png', sizeBytes: 1024 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { objectKey: string; uploadUrl: string; attachId: string }
    expect(body.objectKey).not.toContain('..')
    expect(body.objectKey).not.toContain('/etc/')
    expect(body.objectKey).toBe(`d_1/${body.attachId}/passwd`)
    // The minted PUT url is a real, verifiable signature (not a stub).
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
  })

  it('registers the attachment and returns a real presigned PUT url', async () => {
    const res = mockRes()
    await presignHandler(
      req({ docId: 'd_1' }, { fileName: 'photo.png', mime: 'image/png', sizeBytes: 2048 }),
      res as never,
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { uploadUrl: string; expiresInSec: number }
    expect(verifySignedUrl(body.uploadUrl).valid).toBe(true)
    expect(body.expiresInSec).toBeGreaterThan(0)
    // doc_attachment row inserted via the repo's INSERT.
    const insertCall = vi.mocked(query).mock.calls.find((c) => String(c[0]).includes('INSERT INTO doc_attachment'))
    expect(insertCall).toBeTruthy()
  })
})

describe('GET read endpoint (§3.5 step 5)', () => {
  it('404s when the attachment belongs to a different doc', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never)
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_x', doc_id: 'd_OTHER', object_key: 'd_OTHER/att_x/a.png', mime: 'image/png', size_bytes: 1, created_by: 'u', created_at: new Date(0) },
    ] as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_x' }), res as never)
    expect(res.statusCode).toBe(404)
  })

  it('returns a freshly signed GET url for an owned attachment', async () => {
    vi.mocked(requireDocRole).mockResolvedValue({ meta: { doc_id: 'd_1' }, role: 'reader' } as never)
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_1', doc_id: 'd_1', object_key: 'd_1/att_1/photo.png', mime: 'image/png', size_bytes: 2048, created_by: 'u', created_at: new Date(0) },
    ] as never)
    const res = mockRes()
    await readHandler(req({ docId: 'd_1', attachId: 'att_1' }), res as never)
    expect(res.statusCode).toBe(200)
    const body = res.body as { url: string; attachId: string }
    expect(body.attachId).toBe('att_1')
    expect(verifySignedUrl(body.url).valid).toBe(true)
  })
})

describe('docAttachmentRepo (§3.4)', () => {
  it('register issues an INSERT with the mapped columns', async () => {
    await docAttachmentRepo.register({
      attachId: 'att_1',
      docId: 'd_1',
      objectKey: 'd_1/att_1/photo.png',
      mime: 'image/png',
      sizeBytes: 2048,
      createdBy: 'u_1',
    })
    const call = vi.mocked(query).mock.calls[0]!
    expect(String(call[0])).toContain('INSERT INTO doc_attachment')
    expect(call[1]).toEqual(['att_1', 'd_1', 'd_1/att_1/photo.png', 'image/png', 2048, 'u_1'])
  })

  it('getById maps snake_case columns to camelCase', async () => {
    vi.mocked(query).mockResolvedValue([
      { attach_id: 'att_1', doc_id: 'd_1', object_key: 'd_1/att_1/p.png', mime: 'image/png', size_bytes: 2048, created_by: 'u_1', created_at: new Date(0) },
    ] as never)
    const got = await docAttachmentRepo.getById('att_1')
    expect(got).toEqual({
      attachId: 'att_1',
      docId: 'd_1',
      objectKey: 'd_1/att_1/p.png',
      mime: 'image/png',
      sizeBytes: 2048,
      createdBy: 'u_1',
      createdAt: new Date(0),
    })
  })

  it('getById returns null when no row exists', async () => {
    vi.mocked(query).mockResolvedValue([] as never)
    expect(await docAttachmentRepo.getById('nope')).toBeNull()
  })
})

describe('schema image node (§7.1 / §9.2)', () => {
  it('pins SCHEMA_VERSION to 2 (SCHEMA-SPEC segment 2)', () => {
    expect(typeof SCHEMA_VERSION).toBe('number')
    expect(SCHEMA_VERSION).toBe(2)
  })

  it('includes the image node so server-side conversion preserves images', () => {
    const schema = buildSchema()
    expect(schema.nodes.image).toBeDefined()
    const attrs = schema.nodes.image!.spec.attrs ?? {}
    expect(Object.keys(attrs)).toEqual(
      expect.arrayContaining(['attach_id', 'src', 'alt', 'width', 'align']),
    )
    // snake_case attach_id only — the camelCase attachId and the title attr
    // were removed to byte-match SCHEMA-SPEC segment 2.
    expect(attrs).not.toHaveProperty('attachId')
    expect(attrs).not.toHaveProperty('title')
  })
})
