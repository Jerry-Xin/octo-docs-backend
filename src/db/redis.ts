/**
 * Shared ioredis client (§5 / §4.5).
 *
 * Redis is used as: real-time pub/sub broadcast bus (via extension-redis),
 * permission_epoch READ CACHE (authoritative value lives in DB, §4.5 P2-E),
 * and the cross-node connection registry (§4.5). Redis is NOT an authoritative
 * store and does NOT carry update catch-up (§5.3).
 */
import { Redis, type RedisOptions } from 'ioredis'
import { config } from '../config/env.js'

let client: Redis | null = null

/**
 * AUTH/TLS overlay (no host/port), for clients that set host/port themselves —
 * e.g. the Hocuspocus extension-redis, which takes its own host/port and an
 * `options` bag. password is omitted when empty (the no-AUTH default) and tls
 * is omitted unless enabled, since passing `tls: {}` forces a TLS handshake.
 */
export function redisAuthOptions(): RedisOptions {
  const opts: RedisOptions = {}
  if (config.redis.password) opts.password = config.redis.password
  if (config.redis.tls) opts.tls = {}
  return opts
}

/** Full ioredis connection options (host/port + AUTH/TLS overlay) from env. */
export function redisConnectionOptions(): RedisOptions {
  return {
    host: config.redis.host,
    port: config.redis.port,
    ...redisAuthOptions(),
  }
}

/**
 * Attach explicit connection-lifecycle logging to an ioredis client.
 *
 * Replaces the previous silent best-effort behaviour: a Redis that never
 * connects (wrong host, AUTH required, TLS mismatch) failed invisibly, which is
 * exactly why XIN-79's `received=0` was so hard to localize. We now log
 * connect / ready / reconnecting / error / close so a broken bus is obvious in
 * the logs. `label` distinguishes the shared client from other clients (e.g.
 * the epoch subscriber). The password is never logged.
 */
export function attachRedisLogging(c: Redis, label: string): void {
  const target = `${config.redis.host}:${config.redis.port}${config.redis.tls ? ' (tls)' : ''}`
  c.on('connect', () => {
    // eslint-disable-next-line no-console
    console.log(`[octo-docs] redis(${label}) connecting to ${target}`)
  })
  c.on('ready', () => {
    // eslint-disable-next-line no-console
    console.log(`[octo-docs] redis(${label}) ready`)
  })
  c.on('reconnecting', (delayMs: number) => {
    // eslint-disable-next-line no-console
    console.warn(`[octo-docs] redis(${label}) reconnecting in ${delayMs}ms`)
  })
  c.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`[octo-docs] redis(${label}) error: ${err.message}`)
  })
  c.on('end', () => {
    // eslint-disable-next-line no-console
    console.warn(`[octo-docs] redis(${label}) connection closed`)
  })
}

export function getRedis(): Redis {
  if (!client) {
    client = new Redis({
      ...redisConnectionOptions(),
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    })
    attachRedisLogging(client, 'shared')
  }
  return client
}

/** Namespaced key helper so multiple products can share one Redis (§2.1 prefix). */
export function rkey(...parts: string[]): string {
  return [config.redis.prefix, ...parts].join(':')
}

/**
 * Best-effort short-lived lock via `SET key val NX PX ttlMs` (§5.5 L1).
 *
 * Returns true if THIS caller set the key (won the window), false if it was
 * already held. Used by the auto-snapshot dedup guard so that under multi-node
 * deployment only one node writes a given KIND_AUTO frame per window. The key
 * auto-expires after ttlMs — the window IS the throttle, so we never explicitly
 * release. A non-integer / non-positive ttl is coerced to a 1ms floor so the
 * SET never throws on a bad config value.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const px = Math.max(1, Math.floor(ttlMs))
  const res = await getRedis().set(key, '1', 'PX', px, 'NX')
  return res === 'OK'
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect()
    client = null
  }
}
