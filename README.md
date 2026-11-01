# Inkwell

Self-hostable, AI-native notes — between OneNote, Microsoft Journal, AFFiNE and Notion.

- **Typed and handwritten notes together**: rich-text pages (headings, lists, to-dos, tables, images, code, callouts)
  with handwriting blocks anywhere, plus pen-first **journal** pages on ruled/grid/dotted paper.
- **AI reads your handwriting** in the background: transcription (math as LaTeX), to-dos, dates, drawings — searchable,
  usable by the assistant, convertible to typed text.
- **Extensive AI**: summaries, title/tag suggestions, action items, image text, semantic search, related pages, inline
  writing actions (improve, shorten, translate, explain, table/list, clean up handwritten notes…), and **Ask Inkwell**
  (answers from your notes with cited pages). Ollama, OpenAI, OpenAI-compatible, Anthropic, Gemini; spaces can be
  restricted to local AI.
- **Mixed notes**: a pen layer over any typed page, drawing blocks anywhere, photos (camera on phones) to draw on and
  annotate; pinch / Ctrl+wheel zoom, whole-stroke or partial eraser, shape correction (lines, rectangles, circles…).
- **Tags** (manual, #hashtags and AI suggestions), **connections** under every page (links, backlinks, related pages
  found by AI, unlinked mentions), cross-links, sub-pages and sub-journals in any combination.
- **Live co-editing on every device** (Yjs CRDT): cursors, presence, offline editing that merges on reconnect; comments with @mentions; installable as an app (PWA).
- **Recordings** with transcripts and AI minutes, **PDFs** to read and annotate by pen, weekly **review** by AI, foldable chapters, links to chapters, block menus, table tools.
- **Spaces** (one, "My space", to start; more for work, teams, projects) shared with roles, shown one at a time or all together, matched to Halcyon spaces
  by name or by choice; smart categories (meetings, recurring meetings, tasks, e-mails, handwritten); nested pages, favourites, daily journal, templates,
  version history, trash, public read-only links, Markdown/HTML export.
- **Import** from AFFiNE (Snapshot export: structure, links, sub-pages, images, pen strokes) and from Markdown,
  Notion or Obsidian zips — Settings → Import.
- **Halcyon integration**: one-click switch between Notes, Mail, Calendar and Tasks; Today on Home (meetings, open
  tasks, e-mails waiting for you) with a note for each; deep link `#/new?kind=event|email|task&ref=…` creates or opens
  the note for any item; link pages to e-mails, calendar events, tasks and people; meeting notes from today's
  events; action items → Halcyon tasks, with to-dos and tasks ticking each other.

Plan, architecture and roadmap: [docs/PLAN.md](docs/PLAN.md) · project state for the next developer: [docs/HANDOFF.md](docs/HANDOFF.md).

## Run with podman

```bash
./deploy/podman-pod.sh up                       # PostgreSQL + pgvector + Inkwell on 127.0.0.1:8080
./deploy/podman-pod.sh up --with-ollama --gpu   # … plus local AI (pulls a chat, a vision and an embedding model)
./deploy/podman-pod.sh update                   # git pull, rebuild, recreate (data kept)
./deploy/podman-pod.sh backup                   # pg_dump + assets + env into ./backups/
./deploy/test-on-postgres.sh                   # run the test suite against the pod's PostgreSQL (throwaway database)
```

Open the address and create the first account (it becomes the administrator). Put nginx/Caddy with TLS in front
([deploy/nginx.conf](deploy/nginx.conf)) and set `INKWELL_PUBLIC_URL` and `INKWELL_SECURE_COOKIES=1` in
`deploy/inkwell.env`. `docker-compose.yml` is an alternative for podman-compose.

## Develop

```bash
npm install
npm run build            # web UI → web/dist (served by the server)
npm start                # server on :8080, embedded Postgres (PGlite) in ./data when no INKWELL_DATABASE_URL
npm run dev              # server --watch + Vite on :5173 (proxies /api incl. WebSockets)
npm test                 # unit, API, real-WebSocket collaboration and AI tests (in-memory database, mock AI)
npm run test:pg -w server   # API + AI tests through the production `pg` driver (PGlite wire server)
```

`INKWELL_DEMO=1` offers a built-in mock AI provider for trying the AI features without a model.
