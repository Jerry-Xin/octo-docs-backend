/**
 * Centralized environment configuration (§2.1 / §3.4 / §4.4 / §4.7 / §9.5).
 *
 * All process.env access is funneled through here so the rest of the codebase
 * reads a typed, validated config object.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`)
  return n
}

export type OctoIdentityMode = 'http' | 'middleware'

export const config = {
  hostname: str('HOSTNAME', 'octo-docs-local'),
  hocuspocusPort: num('HOCUSPOCUS_PORT', 1234),
  httpPort: num('HTTP_PORT', 3000),

  mysql: {
    host: str('MYSQL_HOST', '127.0.0.1'),
    port: num('MYSQL_PORT', 3306),
    user: str('MYSQL_USER', 'octo_docs'),
    password: str('MYSQL_PASSWORD', 'octo_docs'),
    database: str('MYSQL_DATABASE', 'octo_docs'),
    connectionLimit: num('MYSQL_CONNECTION_LIMIT', 10),
  },

  redis: {
    host: str('REDIS_HOST', '127.0.0.1'),
    port: num('REDIS_PORT', 6379),
    prefix: str('REDIS_PREFIX', 'octo-docs'),
  },

  collabToken: {
    secret: str('COLLAB_TOKEN_SECRET', 'dev-only-change-me'),
    ttlSeconds: num('COLLAB_TOKEN_TTL_SECONDS', 300),
  },

  octoIdentity: {
    mode: str('OCTO_IDENTITY_MODE', 'http') as OctoIdentityMode,
    serverBaseUrl: str('OCTO_SERVER_BASE_URL', 'http://127.0.0.1:8080'),
  },

  attachments: {
    bucket: str('ATTACHMENT_BUCKET', 'octo-docs-attachments'),
    // Object-storage presign driver (§3.5). 'local-hmac' mints real, verifiable
    // HMAC-signed URLs with Node's built-in crypto (no cloud creds/SDK needed);
    // a real COS/S3 driver can be slotted behind the same ObjectStore interface.
    driver: str('ATTACHMENT_DRIVER', 'local-hmac'),
    // Secret keying the HMAC signature over (objectKey + expiry). Dev fallback;
    // MUST be overridden in production.
    signingSecret: str('ATTACHMENT_SIGNING_SECRET', 'dev-only-change-me'),
    // TTL for presigned PUT (upload) URLs.
    uploadUrlTtlSeconds: num('ATTACHMENT_UPLOAD_URL_TTL_SECONDS', 300),
    // TTL for re-issued signed GET (read) URLs (§3.5 step 5).
    readUrlTtlSeconds: num('ATTACHMENT_READ_URL_TTL_SECONDS', 600),
    // Hard cap on attachment size accepted at presign time.
    maxSizeBytes: num('ATTACHMENT_MAX_SIZE_BYTES', 20 * 1024 * 1024),
    // Comma-separated list of allowed MIME prefixes (e.g. 'image/,application/pdf').
    allowedMimePrefixes: str('ATTACHMENT_ALLOWED_MIME_PREFIXES', 'image/'),
  },

  // §9.5 single-document Yjs state hard cap.
  maxDocBytes: num('MAX_DOC_BYTES', 10 * 1024 * 1024),
} as const
