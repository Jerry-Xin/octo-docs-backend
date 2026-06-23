# SCHEMA-SPEC — octo-docs collaboration schema versioning governance

## 目的与锁步原则

- 本文是协同 schema 的 `SCHEMA_VERSION` 发号**权威登记表**，与前端 `@octo/docs-schema`（Tiptap 配置）保持锁步。服务端 schema（`src/schema/index.ts` 的 `buildSchema()`）与前端的 node/mark 集合**必须在同一 version 下定义同一套类型**，否则 Y.Doc ↔ ProseMirror 转换会丢失或损坏内容。`SCHEMA_VERSION` 常量见 `src/schema/index.ts:69`；锁步要求见该文件头注释 `src/schema/index.ts:20-31`。
- **单调递增、不跳号**；砍掉的号**作废留空、不回收**（留作 gap）。落地时按 PM 发号顺序**逐项 bump**；最终 `SCHEMA_VERSION` = **实际合入的最高号**（不是因为 15 被预留就等于 15），见 `src/schema/index.ts:43-46`。
- 后端**不自行发号**：登记的号与前端使用的号完全一致（`src/schema/index.ts:39-41`）。

## 已注册版本历史（已合入，真实代码）

下列为已合入 `buildSchema()` 的累积历史（vN ⊇ v(N-1)，纯增量，不删除既有类型）。

| version | 新增 node / mark | 状态 | 代码引用 |
| --- | --- | --- | --- |
| v1 | 基础 schema：`doc` / `paragraph` / `heading` / `text` 节点 + `bold` / `italic` marks | shipped | `src/schema/index.ts:130-144`、`233-239` |
| v2 | `image` 节点（仅存引用 `attachId` / 受控 `src`，绝不内联 base64） | shipped | `src/schema/index.ts:150-192`；version 缘由 `src/schema/index.ts:24-26` |
| v3 | `highlight` + `textStyle` marks | shipped | `src/schema/index.ts:248-289`；缘由 `src/schema/index.ts:27-28` |
| v4 | 四个表格节点 `table` / `tableRow` / `tableCell` / `tableHeader`（byte-aligned 到 prosemirror-tables / `@tiptap/extension-table` 2.27.2） | shipped | `src/schema/index.ts:200-229`；缘由 `src/schema/index.ts:28-30` |

当前 `SCHEMA_VERSION = 4`（`src/schema/index.ts:69`）。

## PM 冻结发号表（batch 3，reserved）

PM 的单一权威发号表冻结如下。5–13 由前端（Ploy）先行落地，14 / 15 为后端（Boris）拥有的 node-attr 契约。

| 号 | 项 | 新增 schema 类型 | 归属 | 状态 |
| --- | --- | --- | --- | --- |
| 5 | textAlign | mark/attr（前端 Tiptap） | 前端 Ploy | reserved，未落地 |
| 6 | underline | mark | 前端 Ploy | reserved，未落地 |
| 7 | fontSize | mark/attr | 前端 Ploy | reserved，未落地 |
| 8 | superscript + subscript | marks | 前端 Ploy | reserved，未落地 |
| 9 | emoji | node | 前端 Ploy | reserved，未落地 |
| 10 | mention | node | 前端 Ploy | reserved，未落地 |
| 11 | details（`detailsList` / `detailsSummary` / `detailsContent`） | nodes | 前端 Ploy | reserved，未落地 |
| 12 | callout | node | 前端 Ploy | reserved，未落地 |
| 13 | math（KaTeX） | node | 前端 Ploy | reserved，未落地 |
| 14 | **fileAttachment** | **node（后端拥有 attr 契约）** | **后端 Boris** | reserved，未落地 |
| 15 | **bookmark** | **node（后端拥有 attr 契约）** | **后端 Boris** | reserved，未落地 |

发号冻结依据见 `src/schema/index.ts:33-41`。

## 后端拥有的节点契约（14 / 15）

后端定义这两个节点的 attr 契约，前端 Tiptap 节点**必须逐字 byte-align**（属性名 verbatim，**不得发明别名**）。依据 `src/schema/index.ts:48-63`。

### 14 · `fileAttachment` node

- **attrs**：`attachId` (string)、`fileName` (string)、`mime` (string)、`sizeBytes` (number)。
- 该节点**只引用** `doc_attachment` 行，**不内联字节**，与现有 `image` 节点用 `attachId` 引用附件的方式一致（`image` 节点见 `src/schema/index.ts:150-192`）。
- 对应 `doc_attachment` 表列（`migrations/schema.sql:123-134`）：`attach_id` → `attachId`、`mime` → `mime`、`size_bytes` → `sizeBytes`；`file_name` 列于 batch3 新增（`migrations/schema.sql:129`，`VARCHAR(512) NOT NULL DEFAULT ''`，已 sanitize 的原始文件名，用于下载 `Content-Disposition`）→ `fileName`。

### 15 · `bookmark` node

- **attrs**：`url`、`title`、`description`、`image`、`siteName`、`fetchedAt`。
- 该 attr 集合**严格等于** link-card OG 接口的出参：`POST /docs/:docId/link-card` 返回 `{ url, title, description, image, siteName, fetchedAt }`。
- 出参契约（fixed / frontend-locked）见 `src/util/ogFetch.ts:22-30`（`interface OgCard`）与产出处 `src/util/ogFetch.ts:289-297`（`parseOgCard` 返回）；路由处理见 `src/api/routes/linkCard.ts:48-86`。
- 前端 `bookmark` 节点必须沿用以上 6 个字段名作为 attrs，verbatim 对齐，无别名。

## 当前状态与落地协议

- `SCHEMA_VERSION` **当前 = 4**（未 bump，`src/schema/index.ts:69`）。14 / 15 已登记 / reserved，但**暂不 bump**：必须与前端 `fileAttachment` / `bookmark` 节点**原子同落**（前后端在同一时刻都到达对应号），避免一端先 bump 造成的版本错配窗口（`src/schema/index.ts:43-67`）。
- batch3 后端工作（附件 presign 白名单放开 + link-card OG 接口）与 schema **解耦**，已先行实现、**不依赖 bump**：link-card 路由见 `src/api/routes/linkCard.ts`，安全出站抓取见 `src/util/ogFetch.ts`（SSRF 防护见 `src/util/ssrfGuard.ts`）。解耦说明见 `src/schema/index.ts:65-67`。
- **bump 发生时**的同步动作：
  1. `buildSchema()` 累加对应新节点（attr 契约如上）；
  2. `SCHEMA_VERSION++`（按 PM 发号顺序单调递增，5–13 先落、再 14 / 15）；
  3. 本表对应行状态从 `reserved` 改为 `shipped`，并补「已注册版本历史」表；
  4. 前端 `@octo/docs-schema` 同步注册，node / attr **byte 对齐**。
