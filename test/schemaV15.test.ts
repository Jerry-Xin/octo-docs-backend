import { describe, it, expect } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { buildSchema, SCHEMA_VERSION } from '../src/schema/index.js'
import {
  prosemirrorJSONToYDocState,
  yDocStateToProsemirrorJSON,
} from '../src/agent/conversion.js'

// The full @octo/docs-schema v15 node/mark set the backend MUST mirror (same
// names). Kept literal here so a drift between the front-end registry and the
// server schema fails loudly rather than silently dropping content on the
// Y.Doc <-> ProseMirror conversion path that version-restore depends on.
const SCHEMA_NODES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'emoji',
  'mention',
  'details',
  'detailsSummary',
  'detailsContent',
  'callout',
  'inlineMath',
  'blockMath',
  'fileAttachment',
  'bookmark',
] as const

const SCHEMA_MARKS = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'highlight',
  'textStyle',
  'underline',
  'superscript',
  'subscript',
] as const

describe('Schema v15 co-land (full @octo/docs-schema parity)', () => {
  it('reports SCHEMA_VERSION === 15', () => {
    expect(SCHEMA_VERSION).toBe(15)
  })

  it('defines every front-end SCHEMA_NODES name', () => {
    const nodes = buildSchema().nodes
    for (const name of SCHEMA_NODES) {
      expect(nodes, `missing node: ${name}`).toHaveProperty(name)
    }
  })

  it('defines every front-end SCHEMA_MARKS name', () => {
    const marks = buildSchema().marks
    for (const name of SCHEMA_MARKS) {
      expect(marks, `missing mark: ${name}`).toHaveProperty(name)
    }
  })

  it('carries the textStyle mark with BOTH the v3 color and v7 fontSize attrs', () => {
    const ts = buildSchema().marks.textStyle
    const m = ts.create({ color: '#abc', fontSize: '18px' })
    expect(m.attrs).toEqual({ color: '#abc', fontSize: '18px' })
  })

  // The real proof: a front-end-authored v15 document containing the custom
  // nodes must round-trip through prosemirrorJSONToYDocState -> Y.Doc binary ->
  // yDocStateToProsemirrorJSON with NO attr loss. This is exactly the path
  // src/collab/versionRestore.ts (decodeTargetSnapshot) and src/agent/conversion.ts
  // exercise, so a dropped attr here is a restore-time data-loss bug.
  it('round-trips fileAttachment/bookmark/callout/mention/emoji/math through the Y.Doc', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { variant: 'warn' },
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'hi ' },
                { type: 'mention', attrs: { id: 'u1', label: 'Alice', type: 'user' } },
                { type: 'text', text: ' look at ' },
                { type: 'mention', attrs: { id: 'doc42', label: 'Spec', type: 'doc' } },
                { type: 'text', text: ' ' },
                { type: 'emoji', attrs: { name: 'rocket' } },
                { type: 'text', text: ' ' },
                { type: 'inlineMath', attrs: { latex: 'a^2 + b^2 = c^2' } },
              ],
            },
          ],
        },
        { type: 'blockMath', attrs: { latex: '\\int_0^1 x\\,dx' } },
        {
          type: 'fileAttachment',
          attrs: {
            attachId: 'att_123',
            fileName: 'quarterly report.pdf',
            mime: 'application/pdf',
            sizeBytes: 20480,
          },
        },
        {
          type: 'bookmark',
          attrs: {
            url: 'https://example.com/article',
            title: 'An Example Article',
            description: 'A representative description.',
            image: 'https://cdn.example.com/og.png',
            siteName: 'Example',
            fetchedAt: '2026-06-23T00:00:00.000Z',
          },
        },
      ],
    }

    // fromJSON + check() is the version-restore decode contract (it THROWS on
    // unknown node/mark types or content-expression violations).
    const schema = buildSchema()
    const node = PMNode.fromJSON(schema, doc as Parameters<typeof PMNode.fromJSON>[1])
    expect(() => node.check()).not.toThrow()

    const state = prosemirrorJSONToYDocState(doc)
    expect(state).toBeInstanceOf(Uint8Array)
    const back = yDocStateToProsemirrorJSON(state)
    expect(back).toEqual(doc)
  })

  it('round-trips the v6/v8 marks and v7 textStyle.fontSize without loss', () => {
    // y-prosemirror emits an explicit (possibly empty) `attrs` object for every
    // mark on the way back, so the expected shape carries `attrs: {}` for the
    // attr-less marks — fromJSON tolerates it, so version-restore is unaffected.
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'styled',
              // Ordered by schema mark rank so the round-trip is order-stable.
              marks: [
                { type: 'textStyle', attrs: { color: 'rgb(1, 2, 3)', fontSize: '14px' } },
                { type: 'underline', attrs: {} },
                { type: 'superscript', attrs: {} },
              ],
            },
            { type: 'text', text: 'down', marks: [{ type: 'subscript', attrs: {} }] },
          ],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
  })

  it('round-trips a link mark preserving its href (and default target/rel/class)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'link',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com/',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    class: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mark = (back as any).content[0].content[0].marks[0]
    expect(mark.attrs.href).toBe('https://example.com/')
  })

  it('round-trips list / taskList / blockquote / codeBlock structures', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quote' }] }],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
        { type: 'horizontalRule' },
      ],
    }
    const back = yDocStateToProsemirrorJSON(prosemirrorJSONToYDocState(doc))
    expect(back).toEqual(doc)
  })
})
