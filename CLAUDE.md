# CLAUDE.md — guide for AI coding sessions on Inkwell

Read this first, then `docs/HANDOFF.md` (state, decisions, gaps) and `docs/PLAN.md` (features, architecture, roadmap).

## What this is
Inkwell: self-hostable, AI-native notes app (OneNote / Journal / AFFiNE / Notion). Rich text + handwriting, live
co-editing (Yjs), multi-user with shared spaces, AI in the background, Halcyon integration (mail/calendar/tasks via
Halcyon's MCP endpoint). Browser first; native Windows/Android apps later use the same REST + Yjs protocol.

## Layout
- `server/` Node ≥22, ESM, plain JavaScript, no build. Fastify 5, Hocuspocus 4 (Yjs), pg / PGlite, resvg, perfect-freehand.
  - `src/index.js` bootstrap (`buildServer()`), WebSockets `/api/collab` (page docs) and `/api/ws` (events), static UI
  - `src/config.js` all env vars · `src/db/schema.js` migrations (append, never edit shipped ones) · `src/db/index.js` q/one/many/tx
  - `src/collab.js` Hocuspocus: auth per page, load/store, `persist()` derives text/search/versions and schedules AI; `withDoc()` for server-side edits
  - `src/docmodel.js` Y.Doc ↔ Markdown/text, Markdown → editor JSON · `src/html.js` export/public HTML · `src/ink/` stroke geometry + SVG/PNG render
  - `src/notes.js` tree/trash/journal/templates/versions/export · `src/spaces.js` roles · `src/auth.js` sessions + API tokens · `src/assets.js`
  - `src/ai/` providers, router (per task: chat / vision / embed; local-only spaces), queue (SKIP LOCKED), tasks (analyze, ink, image, embed), assistant, prompts
  - `src/importers/` AFFiNE snapshot zip + Markdown/Notion/Obsidian import (`POST /api/import`)
  - `src/search.js` FTS + embeddings (RRF) · `src/links.js` page links + reverse lookup · `src/integrations/halcyon.js` MCP client
- `web/` React 19 + Vite, TipTap 3, no UI library. `src/store.js` tiny global store + hash routing; `src/data.js` loading, events socket, `openDoc()` (Hocuspocus + IndexedDB)
  - `src/editor/` TipTap setup, custom nodes (inkBlock, callout, pageMention), slash menu, selection AI · `src/ink/` InkCanvas, toolbar, JournalView
- `deploy/` podman pod script, nginx · `Dockerfile` · `docker-compose.yml`

## Commands
```bash
npm install && npm run build && npm start      # :8080 (on this Windows box 8080 is reserved — use INKWELL_PORT=8090)
npm test                                      # 55 tests, in-memory PGlite, mock AI, real WebSockets
npm run test:pg -w server                     # API + AI tests via the pg driver
./deploy/podman-pod.sh up [--with-ollama]
```

## Conventions
- Match surrounding style: 2-space indent, single quotes, semicolons, compact functions, sparse comments that explain *why*.
- SQL through `q/one/many/tx` with `$n` params; timestamps are epoch-ms `bigint`; JSON columns end with `_json` (pass `JSON.stringify(x)` with `::jsonb`).
- Every user-scoped read/write checks access: `needSpace(userId, spaceId, minRole)` / `needNote(userId, noteId, minRole)`; lists filter by `userSpaceIds()`.
- Page content lives only in the Y.Doc. Change it server-side with `withDoc(noteId, fn, user)` — never by writing `notes.ydoc` for a page that may be open.
- Background AI: `enqueue(userId, type, ref, { delay, priority })` + `registerHandler`; handlers must be idempotent and return `{ retryIn }` when no provider is configured.
- Push changes to clients with `publish(spaceId, type, payload)` / `notifyUser(userId, …)`; NOTIFY payloads must stay < 8 kB.
- Streaming AI: `streamNdjson` (server) / `stream()` (web `api.js`).
- Secrets with `encrypt()`; never return them from the API.
- Keep `server/src/ink/geometry.js` and `web/src/ink/geometry.js` in step (server renders what the screen shows).
- TipTap `configure()` deep-merges plain objects: pass functions, not ref objects, as extension options.
- After changing the web UI run `npm run build`; after changing behaviour add/extend tests in `server/test/`.
