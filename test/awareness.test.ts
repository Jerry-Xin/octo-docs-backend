import { describe, it, expect } from 'vitest'
import { validateAwarenessStates } from '../src/collab/server.js'
import type { AuthContext } from '../src/collab/authenticate.js'

function ctxFor(id: string): AuthContext {
  return {
    user: { id },
    role: 'writer',
    permission_epoch: 1,
    space: 's',
    folder: 'f',
    doc: 'd',
  }
}

function presence(id: string, name = 'Ada', color = '#aabbcc') {
  return { user: { id, name, color }, cursor: { anchor: 1, head: 1 } }
}

describe('awareness identity validation (§8.3.1, source-scoped & non-fatal)', () => {
  it("accepts a second concurrent user's own valid presence without throwing", () => {
    // beforeHandleAwareness hands us only THIS source connection's inbound
    // frame. A second authenticated user's update carries their own clientId +
    // their own id — it must validate against THEIR ctx and survive untouched,
    // so two tabs see each other's cursors and the process is never killed.
    const states = new Map<number, Record<string, unknown>>([[42, presence('user-2')]])

    expect(() => validateAwarenessStates(states, ctxFor('user-2'))).not.toThrow()
    expect(states.has(42)).toBe(true)
    expect(states.get(42)).toEqual(presence('user-2'))
    expect(states.size).toBe(1)
  })

  it('does not throw and preserves valid states even with a server-internal (no ctx) update', () => {
    const states = new Map<number, Record<string, unknown>>([[7, presence('user-1')]])
    expect(() => validateAwarenessStates(states, undefined)).not.toThrow()
    expect(states.has(7)).toBe(true)
  })

  it('drops an impostor frame (user.id != source ctx) without throwing, keeping valid states', () => {
    // The source connection belongs to user-1 but crafts a frame claiming to be
    // user-victim. That entry is dropped; the connection's own valid entry stays.
    const states = new Map<number, Record<string, unknown>>([
      [1, presence('user-1')],
      [99, presence('user-victim')],
    ])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true)
    expect(states.has(99)).toBe(false)
    expect(states.size).toBe(1)
  })

  it('drops states with an invalid color (CSS-injection guard) without throwing', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, presence('user-1', 'Ada', '#aabbcc')],
      [2, presence('user-1', 'Eve', 'red; background:url(x)')],
    ])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true)
    expect(states.has(2)).toBe(false)
  })

  it('drops states with a non-string or oversized name without throwing', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, presence('user-1', 'x'.repeat(64))],
      [2, presence('user-1', 'x'.repeat(65))],
      [3, { user: { id: 'user-1', name: 123, color: '#aabbcc' } }],
    ])

    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true) // 64 chars is allowed
    expect(states.has(2)).toBe(false) // 65 chars rejected
    expect(states.has(3)).toBe(false) // non-string name rejected
  })

  it('leaves non-presence awareness data (no user field) untouched', () => {
    const states = new Map<number, Record<string, unknown>>([[1, { cursor: { anchor: 0, head: 0 } }]])
    expect(() => validateAwarenessStates(states, ctxFor('user-1'))).not.toThrow()
    expect(states.has(1)).toBe(true)
  })
})
