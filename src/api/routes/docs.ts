/**
 * Document CRUD routes (§8.4): create / list / rename / soft-delete.
 * Mounted under /api/v1/docs.
 */
import { Router, type Request, type Response } from 'express'
import { docMetaRepo } from '../../db/repos/docMetaRepo.js'
import { buildDocumentName, DocumentNameError } from '../../permission/documentName.js'
import { buildWhiteboardName, WhiteboardNameError } from '../../whiteboard/schema/index.js'
import { refreshAndPublish } from '../../permission/epoch.js'
import { newDocId } from '../../util/ids.js'
import { requireDocRole } from '../guard.js'

export const docsRouter = Router()

const DEFAULT_FOLDER = 'f_default'

/**
 * docType value the front-end stamps on whiteboards (DocsHome create menu /
 * docsApi). Boards persist + address under the 5-segment `:wb:` key; everything
 * else is a rich-text document under the 4-segment key.
 */
const WHITEBOARD_DOC_TYPE = 'board'

/**
 * Build the canonical persistence/routing document_name for a freshly created
 * doc. This is the SINGLE place a new key is minted, and it must agree with the
 * key the client addresses on join and the key onAuthenticate parses:
 *
 *   - whiteboard (docType 'board'): `octo:{space}:{folder}:wb:{docId}` (5-seg) —
 *     the board id is the {board} segment (BoardSession passes `board: docId`),
 *     so collab-token issuance + WS auth resolve the row by the same key the
 *     browser joins with. Minting a 4-seg `d_` key here was the hop-2 join 404:
 *     persistence wrote 4-seg while the client/auth path addressed 5-seg `:wb:`.
 *   - document: `octo:{space}:{folder}:{docId}` (4-seg).
 *
 * Throws DocumentNameError / WhiteboardNameError on an illegal segment.
 */
export function buildCreatedDocumentName(
  spaceId: string,
  folder: string,
  docId: string,
  docType: string,
): string {
  // documentName 3rd segment MUST equal folder_id (§8.1 invariant).
  return docType === WHITEBOARD_DOC_TYPE
    ? buildWhiteboardName(spaceId, folder, docId)
    : buildDocumentName(spaceId, folder, docId)
}

/** POST /api/v1/docs — create. Creator becomes owner (implicit admin, §4.2). */
export async function createDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const { spaceId, folderId, title, docType } = req.body ?? {}
  if (typeof spaceId !== 'string' || spaceId === '') {
    res.status(400).json({ error: 'spaceId required' })
    return
  }
  const folder = typeof folderId === 'string' && folderId !== '' ? folderId : DEFAULT_FOLDER
  const resolvedDocType = typeof docType === 'string' && docType !== '' ? docType : 'doc'
  const docId = newDocId()
  let documentName: string
  try {
    documentName = buildCreatedDocumentName(spaceId, folder, docId, resolvedDocType)
  } catch (err) {
    if (err instanceof DocumentNameError || err instanceof WhiteboardNameError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }
  await docMetaRepo.create({
    docId,
    documentName,
    title: typeof title === 'string' ? title : '',
    ownerId: uid,
    spaceId,
    folderId: folder,
    docType: resolvedDocType,
    createdBy: uid,
  })
  const meta = await docMetaRepo.getByDocId(docId)
  res.status(201).json({
    docId,
    documentName,
    title: meta?.title ?? '',
    spaceId,
    folderId: folder,
    ownerId: uid,
    docType: resolvedDocType,
    role: 'admin',
    createdAt: meta?.created_at,
  })
}

docsRouter.post('/', createDocHandler)

/** GET /api/v1/docs/{docId} — fetch one doc's metadata (needs reader). */
export async function getDocHandler(req: Request, res: Response) {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, 'reader')
  if (!guard) return
  const { meta, role } = guard
  res.status(200).json({
    docId: meta.doc_id,
    documentName: meta.document_name,
    title: meta.title,
    ownerId: meta.owner_id,
    spaceId: meta.space_id,
    folderId: meta.folder_id,
    docType: meta.doc_type,
    role,
    createdAt: meta.created_at,
    updatedAt: meta.updated_at,
    ...(meta.permission_epoch != null ? { permissionEpoch: meta.permission_epoch } : {}),
  })
}

/** GET /api/v1/docs — list docs the caller owns or is a member of. */
docsRouter.get('/', async (req: Request, res: Response) => {
  const uid = req.uid!
  const spaceId = typeof req.query.spaceId === 'string' ? req.query.spaceId : undefined
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : undefined
  const page = Math.max(1, Number(req.query.page ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20))
  const sort = req.query.sort === 'updatedAt:asc' ? 'updatedAt:asc' : 'updatedAt:desc'

  const { total, items } = await docMetaRepo.listForUser({ uid, spaceId, folderId, page, pageSize, sort })
  const roleName = (n: number) => (n === 3 ? 'admin' : n === 2 ? 'writer' : 'reader')
  res.status(200).json({
    total,
    items: items.map((d) => ({
      docId: d.doc_id,
      title: d.title,
      ownerId: d.owner_id,
      role: roleName(Number(d.role)),
      updatedAt: d.updated_at,
    })),
  })
})

// Registered after GET '/' so the collection route is matched distinctly from
// the single-doc route (Express treats '/' and '/:docId' as separate paths).
docsRouter.get('/:docId', getDocHandler)

/** PATCH /api/v1/docs/{docId} — rename (needs admin). */
docsRouter.patch('/:docId', async (req: Request, res: Response) => {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, 'admin')
  if (!guard) return
  const { title } = req.body ?? {}
  if (typeof title !== 'string' || title === '') {
    res.status(400).json({ error: 'title required' })
    return
  }
  await docMetaRepo.rename(docId, title)
  res.status(200).json({ docId, title })
})

/** DELETE /api/v1/docs/{docId} — soft delete (needs admin). */
docsRouter.delete('/:docId', async (req: Request, res: Response) => {
  const uid = req.uid!
  const docId = req.params.docId!
  const guard = await requireDocRole(res, uid, docId, 'admin')
  if (!guard) return
  const deleted = await docMetaRepo.softDelete(docId)
  // Broadcast the epoch invalidation so connected writers recheck and get cut
  // off (status===0 -> resolveRole 'none'). Doc-wide (no uid): everyone loses
  // access on delete. Mirrors acceptInvite's refreshAndPublish call.
  if (deleted) {
    await refreshAndPublish(deleted.documentName, deleted.permissionEpoch)
  }
  res.status(200).json({ docId, status: 'deleted' })
})
