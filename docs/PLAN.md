# Inkwell — product & architecture plan

Inkwell is a self-hostable, AI-native notes app that sits between OneNote (notebooks, free-form ink), Microsoft Journal
(pen-first pages, handwriting understood by AI), Notion/AFFiNE (nested pages, blocks, slash commands) — with real-time
multi-device co-editing, shared spaces and integration with Halcyon (mail, calendar, tasks).

## 1. Product requirements (from the product owner)
- Note taking app between OneNote, Microsoft Journal, AFFiNE, Notion, with extensive AI features.
- Handwritten notes are first-class and analysed by AI; typed rich-text notes (formatting, images, tables…) are equally convenient.
- Sync between devices; edit the same note on several devices / by several people at once.
- Server + browser first; native Windows and Android apps later (the API and sync protocol must allow that).
- Runs in podman. Scales to many users; several spaces per user (Work, Private…); spaces shared between users.
- Light, fast, convenient but functional UI.
- Integration with Halcyon: associate notes with calendar events, tasks, emails.

## 2. Feature set

### Organisation
- **Spaces**: every user starts with one, *My space*; create/rename/recolour/delete (its pages can move to another space first); share a space with other
  users by e-mail with a role (owner · editor · commenter · viewer). Switch spaces from the sidebar (Ctrl+1…9).
- **Page tree**: pages nest without limit (OneNote notebook → section → page = page → child pages). Drag & drop to
  reorder / re-parent, collapse state remembered per device. Favourites, recent pages, trash with restore (30 days).
- **Two page kinds**: *Page* (rich text with embedded ink/drawing blocks) and *Journal* (pen-first: endless ruled/grid/
  dotted/plain paper, typed text boxes). Both can be mixed in a tree.
- **Daily journal**: "Today" opens (or creates) the day's journal page in the journal space chosen in Settings (else the first own space).
- **Templates**: meeting notes, daily plan, project brief, 1:1, lecture notes; "New meeting note" from a Halcyon event.
- **Tags** (#tag in text and AI-suggested), backlinks (`[[` page mentions), public read-only share link per page.
- **Version history**: snapshots while editing (at most every 10 minutes and on last disconnect), preview and restore.
- **Import / export**: Markdown and HTML export per page; Markdown import.

### Rich text editor (TipTap/ProseMirror)
- Headings, bold/italic/underline/strike/code, highlight & text colour, links, bullet/numbered/task lists, quotes,
  code blocks, dividers, callouts, tables, images (paste / drop / upload, resizable), file attachments.
- Slash menu (`/`) for every block type and AI actions; selection bubble menu; Markdown shortcuts (`# `, `- `, `[] `…).
- Embedded **ink block** anywhere in a page: draw/handwrite inline, resizable height.

### Handwriting / ink
- Pointer Events with pressure, tilt and coalesced events; strokes smoothed with perfect-freehand; pen / highlighter /
  stroke eraser / lasso select & move; colours and widths; palm rejection ("pen only" once a pen is detected; touch pans).
- Strokes are CRDT data (Yjs), so two devices can write on the same page simultaneously.
- Server renders strokes → SVG → PNG (resvg) for thumbnails and for AI.
- **AI handwriting analysis** (vision model, background): transcription (with math as LaTeX), detected to-dos, dates,
  headings, a description of drawings/diagrams. Shown under the ink, searchable, usable by the assistant; "Convert to
  text" inserts the transcription as editable text.

### AI (providers: Ollama, OpenAI, OpenAI-compatible, Anthropic, Gemini; `mock` for tests)
Precomputed in the background (durable job queue) so results are ready when you open a page:
- Summary, suggested title for untitled pages, suggested tags, action items with due dates.
- Handwriting recognition (above) and image understanding (OCR + description of pasted images).
- Embeddings (chunked) for semantic search and "Related pages".
- Suggested Halcyon links (e.g. a page written during a meeting → that event; mentions of a person → their recent mail).
On demand (streamed):
- Inline AI on a selection or the page: continue writing, improve, shorten, expand, fix spelling & grammar, change
  tone, translate, explain, summarise, turn into list/table, extract action items.
- "Ask Inkwell" assistant: chat with RAG over the active space (or all spaces) with cited pages.
- Meeting notes from a Halcyon event; action items → Halcyon tasks.
Per-task routing (chat / vision / embedding model), privacy: a space can be restricted to local providers.

### Search
- Postgres full-text (title + text + handwriting transcription + image text) with prefix matching, plus semantic
  search over embeddings (pgvector), merged by rank. Command palette (Ctrl+K): pages, commands, recent.

### Collaboration & sync
- Each page is a Yjs document synced over WebSocket (Hocuspocus protocol). Live cursors/selections with names and
  colours, presence avatars, offline editing (IndexedDB cache) merged on reconnect.
- Tree/meta changes (create, move, rename, AI results) are pushed over `/api/ws` events.

### Halcyon integration
- The user connects Halcyon in Settings with its URL and an assistant token (`hmcp_…`, Halcyon Settings → Assistants);
  Inkwell talks to Halcyon's MCP endpoint (`POST /api/mcp`): `search_mail`, `get_message`, `list_events`,
  `list_tasks`, `search_contacts`, `create_task`.
- Links panel on every page: link emails, events, tasks (searched in Halcyon), other pages and URLs; open them in Halcyon.
- "New meeting note" lists today's events; action items can be sent to Halcyon tasks.
- Inkwell API for the other direction (Halcyon can show "Notes for this event"): `GET /api/links/lookup?kind=event&ref=…`
  with an Inkwell API token.

### Multi-user & administration
- E-mail + password (scrypt), first user is admin, sign-up switch, sessions (cookie) and API tokens (Bearer) for native
  apps and integrations. Admin: users list, disable user, server-wide AI providers.

## 3. Architecture

```
browser / native app ──HTTPS── Fastify (Node 22+, ESM, plain JS)
   │  REST /api/*               ├─ auth, spaces, notes tree, assets, search, AI, integrations
   │  WS  /api/collab (Yjs)     ├─ Hocuspocus: one Y.Doc per page; load/store in Postgres
   │  WS  /api/ws (events)      ├─ event bus (in-process + Postgres LISTEN/NOTIFY across instances)
   │                            └─ job workers (FOR UPDATE SKIP LOCKED) → AI providers
   └──────────────────────────── PostgreSQL 16 + pgvector   ·   /data/assets (files)
```
- **DB**: PostgreSQL in production (`INKWELL_DATABASE_URL`); embedded PGlite (Postgres in WASM, with pgvector) for
  development and tests when no URL is set — same SQL everywhere.
- **Document model** (Y.Doc per page): `title` (Y.Text), `default` (Y.XmlFragment, the ProseMirror body), `ink`
  (Y.Map: canvasId → Y.Array of strokes), `meta` (Y.Map: paper style…). Server derives plain text / Markdown from the doc
  on store (no editor schema needed server-side), updates `notes.text_content`, search vectors and enqueues AI jobs
  only when the content hash changed.
- **Scaling out**: app containers are stateless except for open Y.Docs; with several instances set `INKWELL_REDIS_URL`
  (Hocuspocus Redis extension) so co-editors on different instances meet; events use Postgres NOTIFY; jobs are claimed
  with SKIP LOCKED so any number of workers can run. Assets on a shared volume (S3 adapter on the roadmap).
- **Native apps**: everything is REST + standard Yjs sync; Windows (WinUI/Electron) and Android (Kotlin, `y-crdt`/yrs
  bindings) speak the same protocol; API tokens via `POST /api/auth/login {token:true}`.

### Data model (main tables)
users · sessions · api_tokens · spaces · space_members · notes (tree, kind, title, text, tsvector, ydoc bytea, journal
date, public slug, trash) · note_versions · favorites · assets · note_links · ai_providers · user_settings · jobs ·
ai_insights · ink_recognitions · embeddings (pgvector) · integrations.

## 4. Roadmap (after v0.1)
1. Comments & mentions with notifications. 2. Native Windows app (pen-first) and Android app (S-Pen). 3. Audio
recording with transcription synced to notes (OneNote style). 4. Whiteboard/edgeless canvas (AFFiNE style) with
shapes and connectors; shape recognition (ink → shapes). 5. Database/table views (Notion style). 6. OIDC/SSO.
7. S3 asset storage, per-space quotas. 8. Halcyon-side UI: notes panel on events/mail/tasks. 9. PDF import & annotate.
10. End-to-end encrypted spaces.
