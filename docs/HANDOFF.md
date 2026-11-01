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

## Sign in with Halcyon and mirrored shared spaces
- `sso.js`: INKWELL_HALCYON_URL + INKWELL_HALCYON_SECRET (Halcyon: HALCYON_SSO_SECRET, HALCYON_SSO_REDIRECTS = `<public url>/api/auth/halcyon/callback`). `users.halcyon_sub` links a login. An account with the same e-mail is never taken over: it links itself under Settings → Profile. Passwords keep working.
- `mirror.js` (every 5 min and after a Halcyon sign-in): each Halcyon shared space gets one space (`settings.halcyonShared`), members follow Halcyon for linked users only. Hand-added people, the owner and all pages stay; an existing space with pages is not adopted; only an empty default twin is removed.

### 2026-11-01: suite trust — set up once, not per user
- Inkwell → Halcyon: with INKWELL_HALCYON_URL + INKWELL_HALCYON_SECRET set and a user signed in with Halcyon, `connections()` adds virtual "suite" connections before any pasted ones: `suite` (own mailbox) and `suite:<halcyonShared>` per mirrored space the user is in. `call()` sends `Authorization: Bearer <secret>`, `X-Halcyon-Sub: <halcyon_sub>`, `X-Halcyon-Target: <sub or shared id>` (TLS CA from INKWELL_HALCYON_CA); Halcyon answers as a "propose" grant or 401 (not a member / revoked). Pasted `hmcp_` connections stay, under "Other Halcyon server" in Settings → Integrations.
- Links store `meta.conn` = the connection's `key`: `suite:<id>` for a shared mailbox (same for every member, so task sync and mail reading work for all), `suite@<sub>` for someone's own mailbox (another member does not mistake it for theirs; it is tried on each of theirs as before). `byConn()` matches id or key. A mirrored space uses `suite:<id>` automatically in `scopesFor`/`spaceForConnection`; `halcyonConnection` may hold `suite` / `suite:<id>`. `pullAll` includes users with `halcyon_sub`.
- Halcyon → Inkwell: `GET /api/links/lookup` and `GET /api/recent` (only these, only GET) accept `Bearer <secret>` + `X-Halcyon-Sub` as the user with that `halcyon_sub` (`auth.js` `suiteUser`, constant-time compare); unknown sub → 401. Per-user API tokens still work there.
- Space AI: an owner sets `spaces.settings_json.ai` = { chat, vision, embed: null | { providerId, model } } (PATCH `/api/spaces/:id`, providers the setter may use: server-wide or their own). `resolve()` uses it for any member's work on the space's pages (local-only still applies), else the person's own routing; `spaceProviders()` = server-wide + the space's owners' own. `GET /api/spaces/:id/ai` shows the choice with provider names (members see it read-only in Settings → Spaces). Gap: search across all spaces embeds the query with the person's own model, so pages embedded with a space's other model only match in a search within that space.

## 2026-11-01: OneNote import, large files, several pages at once, Markdown, calendar
- OneNote (`importers/onenote.js`): `.one`, `.onepkg` or a zipped notebook folder, converted by `tools/onenote` (Rust, onenote_parser) built to the checked-in `onenote-export.wasm` and run under WASI in a worker. Handwritten pages become journals, typed pages ordinary pages. `tools/onenote/src/main.rs` was touched after the last `.wasm` build and no Rust toolchain was on this machine: rebuild it once (`tools/onenote/README.md`) and rerun `npm test`. The converter reads a whole section into WebAssembly memory (4 GB limit).
- Uploads and imports have no size limit by default (`INKWELL_MAX_UPLOAD_MB` / `INKWELL_MAX_IMPORT_MB`, 0 = none). Both stream to `<data>/assets/tmp` while hashing; zips are read entry by entry from disk (`util/zip.js`, zip64 included), entries over 32 MB are extracted as streams, `.affine` attachments are read one at a time from SQLite. nginx: `client_max_body_size 0` and `proxy_request_buffering off`.
- Files over 512 kB (and every import) go up in pieces so a proxy's per-request cap cannot block them: `POST /api/uploads` → `{id}`, `PUT /api/uploads/:id?offset=n` with raw `application/octet-stream` pieces (409 `{size}` for a wrong offset, `GET /api/uploads/:id` → `{size}` to resume), then `POST /api/assets` or `POST /api/import` with JSON `{ uploadId, name, … }` instead of multipart. The browser (`sendFile` in `web/src/api.js`) starts with 8 MB pieces, halves a piece a proxy refuses with 413 (down to 256 kB, remembered for the session) and retries failed pieces with backoff. Unfinished uploads live in memory (lost on restart) and expire after a day; their temp files are swept with the other unused files.
- Sidebar: Ctrl/⌘-click picks pages, Shift-click a range, "Select" in a page's menu starts picking on touch screens; while some are picked a click toggles, Esc clears. The bar moves them to the top level of any writable space or to the trash (one Undo); dragging a picked page drags all of them. Sub-pages of a picked page are not moved separately (`topLevel` in `data.js`). Trash: checkboxes to restore or delete several.
- Markdown source mode (button in the page header): `GET/PUT /api/notes/:id/markdown`. Handwriting, recordings and unknown blocks become `<!-- keep:N … -->` lines whose JSON travels with the text; callouts are `> [!💡]` (GitHub's `> [!NOTE]` etc. work too, also in imports); `[[Title]]` and `[[Title#Heading]]` become page links. A hash of the loaded Markdown detects a co-editor's change (409, then the user may overwrite). Lost: colours, underline, image sizes.
- Calendar (`#/calendar/<yyyy-mm-dd>`, `Calendar.jsx`): `note_edits` (migration 6) records each half hour a page was saved in, per person, filled from versions for older pages. `GET /api/calendar?from&to[&space][&mine=1]` returns pages created or edited in the range; the browser groups them by its local day. "Today's journal" now sends the device's date instead of the server's UTC date.
- Halcyon tasks "refused to save (412 Precondition Failed)": that is Halcyon's CalDAV task push (`halcyon/server/src/calendar/todos.js`), not Inkwell. Another session was changing exactly that code at the same time (create → overwrite on 412). Still open there: an *update* with a stale etag keeps failing with 412 forever, because a dirty task skips the listing that would refresh its etag — on 412, fetch the current etag (or PUT without If-Match) and retry.

### 2026-11-01: phone layout, quick actions, photos between devices
- Phone width: the note view's grid column was `1fr` (= at least its content), so the header's ten buttons made the page wider than the screen with no way to scroll. Now `minmax(0, 1fr)`; below 700 px only camera, pen-on-page, AI and the menu stay in the header, the rest move into the ⋯ menu (`useNarrow`). Tables scroll inside their own box on phones.
- Quick actions (`QuickActions.jsx`): a round button bottom right on touch screens and narrow windows — photo to the page being worked on elsewhere, photo into this page, photo as a new page, new page, today's journal, search.
- Photos between devices (`server/src/capture.js`, `web/src/capture.js`, migration 7): an open writable page reports itself as the user's active page (`POST /api/me/active`, on focus and every 5 min); `GET /api/capture/target` offers it for 2 h. The camera button on a desktop can ask the phone (`capture:request` → a sheet with "Take photo" on touch devices). An uploaded photo becomes a `drops` row and a `note:drop` event; the tab showing the page claims it (`POST /api/drops/:id/claim`, first wins, the sending tab at once, a tab in front after 100 ms, others after 800 ms) and puts it after the cursor's block (typed page) or in the middle of the screen (journal). Unclaimed after 2.5 s the server adds it at the end of the page or below everything on the paper.
- Not tried on real phones yet: camera via `capture="environment"`, iOS Safari's file input cancel event, photos of 10+ MB.

### 2026-11-01: one space to start with; deleting spaces
- A new account (sign-up, admin-created, Halcyon sign-in) gets one space, "My space", with the welcome page. Existing accounts keep their spaces. The test helper `signup()` renames it to "Private" and adds "Work", so older tests read the same.
- `DELETE /api/spaces/:id?moveTo=<space>` moves all its pages first (sub-pages, trash, files; clashing journal dates become ordinary pages; top-level pages go after the target's). Without `moveTo` the pages go with the space. The last space a person owns cannot be deleted.
- UI: space menu → "Delete “…”…" (owners) opens Settings → Spaces at the danger zone, which asks where the pages go (default: the next writable space).
