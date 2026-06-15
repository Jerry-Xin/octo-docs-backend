/**
 * Attachment presign + read endpoints (§3.5).
 *   POST /api/v1/docs/{docId}/attachments/presign       (needs writer)
 *   GET  /api/v1/docs/{docId}/attachments/{attachId}     (needs reader)
 *
 * Flow (§3.5): the front-end requests a presigned upload URL, uploads the
 * binary directly to object storage (not through Hocuspocus), then the backend
 * registers a doc_attachment row. The Tiptap image node stores the `attach_id`
 * (or a controlled URL) — never base64 — so the Y.Doc stays small. At read time
 * the reference is exchanged for a freshly signed, time-limited GET URL.
 */
import { Router, type Request, type Response } from 'express'
import { requireDocRole } from '../guard.js'
import { newAttachId } from '../../util/ids.js'
import { config } from '../../config/env.js'
import { getObjectStore } from '../../storage/objectStore.js'
import { docAttachmentRepo } from '../../db/repos/docAttachmentRepo.js'

export const attachmentsRouter = Router()

/** Allowed MIME prefixes from config (e.g. 'image/,application/pdf'). */
function allowedMimePrefixes(): string[] {
  return config.attachments.allowedMimePrefixes
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

function mimeAllowed(mime: string): boolean {
  return allowedMimePrefixes().some((prefix) => mime.startsWith(prefix))
}

/** Exact-match MIME denylist from config (e.g. 'image/svg+xml'). */
function blockedMimes(): string[] {
  return config.attachments.blockedMimes
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m !== '')
}

/**
 * A blocked MIME takes precedence over the allowed-prefix check. SVG in
 * particular matches the 'image/' prefix yet can embed <script>, so serving it
 * from our origin is an XSS vector — reject it at presign time.
 */
function mimeBlocked(mime: string): boolean {
  // Drop any '; charset=...' parameters before comparing.
  const base = mime.split(';')[0]!.trim().toLowerCase()
  return blockedMimes().includes(base)
}

/**
 * Reduce a client-supplied file name to a safe single path segment: strip any
 * directory components and reject '..' traversal so the object key can never
 * escape the `${docId}/${attachId}/` prefix.
 */
function sanitizeFileName(fileName: string): string {
  // Take the last path segment regardless of '/' or '\' separators.
  const base = fileName.split(/[/\\]/).pop() ?? ''
  // Drop leading dots so '..' / '...' collapse to a safe name; allow a normal
  // extension dot to remain (e.g. 'photo.png').
  const cleaned = base.replace(/^\.+/, '').trim()
  return cleaned === '' ? 'file' : cleaned
}

attachmentsRouter.post('/:docId/attachments/presign', presignHandler)

export async function presignHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'writer')
  if (!guard) return

  const { fileName, mime, sizeBytes } = req.body ?? {}

  if (typeof fileName !== 'string' || fileName === '') {
    res.status(400).json({ error: 'fileName required' })
    return
  }
  if (typeof mime !== 'string' || !mimeAllowed(mime)) {
    res.status(400).json({
      error: 'mime_not_allowed',
      detail: `mime must be a string starting with one of: ${allowedMimePrefixes().join(', ')}`,
    })
    return
  }
  if (mimeBlocked(mime)) {
    // SVG XSS mitigation (§3.5): block dangerous types even when they match an
    // allowed prefix. The denylist takes precedence over allowedMimePrefixes.
    res.status(400).json({
      error: 'mime_blocked',
      detail: `mime is not permitted: ${blockedMimes().join(', ')}`,
    })
    return
  }
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    res.status(400).json({ error: 'sizeBytes must be a positive number' })
    return
  }
  if (sizeBytes > config.attachments.maxSizeBytes) {
    res.status(400).json({
      error: 'size_too_large',
      detail: `sizeBytes exceeds max of ${config.attachments.maxSizeBytes}`,
    })
    return
  }

  const docId = guard.meta.doc_id
  const attachId = newAttachId()
  const safeName = sanitizeFileName(fileName)
  // attach_id is unique, so the key is collision-free even for duplicate names.
  const objectKey = `${docId}/${attachId}/${safeName}`

  await docAttachmentRepo.register({
    attachId,
    docId,
    objectKey,
    mime,
    sizeBytes,
    createdBy: req.uid!,
  })

  const ttl = config.attachments.uploadUrlTtlSeconds
  const presigned = getObjectStore().presignPut(objectKey, mime, ttl)

  res.status(200).json({
    attachId,
    objectKey,
    bucket: config.attachments.bucket,
    mime,
    sizeBytes,
    uploadUrl: presigned.uploadUrl,
    headers: presigned.headers,
    expiresInSec: ttl,
  })
}

/**
 * Read-time signed URL exchange (§3.5 step 5): look up the attachment, confirm
 * it belongs to this doc, and return a freshly signed time-limited GET URL.
 */
attachmentsRouter.get('/:docId/attachments/:attachId', readHandler)

export async function readHandler(req: Request, res: Response): Promise<void> {
  const guard = await requireDocRole(res, req.uid!, req.params.docId!, 'reader')
  if (!guard) return

  const attachment = await docAttachmentRepo.getById(req.params.attachId!)
  // Hide cross-doc references behind 404 (do not leak existence to other docs).
  if (!attachment || attachment.docId !== guard.meta.doc_id) {
    res.status(404).json({ error: 'not_found' })
    return
  }

  const ttl = config.attachments.readUrlTtlSeconds
  const url = getObjectStore().presignGet(attachment.objectKey, ttl)

  res.status(200).json({
    attachId: attachment.attachId,
    objectKey: attachment.objectKey,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    url,
    expiresInSec: ttl,
  })
}
