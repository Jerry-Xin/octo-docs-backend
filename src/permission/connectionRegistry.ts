/**
 * Cross-node connection registry (§4.5 step 2).
 *
 * Each active collaboration connection registers
 *   { document_name, uid, node, connectionId, role, permission_epoch }
 * so that on a doc_member change a node can locate the connections to act on
 * (close 4403 / flip readOnly). Cleared on disconnect.
 *
 * Stored as a Redis hash per document: field = connectionId, value = JSON.
 *
 * Dead-node TTL (XIN-79): a non-graceful shutdown (crash / OOM / SIGKILL) never
 * runs `unregister`, so the killed node's hash fields leak forever and pollute
 * every `list`. To bound that, each node keeps a short-lived liveness key that
 * it refreshes on a heartbeat; `list` drops (and lazily reaps) any connection
 * whose owning node's liveness key has expired.
 */
import { getRedis, rkey } from '../db/redis.js'
import { config } from '../config/env.js'
import type { Role } from './role.js'

export interface RegisteredConnection {
  documentName: string
  uid: string
  node: string
  connectionId: string
  role: Role
  permission_epoch: number
}

function regKey(documentName: string): string {
  return rkey('conn', documentName)
}

/** Per-node liveness key; presence == the node is alive (refreshed on heartbeat). */
function nodeKey(node: string): string {
  return rkey('node-alive', node)
}

function nodeTtl(): number {
  return Math.max(1, Math.floor(config.redis.nodeTtlSeconds))
}

async function nodeAlive(node: string): Promise<boolean> {
  try {
    return (await getRedis().exists(nodeKey(node))) === 1
  } catch {
    return true // can't confirm death => fail-open, never reap a maybe-live conn
  }
}

export const connectionRegistry = {
  async register(entry: RegisteredConnection): Promise<void> {
    try {
      const redis = getRedis()
      await redis.hset(regKey(entry.documentName), entry.connectionId, JSON.stringify(entry))
      // Registering implies this node is live; refresh the liveness key so a
      // peer's list() never reaps our fresh connection before the first
      // heartbeat tick lands.
      await redis.set(nodeKey(entry.node), '1', 'EX', nodeTtl())
    } catch {
      /* registry is best-effort; beforeHandleMessage recheck is the backstop */
    }
  },

  async unregister(documentName: string, connectionId: string): Promise<void> {
    try {
      await getRedis().hdel(regKey(documentName), connectionId)
    } catch {
      /* best-effort */
    }
  },

  /**
   * Refresh this node's liveness key. Called on a heartbeat (index.ts) at half
   * the TTL so a live node's key never lapses between ticks.
   */
  async heartbeat(node: string): Promise<void> {
    try {
      await getRedis().set(nodeKey(node), '1', 'EX', nodeTtl())
    } catch {
      /* best-effort */
    }
  },

  /**
   * Drop this node's liveness key on graceful shutdown so peers reap its
   * connections immediately instead of waiting out the TTL.
   */
  async markNodeDown(node: string): Promise<void> {
    try {
      await getRedis().del(nodeKey(node))
    } catch {
      /* best-effort */
    }
  },

  /** List connections for a document (optionally filtered to a uid). */
  async list(documentName: string, uid?: string): Promise<RegisteredConnection[]> {
    const redis = getRedis()
    let all: Record<string, string> = {}
    try {
      all = await redis.hgetall(regKey(documentName))
    } catch {
      return []
    }
    const out: RegisteredConnection[] = []
    const deadFields: string[] = []
    const aliveByNode = new Map<string, boolean>()
    for (const [field, raw] of Object.entries(all)) {
      let entry: RegisteredConnection
      try {
        entry = JSON.parse(raw) as RegisteredConnection
      } catch {
        continue // malformed — skip (can't attribute to a node to reap)
      }
      let alive = aliveByNode.get(entry.node)
      if (alive === undefined) {
        alive = await nodeAlive(entry.node)
        aliveByNode.set(entry.node, alive)
      }
      if (!alive) {
        deadFields.push(field) // owning node is gone => reap the leaked field
        continue
      }
      if (!uid || entry.uid === uid) out.push(entry)
    }
    if (deadFields.length > 0) {
      try {
        await redis.hdel(regKey(documentName), ...deadFields)
      } catch {
        /* best-effort: reaping is opportunistic, the filter above already excluded them */
      }
    }
    return out
  },
}
