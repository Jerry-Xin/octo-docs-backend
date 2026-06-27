import { describe, it, expect, vi, beforeEach } from 'vitest'

// Offline unit test for the Redis connection-option builders (auth/TLS env
// read, hardening item 1). config is mocked so we can flip password/tls without
// touching process.env, and assert the options bag passed to ioredis.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { redis: { host: 'redis.internal', port: 6380, prefix: 'octo-docs', password: '', tls: false, nodeTtlSeconds: 30 } },
}))
vi.mock('../src/config/env.js', () => ({ config: mockConfig }))

import { redisAuthOptions, redisConnectionOptions, attachRedisLogging } from '../src/db/redis.js'

beforeEach(() => {
  mockConfig.redis.password = ''
  mockConfig.redis.tls = false
})

describe('redis connection options (hardening: auth/TLS from env)', () => {
  it('omits password and tls when neither is configured (no-AUTH default)', () => {
    expect(redisAuthOptions()).toEqual({})
    expect(redisConnectionOptions()).toEqual({ host: 'redis.internal', port: 6380 })
  })

  it('includes the password only when set', () => {
    mockConfig.redis.password = 's3cret'
    expect(redisAuthOptions()).toEqual({ password: 's3cret' })
    expect(redisConnectionOptions()).toMatchObject({ host: 'redis.internal', port: 6380, password: 's3cret' })
    expect(redisConnectionOptions().tls).toBeUndefined()
  })

  it('enables tls only when REDIS_TLS is on', () => {
    mockConfig.redis.tls = true
    expect(redisAuthOptions()).toEqual({ tls: {} })
    expect(redisConnectionOptions().tls).toEqual({})
  })

  it('carries both password and tls when both are configured', () => {
    mockConfig.redis.password = 'pw'
    mockConfig.redis.tls = true
    expect(redisAuthOptions()).toEqual({ password: 'pw', tls: {} })
  })
})

describe('attachRedisLogging (hardening: explicit connect logging)', () => {
  it('registers lifecycle listeners and logs on connect / error', () => {
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const fakeClient = {
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event] = cb
        return this
      },
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachRedisLogging(fakeClient as any, 'shared')
    expect(Object.keys(handlers).sort()).toEqual(['connect', 'end', 'error', 'ready', 'reconnecting'])

    handlers.connect?.()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('redis(shared) connecting'))
    handlers.error?.(new Error('ECONNREFUSED'))
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))

    logSpy.mockRestore()
    errSpy.mockRestore()
  })
})
