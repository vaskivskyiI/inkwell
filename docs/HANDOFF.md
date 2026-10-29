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
- Tests: `npm test` 37/37 (incl. AFFiNE snapshot and Markdown-zip import) (unit, API, real-WebSocket collaboration, AI with mock provider, fake Halcyon MCP).
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
  `{id,t,c,w,p:[x,y,pressure…]}` (logical width 1000), `boxes` (journal text boxes), `meta` (paper, height).
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
