# Inkwell — project handoff

Status as of 2026-10-29 (v0.1.0). Lets a new developer or AI session continue without the original conversation.

## 1. Requirements (product owner)
> A note taking app between OneNote, Microsoft Journals, AFFiNE and Notion with extensive AI features. Handwritten notes
> are important and analysed by AI, but typed rich-text notes with images etc. must be equally convenient. Notes sync
> between devices and can be edited on several devices at once. Native Windows and Android apps later; for now server +
> browser, run in podman. Light, fast, convenient but functional UI. Scalable multi-user, several spaces per user (work,
> private), spaces shared between users. Integrate with Halcyon: associate notes with calendar events, tasks, e-mails.

Decisions: PostgreSQL (+pgvector) for scale, with embedded PGlite for dev/tests; Yjs/Hocuspocus for co-editing and
offline; TipTap for rich text; own ink engine (perfect-freehand) storing strokes as CRDT data; Halcyon via its existing
MCP endpoint (no Halcyon changes needed for the Inkwell → Halcyon direction).

## 2. State
- 3 commits. Server + web UI implement everything in docs/PLAN.md §2 except the roadmap items.
- Tests: `npm test` 57/57 (incl. AFFiNE snapshot and Markdown-zip import) (unit, API, real-WebSocket collaboration, AI with mock provider, fake Halcyon MCP).
  `npm run test:pg -w server`: API 12/12 + AI 7/7 through the production `pg` driver (PGlite wire server).
- UI checked in the desktop app's browser: sign-up, home, editor (collab load, slash menu, ink block, drawing),
  background handwriting recognition shown under the ink, AI panel (summary, tags, action items, handwriting),
  journal page, Ctrl+K search finding handwriting, live co-editing between two tabs (remote caret + presence),
  selection AI → Replace, dark mode, phone width.

## 3. Not verified yet — do these first
1. **Real PostgreSQL** (pgvector/pgvector:pg17 in the pod): run all tests with `INKWELL_DATABASE_URL` set
   (collab.test.js could not run on the PGlite wire emulator — it interleaves concurrent connections).
2. **podman-pod.sh / Dockerfile** were written on Windows without podman: build and `up` on the Ubuntu server.
   `@resvg/resvg-js` must find its linux-x64-gnu prebuilt in the image.
3. **Real AI models**: handwriting prompt with a real vision model (qwen2.5vl:7b on Ollama, GPT-4.1, Claude, Gemini) —
   check transcription quality on real handwriting, JSON reliability of small local models, and image size limits.
4. **Real AFFiNE export**: the importer follows AFFiNE's snapshot zip format (`<title>-<id>.snapshot.json` + `assets/`) but was only tested with synthetic files — import a real workspace export and compare.
5. **Real Halcyon**: connect with an `hmcp_` token (propose access), check event/mail/task searches and deep links
   (`#/mail/unified/<id>`, `#/calendar`, `#/tasks`).
6. Real pens: Surface Pen / Wacom / iPad Pencil / S-Pen — pressure, eraser button (`buttons & 32`), palm rejection
   ("pen only" after the first pen event), touch scrolling inside ink areas.
7. Several app instances behind a load balancer with `INKWELL_REDIS_URL` (needs `@hocuspocus/extension-redis` installed).

## 4. Known gaps / roadmap
1. Comments & @mentions with notifications (role `commenter` exists but can only read today).
2. Halcyon side: show "Notes" on events/e-mails/tasks via `GET /api/links/lookup?kind=event&ref=…` (Inkwell API token).
3. Native Windows (pen-first) and Android apps: REST + Yjs sync (yrs/y-crdt bindings); `POST /api/auth/login {token:true}`.
4. Audio recording + transcription; PDF import & annotation; whiteboard/edgeless canvas; shape recognition.
5. Database/table views; OIDC/SSO; S3 asset storage and quotas; E2E-encrypted spaces.
6. Space membership changes do not yet close already-open page sockets of a removed member (they lose access on reconnect).
7. Commenter role: currently read-only like viewer.
8. Embedding model per user: semantic search only compares vectors of the searcher's embedding model.

## 5. Architecture essentials
- Page = Y.Doc `note:<id>`: `title` Y.Text, `default` XmlFragment (TipTap), `ink` Y.Map canvasId → Y.Array of strokes
  `{id,t,c,w,p:[x,y,pressure…]}` (logical width 1000), `boxes` (journal text boxes), `images` (pictures on canvases: id → Y.Map {canvas,src,x,y,w,ratio,rot,crop}, drawn under the ink; `web/src/ink/CanvasImages.jsx`), `meta` (paper, height).
  Journal pages use canvas id `page`; inline ink blocks use their node's `id`.
- Store (`collab.persist`, debounced 2–10 s): title/text/tags/search vector, page-mention backlinks, version snapshot
  (≥10 min apart), then — only if the content hash changed — jobs `analyze`, `embed` and `ink` (per canvas whose
  stroke ids changed). The ink job renders PNG (resvg), asks the vision model, stores `ink_recognitions`, re-persists so
  the transcription flows into search/AI.
- Jobs: unique per (type, ref) while queued; bursts push the start back (`INKWELL_AI_DELAY`, default 45 s).
- Events: `/api/ws` (tree, AI results, membership) — in-process + Postgres NOTIFY across instances.
- Auth: cookie sessions (browser) and `ink_` API tokens (Bearer or `?token=` on WebSockets). Cookie WebSockets
  require same Origin.

## 6. Gotchas found during development
- Fastify encapsulation: hooks added inside a plugin only apply to it — the auth preHandler is registered at the root.
- Timers inherit AsyncLocalStorage: a job wake-up scheduled inside `tx()` used the closed transaction → `outsideTx()`.
- TipTap `configure()` deep-merges plain objects (copied a React ref) → pass functions as options.
- `@fastify/static` 10 passes the reply (not the raw response) to `setHeaders`.
- Windows: port 8080 is reserved (EACCES) — dev preview uses 8090. Node 26 was installed by winget.
- Hocuspocus 4 takes a Fetch `Request`; bridge from `@fastify/websocket` in `collab.handleSocket`.
- Markdown parsers must always make progress (a `| foo` or `- [ ] ` line used to loop forever).
- Halcyon behind a private CA: Settings → Integrations takes its CA (PEM, pasted or from a .pem/.crt/.cer file) or "do not check", kept in `integrations.settings_json.tls`; MCP calls then use `node:https` with that CA added to Node's roots (`integrations/halcyon.js` postJson). Test certificates: `server/test/fixtures/tls`.

### 2026-10-30: spaces, categories, look
- "All spaces" (`store.spaceId === 'all'`): tree per space, Home and search across all; new pages go to the first writable space.
- Halcyon spaces: `spaces.settings_json.halcyonSpace` (null/absent = same name, '' = none, else the label). Needs Halcyon's MCP
  `list_spaces`, the `space` argument and the `space` field on items (Halcyon 5e76125 or later); older Halcyon simply shows everything.
- Event notes are per occurrence: same ref + same local day = same note; `lookup` rows carry `date`. New notes of a meeting stay
  in the space of earlier ones and carry over open to-dos ("From last time").
- `GET /api/smart`: Meetings / Tasks / E-mails / Handwritten, derived from `note_links`; a sub-category needs 2+ notes.
- Pen layer anchors are text-based (`web/src/ink/anchor.js`); strokes from before that stay fixed. Changing page width reflows text, not ink.

### 2026-10-30: blocks, chapters, comments, audio, PDF, review, PWA
- Editor: `BlockTools.jsx` (block handle, right-click menu, table bar); chapters fold per device via decorations (`HeadingFold`); `pageMention.anchor` links a chapter (`#/n/<id>?h=<heading>`); a pen hovering an image turns it into an inkBlock with `bg` and `width` (%).
- Task sync (`tasksync.js`): to-do text = task link title. Page → Halcyon: job after save, `complete_task`. Halcyon → page: poll every 5 min. Repeating tasks stay open there, so a tick is sent once, `seenDue` tracks the date, and a moved date ticks the to-do only when `list_tasks` says `repeats`.
- Comments (`comments.js`, migration 2) with @mentions and notifications; commenters can post.
- Recordings: `audioBlock`, job `transcribe`, AI task `audio` (OpenAI/OpenAI-compatible Whisper, Gemini; not Ollama, not Anthropic). PDFs: pages rendered in the browser to pictures on inkBlocks, text saved via `PUT /api/assets/:id/text`, limit 150 pages.
- Review: `POST /api/ai/review`. PWA: `web/public` (manifest, `sw.js`: shell only, never `/api`); needs https.
- Not tried on real hardware or services: pen hover, recording on a phone, real Whisper/Gemini transcription, real Halcyon task sync, PWA install on a phone.

### 2026-10-30: file lifecycle
- `asset_refs` (migration 3) lists which pages use which file, kept up to date by `persist`/`createNote`; old pages are backfilled once by `collectAssets`.
- Same bytes in a space reuse one `assets` row; across spaces rows differ but the file on disk is shared by sha256.
- `collectAssets` (every 6 h): a file without references is marked and removed after `INKWELL_ASSET_GRACE_DAYS` (default 7). Trashed pages still count; version snapshots do not, so restoring an old version can show a missing file after that time.
- Reading a file: member of its space, or of a space with a page that uses it.

## Several Halcyon connections
- A Halcyon token reads one mailbox (own or one shared space), so `integrations` holds one row per connection; the oldest is the main one.
- Items carry `meta.conn`. Links without it, or with another member's id, go through `tryEach`, which tries each connection in turn.
- `scopesFor(userId, spaceId)` decides which mailboxes an Inkwell space shows: the connection chosen in the space, else one with the space's name, else all; among several, those with a matching Halcyon space win.
- Gaps: a deep link for an event or task from Halcyon has no connection, so its note goes by `hspace`; "Open in Halcyon" does not switch Halcyon to the shared space.
