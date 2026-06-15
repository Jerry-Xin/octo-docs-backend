/**
 * Object-storage presign driver abstraction (§3.5).
 *
 * Binary blobs (images, files) never enter the Y.Doc or a DB large field —
 * they are uploaded directly to object storage and the Y.Doc keeps only a
 * reference (attach_id / object key). This module mints the URLs that flow:
 *   · step 1 — a presigned PUT URL the front-end uploads to directly;
 *   · step 5 — a freshly signed, time-limited GET URL re-issued at read time.
 *
 * The default `local-hmac` driver produces real, verifiable signatures using
 * Node's built-in `crypto` (no cloud creds, no aws-sdk/cos-sdk). The signed URL
 * embeds an expiry timestamp and an HMAC over (objectKey + expiry) keyed by a
 * config secret; `verifySignedUrl()` lets callers/tests assert validity and
 * expiry. A real COS/S3 driver can be slotted in behind the same `ObjectStore`
 * interface and selected via `config.attachments.driver`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config/env.js'

export interface PresignedUpload {
  /** Fully-formed URL the client issues a PUT against. */
  uploadUrl: string
  /** Optional headers the client must echo on the PUT (e.g. Content-Type). */
  headers?: Record<string, string>
}

export interface ObjectStore {
  /** Mint a presigned PUT URL for `objectKey`, valid for `expiresSec`. */
  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload
  /** Mint a signed, time-limited GET URL for `objectKey` (§3.5 step 5). */
  presignGet(objectKey: string, expiresSec: number): string
}

export interface VerifyResult {
  valid: boolean
  /** Set when invalid, for diagnostics/tests: 'missing' | 'expired' | 'bad_signature'. */
  reason?: 'missing' | 'expired' | 'bad_signature'
}

/**
 * Compute the canonical HMAC signature over (method + objectKey + expiry).
 * The method is bound so a GET signature can't be replayed as a PUT.
 */
function sign(method: 'PUT' | 'GET', objectKey: string, expiry: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${method}\n${objectKey}\n${expiry}`)
    .digest('hex')
}

/** Constant-time hex-string comparison (avoids signature timing leaks). */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Default dev/self-hosted driver: deterministic, TTL-bounded HMAC-signed URLs.
 * The base host is derived from the configured bucket; the path is the object
 * key, and the query carries the expiry + signature. `nowSec` is injectable so
 * tests can assert expiry behaviour deterministically.
 */
export class LocalHmacObjectStore implements ObjectStore {
  private readonly bucket: string
  private readonly secret: string
  private readonly nowSec: () => number

  constructor(opts?: { bucket?: string; secret?: string; nowSec?: () => number }) {
    this.bucket = opts?.bucket ?? config.attachments.bucket
    this.secret = opts?.secret ?? config.attachments.signingSecret
    this.nowSec = opts?.nowSec ?? (() => Math.floor(Date.now() / 1000))
  }

  private baseUrl(objectKey: string): string {
    // Path-style URL against the bucket host. Each key segment is encoded but
    // the '/' separators are preserved so the key round-trips cleanly.
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
    return `https://${this.bucket}.object-store.local/${encodedKey}`
  }

  private signedUrl(method: 'PUT' | 'GET', objectKey: string, expiresSec: number): string {
    const expiry = this.nowSec() + expiresSec
    const signature = sign(method, objectKey, expiry, this.secret)
    const url = new URL(this.baseUrl(objectKey))
    url.searchParams.set('X-Method', method)
    url.searchParams.set('X-Expiry', String(expiry))
    url.searchParams.set('X-Signature', signature)
    return url.toString()
  }

  presignPut(objectKey: string, mime: string, expiresSec: number): PresignedUpload {
    return {
      uploadUrl: this.signedUrl('PUT', objectKey, expiresSec),
      headers: { 'Content-Type': mime },
    }
  }

  presignGet(objectKey: string, expiresSec: number): string {
    return this.signedUrl('GET', objectKey, expiresSec)
  }

  /**
   * Verify a previously minted URL: checks the signature matches and the expiry
   * has not passed. Bound to this driver's secret. Exposed for tests and for a
   * future read-proxy that validates inbound signed URLs.
   */
  verify(signedUrl: string): VerifyResult {
    let url: URL
    try {
      url = new URL(signedUrl)
    } catch {
      return { valid: false, reason: 'missing' }
    }
    const method = url.searchParams.get('X-Method')
    const expiryStr = url.searchParams.get('X-Expiry')
    const signature = url.searchParams.get('X-Signature')
    if (!method || !expiryStr || !signature || (method !== 'PUT' && method !== 'GET')) {
      return { valid: false, reason: 'missing' }
    }
    const expiry = Number(expiryStr)
    if (!Number.isFinite(expiry)) return { valid: false, reason: 'missing' }

    // Reconstruct the object key from the path (decode each segment).
    const objectKey = url.pathname
      .replace(/^\//, '')
      .split('/')
      .map(decodeURIComponent)
      .join('/')

    const expected = sign(method, objectKey, expiry, this.secret)
    if (!safeEqualHex(expected, signature)) return { valid: false, reason: 'bad_signature' }
    if (this.nowSec() >= expiry) return { valid: false, reason: 'expired' }
    return { valid: true }
  }
}

let defaultStore: LocalHmacObjectStore | null = null

/**
 * Resolve the configured ObjectStore driver.
 *
 * TODO(§3.5): add a 'cos'/'s3' driver (behind this same switch) that signs real
 * COS/S3 PUT/GET URLs once cloud credentials are available. The interface stays
 * identical so callers (the presign/read routes) need no change.
 */
export function getObjectStore(): ObjectStore {
  switch (config.attachments.driver) {
    case 'local-hmac':
    default:
      if (!defaultStore) defaultStore = new LocalHmacObjectStore()
      return defaultStore
  }
}

/**
 * Verify a signed URL against the default driver's secret. Convenience wrapper
 * used by tests; returns false for drivers that don't support local verification.
 */
export function verifySignedUrl(signedUrl: string): VerifyResult {
  const store = getObjectStore()
  if (store instanceof LocalHmacObjectStore) return store.verify(signedUrl)
  return { valid: false, reason: 'missing' }
}
