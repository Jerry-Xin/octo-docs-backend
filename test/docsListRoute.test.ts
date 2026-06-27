import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the GET /api/v1/docs list serializer. Mock the doc_meta
// repo so the handler runs without live MySQL (mirrors docsRoutes.test.ts, which
// covers the single-doc GET). The list is membership-scoped in SQL, so it takes
// no per-row guard — we only assert the wire shape the handler emits.
vi.mock('../src/db/repos/docMetaRepo.js', () => ({
  docMetaRepo: {
    listForUser: vi.fn(),
  },
}))

import { listDocsHandler } from '../src/api/routes/docs.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'

interface MockRes {
  statusCode: number
  body: unknown
  status(c: number): MockRes
  json(b: unknown): MockRes
}

function mockRes(): MockRes {
  return {
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
}

function req(uid: string) {
  return { uid, params: {}, body: undefined, query: {} } as never
}

/** doc_meta rows as listForUser returns them (snake_case + resolved role). */
function row(over: Partial<Record<string, unknown>>) {
  return {
    doc_id: 'd_1',
    document_name: 'octo:s1:f_default:d_1',
    title: 'Doc',
    owner_id: 'u_owner',
    space_id: 's1',
    folder_id: 'f_default',
    doc_type: 'doc',
    status: 1,
    permission_epoch: 0,
    created_at: new Date(0),
    updated_at: new Date(1000),
    created_by: 'u_owner',
    updated_by: 'u_owner',
    role: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(docMetaRepo.listForUser).mockReset()
})

describe('GET /api/v1/docs — list serializer (§8.4)', () => {
  it('surfaces top-level camelCase docType on every item', async () => {
    vi.mocked(docMetaRepo.listForUser).mockResolvedValue({
      total: 2,
      items: [
        row({ doc_id: 'd_doc', doc_type: 'doc', role: 3 }),
        row({ doc_id: 'd_board', doc_type: 'board', role: 1 }),
      ],
    } as never)

    const res = mockRes()
    await listDocsHandler(req('u_owner'), res as never)

    expect(res.statusCode).toBe(200)
    const body = res.body as { total: number; items: Array<Record<string, unknown>> }
    expect(body.total).toBe(2)
    expect(body.items[0]).toEqual({
      docId: 'd_doc',
      title: 'Doc',
      ownerId: 'u_owner',
      role: 'admin',
      updatedAt: new Date(1000),
      docType: 'doc',
    })
    expect(body.items[1]!.docType).toBe('board')
  })

  it('returns docType for a non-creator member (reader), not just the owner', async () => {
    // Caller u_reader is NOT the owner; listForUser surfaces them via membership
    // with role=reader. The serializer must still carry the authoritative docType.
    vi.mocked(docMetaRepo.listForUser).mockResolvedValue({
      total: 1,
      items: [row({ doc_id: 'd_board', owner_id: 'u_owner', doc_type: 'board', role: 1 })],
    } as never)

    const res = mockRes()
    await listDocsHandler(req('u_reader'), res as never)

    const item = (res.body as { items: Array<Record<string, unknown>> }).items[0]!
    expect(item.role).toBe('reader')
    expect(item.docType).toBe('board')
  })

  it('never leaks snake_case columns on the wire', async () => {
    vi.mocked(docMetaRepo.listForUser).mockResolvedValue({
      total: 1,
      items: [row({})],
    } as never)

    const res = mockRes()
    await listDocsHandler(req('u_owner'), res as never)

    const item = (res.body as { items: Array<Record<string, unknown>> }).items[0]!
    expect(item).not.toHaveProperty('doc_type')
    expect(item).not.toHaveProperty('doc_id')
    expect(item).not.toHaveProperty('owner_id')
    expect(item).not.toHaveProperty('document_name')
  })
})
