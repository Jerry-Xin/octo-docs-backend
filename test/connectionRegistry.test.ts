import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the cross-node connection registry (§4.5 step 2) and
// its dead-node TTL reaping (XIN-79). A stateful fake Redis backs hset/hdel/
// hgetall plus the per-node liveness key (set/exists/del). config is mocked so
// the node TTL is deterministic.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { redis: { host: '127.0.0.1', port: 6379, prefix: 'octo-docs', nodeTtlSeconds: 30 } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

// Hashes: key -> field -> value. Plain keys: key -> value (liveness markers).
const hashes = new Map<string, Map<string, string>>()
const keys = new Set<string>()

const fakeRedis = {
  async hset(key: string, field: string, value: string): Promise<number> {
    const h = hashes.get(key) ?? new Map<string, string>()
    const isNew = !h.has(field)
    h.set(field, value)
    hashes.set(key, h)
    return isNew ? 1 : 0
  },
  async hdel(key: string, ...fields: string[]): Promise<number> {
    const h = hashes.get(key)
    if (!h) return 0
    let n = 0
    for (const f of fields) if (h.delete(f)) n++
    return n
  },
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(hashes.get(key) ?? new Map())
  },
  async set(key: string, _v: string, _mode: string, _ttl: number): Promise<'OK'> {
    keys.add(key)
    return 'OK'
  },
  async exists(key: string): Promise<number> {
    return keys.has(key) ? 1 : 0
  },
  async del(key: string): Promise<number> {
    return keys.delete(key) ? 1 : 0
  },
}

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => fakeRedis,
  rkey: (...parts: string[]) => ['octo-docs', ...parts].join(':'),
}))

import { connectionRegistry, type RegisteredConnection } from '../src/permission/connectionRegistry.js'

const conn = (over: Partial<RegisteredConnection> = {}): RegisteredConnection => ({
  documentName: 'octo:s1:f1:d1',
  uid: 'u1',
  node: 'node-a',
  connectionId: 'c1',
  role: 'writer',
  permission_epoch: 1,
  ...over,
})

const setSpy = vi.spyOn(fakeRedis, 'set')
const hdelSpy = vi.spyOn(fakeRedis, 'hdel')

beforeEach(() => {
  hashes.clear()
  keys.clear()
  setSpy.mockClear()
  hdelSpy.mockClear()
  mockConfig.redis.nodeTtlSeconds = 30
})

describe('connectionRegistry (§4.5 step 2)', () => {
  it('register stores the entry and refreshes the owning node liveness key with a TTL', async () => {
    await connectionRegistry.register(conn())
    expect(await fakeRedis.hgetall('octo-docs:conn:octo:s1:f1:d1')).toHaveProperty('c1')
    // node liveness key written with EX <ttl>
    expect(setSpy).toHaveBeenCalledWith('octo-docs:node-alive:node-a', '1', 'EX', 30)
    expect(keys.has('octo-docs:node-alive:node-a')).toBe(true)
  })

  it('list returns connections whose owning node is still alive', async () => {
    await connectionRegistry.register(conn({ connectionId: 'c1', uid: 'u1' }))
    await connectionRegistry.register(conn({ connectionId: 'c2', uid: 'u2' }))
    const all = await connectionRegistry.list('octo:s1:f1:d1')
    expect(all.map((c) => c.connectionId).sort()).toEqual(['c1', 'c2'])
    const onlyU1 = await connectionRegistry.list('octo:s1:f1:d1', 'u1')
    expect(onlyU1.map((c) => c.connectionId)).toEqual(['c1'])
  })

  it('reaps connections owned by a dead node (non-graceful shutdown leak, XIN-79)', async () => {
    // node-a is alive; node-b registered then died non-gracefully (its liveness
    // key expired) but left its hash field behind.
    await connectionRegistry.register(conn({ node: 'node-a', connectionId: 'live' }))
    await connectionRegistry.register(conn({ node: 'node-b', connectionId: 'leaked' }))
    keys.delete('octo-docs:node-alive:node-b') // simulate TTL expiry of the dead node

    const out = await connectionRegistry.list('octo:s1:f1:d1')
    expect(out.map((c) => c.connectionId)).toEqual(['live'])
    // the leaked field is lazily reaped from the hash, not just filtered out
    expect(hdelSpy).toHaveBeenCalledWith('octo-docs:conn:octo:s1:f1:d1', 'leaked')
    expect(await fakeRedis.hgetall('octo-docs:conn:octo:s1:f1:d1')).not.toHaveProperty('leaked')
  })

  it('heartbeat refreshes the node liveness key and markNodeDown clears it', async () => {
    await connectionRegistry.heartbeat('node-a')
    expect(keys.has('octo-docs:node-alive:node-a')).toBe(true)
    expect(setSpy).toHaveBeenLastCalledWith('octo-docs:node-alive:node-a', '1', 'EX', 30)

    await connectionRegistry.markNodeDown('node-a')
    expect(keys.has('octo-docs:node-alive:node-a')).toBe(false)
  })

  it('skips malformed entries without throwing', async () => {
    keys.add('octo-docs:node-alive:node-a')
    const h = new Map<string, string>([['bad', '{not json']])
    hashes.set('octo-docs:conn:octo:s1:f1:d1', h)
    const out = await connectionRegistry.list('octo:s1:f1:d1')
    expect(out).toEqual([])
  })

  it('coerces a non-positive node TTL to a 1s floor', async () => {
    mockConfig.redis.nodeTtlSeconds = 0
    await connectionRegistry.heartbeat('node-a')
    expect(setSpy).toHaveBeenLastCalledWith('octo-docs:node-alive:node-a', '1', 'EX', 1)
  })
})
