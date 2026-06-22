import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression for the prepared-statement pagination 500: `query()` runs on
// mysql2 `.execute()`, which rejects a numeric LIMIT/OFFSET bound via `?` with
// ER_WRONG_ARGUMENTS (errno 1210). The fix inlines a validated integer instead.
// These tests capture the (sql, params) handed to the pool and assert the shape
// the bug would have violated: LIMIT/OFFSET are inlined integers, never `?`, and
// their values are absent from the params array. This is the shape assertion
// that would have caught the original bug without a live MySQL connection.
vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(async () => []),
  transaction: vi.fn(),
}))

import { docVersionRepo } from '../src/db/repos/docVersionRepo.js'
import { docCommentRepo } from '../src/db/repos/docCommentRepo.js'
import { docMetaRepo } from '../src/db/repos/docMetaRepo.js'
import { query } from '../src/db/pool.js'

const mockQuery = vi.mocked(query)

/** The (sql, params) of the last `query()` call. */
function lastCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.at(-1)
  if (!call) throw new Error('query() was never called')
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockQuery.mockResolvedValue([] as never)
})

describe('paginated repos inline a validated integer LIMIT/OFFSET (no numeric `?` bind)', () => {
  it('docVersionRepo.listByDoc inlines LIMIT and drops it from params', async () => {
    await docVersionRepo.listByDoc('d_1', { limit: 20 })
    const { sql, params } = lastCall()
    // Fetches limit+1 to detect a further page; clamp(20)+1 = 21.
    expect(sql).toMatch(/LIMIT 21\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    // Only the bind params survive (doc_id, plus kind filter by default); the
    // limit value (21) must not appear among them.
    expect(params).not.toContain(21)
    expect(params).not.toContain(20)
  })

  it('docVersionRepo.listByDoc falls back to the default integer on a fractional limit', async () => {
    await docVersionRepo.listByDoc('d_1', { limit: 20.5 } as never)
    // 20.5 is not an integer → falls back to default 20 → fetch limit+1 = 21.
    expect(lastCall().sql).toMatch(/LIMIT 21\b/)
    expect(lastCall().sql).not.toMatch(/LIMIT 21\.5/)
    expect(lastCall().sql).not.toMatch(/LIMIT \?/)
  })

  it('docCommentRepo.listRoots inlines LIMIT and clamps an untrusted value', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 50 } as never)
    const { sql, params } = lastCall()
    expect(sql).toMatch(/LIMIT 50\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(50)
  })

  it('docCommentRepo.listRoots clamps an out-of-range / non-integer limit to 1..100', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 9999 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 100\b/)

    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 0 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 1\b/)

    await docCommentRepo.listRoots('d_1', { includeResolved: true, limit: 12.5 } as never)
    expect(lastCall().sql).toMatch(/LIMIT 20\b/)
  })

  it('docMetaRepo.listForUser inlines both LIMIT and OFFSET and drops them from params', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 3, pageSize: 25, sort: 'updatedAt:desc' })
    const { sql, params } = lastCall()
    expect(sql).toMatch(/LIMIT 25 OFFSET 50\b/) // offset = (page-1)*pageSize = 50
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(sql).not.toMatch(/OFFSET \?/)
    expect(params).not.toContain(25)
    expect(params).not.toContain(50)
  })

  it('docMetaRepo.listForUser clamps pageSize and never emits a negative OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 1, pageSize: 9999, sort: 'updatedAt:asc' })
    expect(lastCall().sql).toMatch(/LIMIT 100 OFFSET 0\b/)
  })

  // The production 500 fired on requests that carried no limit at all, not just
  // on out-of-range values. These assert the omitted-limit path still inlines a
  // safe integer LIMIT (the default) rather than falling back to a `?` bind.
  it('docVersionRepo.listByDoc with no opts inlines the default LIMIT', async () => {
    await docVersionRepo.listByDoc('d_1')
    const { sql, params } = lastCall()
    // default limit 20 → fetch limit+1 = 21.
    expect(sql).toMatch(/LIMIT 21\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(params).not.toContain(21)
    expect(params).not.toContain(20)
  })

  it('docCommentRepo.listRoots with no limit field inlines the default LIMIT', async () => {
    await docCommentRepo.listRoots('d_1', { includeResolved: true } as never)
    const { sql } = lastCall()
    expect(sql).toMatch(/LIMIT 20\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
  })

  it('docMetaRepo.listForUser with pageSize omitted inlines the default LIMIT/OFFSET', async () => {
    await docMetaRepo.listForUser({ uid: 'u_1', page: 3, sort: 'updatedAt:desc' } as never)
    const { sql, params } = lastCall()
    // default pageSize 20 → offset = (3-1)*20 = 40.
    expect(sql).toMatch(/LIMIT 20 OFFSET 40\b/)
    expect(sql).not.toMatch(/LIMIT \?/)
    expect(sql).not.toMatch(/OFFSET \?/)
    expect(params).not.toContain(20)
    expect(params).not.toContain(40)
  })
})

// Regression for the spaceId/folderId arg-binding misalignment. The `base` clause
// has positional `?` in this order: JOIN `dm.uid = ?`, optional `m.space_id = ?`,
// optional `m.folder_id = ?`, then WHERE `m.owner_id = ?`. The old code built args
// as [uid, uid, spaceId?, folderId?], which bound space_id to the uid and the
// trailing owner_id to the spaceId — so a spaceId filter matched `owner_id =
// <spaceId>` and returned zero rows for the owner. These tests assert the args
// array lines up positionally with the placeholders, which fails on the old order.
describe('docMetaRepo.listForUser binds space/folder filters positionally', () => {
  it('count query: args are [joinUid, spaceId, ownerUid] when spaceId is given', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_42',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // The COUNT(*) query is the first of the two query() calls.
    const countCall = mockQuery.mock.calls[0]!
    const sql = countCall[0] as string
    const params = (countCall[1] ?? []) as unknown[]
    expect(sql).toMatch(/COUNT\(\*\)/)
    // Placeholder order in `base`: dm.uid, m.space_id, m.owner_id.
    expect(params).toEqual(['u_1', 's_42', 'u_1'])
    // The old buggy order would have been ['u_1', 'u_1', 's_42'] — owner_id bound
    // to the spaceId. Assert that specifically is gone.
    expect(params).not.toEqual(['u_1', 'u_1', 's_42'])
  })

  it('items query: args are [caseOwnerUid, joinUid, spaceId, ownerUid] when spaceId is given', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_1',
      spaceId: 's_42',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    // The items SELECT is the last query() call. Its placeholder order is:
    // CASE m.owner_id=?, JOIN dm.uid=?, m.space_id=?, WHERE m.owner_id=?.
    const { params } = lastCall()
    expect(params).toEqual(['u_1', 'u_1', 's_42', 'u_1'])
  })

  it('orders space then folder, with join uid first and owner uid last', async () => {
    await docMetaRepo.listForUser({
      uid: 'owner_x',
      spaceId: 'space_y',
      folderId: 'folder_z',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const countCall = mockQuery.mock.calls[0]!
    const params = (countCall[1] ?? []) as unknown[]
    // JOIN dm.uid, m.space_id, m.folder_id, WHERE m.owner_id.
    expect(params).toEqual(['owner_x', 'space_y', 'folder_z', 'owner_x'])
  })

  // Behavioural framing of the same fix: with the misaligned binding, the row's
  // own space_id was compared against the caller's uid and the owner_id against
  // the spaceId, so an owner querying their own space matched nothing. Here we
  // assert the WHERE binds owner_id to the uid (match) and space_id to the
  // requested space — the only way "owner + correct space" can return the row,
  // and the only way a wrong space can return empty.
  it('binds owner_id to the uid and space_id to the requested space (owner+space match)', async () => {
    await docMetaRepo.listForUser({
      uid: 'u_owner',
      spaceId: 's_correct',
      page: 1,
      pageSize: 10,
      sort: 'updatedAt:desc',
    })
    const countParams = (mockQuery.mock.calls[0]![1] ?? []) as unknown[]
    // space_id placeholder (index 1) must carry the space, not the uid…
    expect(countParams[1]).toBe('s_correct')
    // …and the trailing owner_id placeholder (last) must carry the uid, not the space.
    expect(countParams.at(-1)).toBe('u_owner')
  })
})
