// Migrations run in order once; append new entries, never edit shipped ones.
const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    password_hash text NOT NULL,
    color text NOT NULL DEFAULT '#6366f1',
    is_admin boolean NOT NULL DEFAULT false,
    disabled boolean NOT NULL DEFAULT false,
    created_at bigint NOT NULL
  );

  -- Browser sessions (cookie) and API tokens (Bearer, for native apps and integrations) share one table.
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'web',
    name text NOT NULL DEFAULT '',
    user_agent text NOT NULL DEFAULT '',
    created_at bigint NOT NULL,
    expires_at bigint,
    last_used_at bigint
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE spaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    icon text NOT NULL DEFAULT '',
    color text NOT NULL DEFAULT '#6366f1',
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    settings_json jsonb NOT NULL DEFAULT '{}',
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  );

  CREATE TABLE space_members (
    space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
    position int NOT NULL DEFAULT 0,
    added_at bigint NOT NULL,
    PRIMARY KEY (space_id, user_id)
  );
  CREATE INDEX space_members_user ON space_members(user_id);

  CREATE TABLE notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    parent_id uuid REFERENCES notes(id) ON DELETE CASCADE,
    position double precision NOT NULL DEFAULT 0,
    kind text NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'journal')),
    title text NOT NULL DEFAULT '',
    icon text NOT NULL DEFAULT '',
    text_content text NOT NULL DEFAULT '',
    tags text[] NOT NULL DEFAULT '{}',
    journal_date text,
    ydoc bytea,
    content_hash text NOT NULL DEFAULT '',
    search tsvector,
    public_slug text UNIQUE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
  );
  CREATE INDEX notes_tree ON notes(space_id, parent_id, position) WHERE deleted_at IS NULL;
  CREATE INDEX notes_updated ON notes(space_id, updated_at DESC) WHERE deleted_at IS NULL;
  CREATE INDEX notes_search ON notes USING gin(search);
  CREATE INDEX notes_tags ON notes USING gin(tags);
  CREATE UNIQUE INDEX notes_journal ON notes(space_id, journal_date) WHERE journal_date IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE note_versions (
    id bigserial PRIMARY KEY,
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT '',
    ydoc bytea NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at bigint NOT NULL
  );
  CREATE INDEX note_versions_note ON note_versions(note_id, created_at DESC);

  CREATE TABLE favorites (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    created_at bigint NOT NULL,
    PRIMARY KEY (user_id, note_id)
  );

  CREATE TABLE assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    name text NOT NULL DEFAULT '',
    mime text NOT NULL,
    size bigint NOT NULL,
    sha256 text NOT NULL,
    ai_text text,
    created_at bigint NOT NULL
  );
  CREATE INDEX assets_note ON assets(note_id);

  -- Links from a page to other pages, Halcyon mail/events/tasks/contacts, or URLs.
  CREATE TABLE note_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind text NOT NULL,
    ref text NOT NULL,
    title text NOT NULL DEFAULT '',
    meta_json jsonb NOT NULL DEFAULT '{}',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at bigint NOT NULL,
    UNIQUE (note_id, kind, ref)
  );
  CREATE INDEX note_links_ref ON note_links(kind, ref);

  -- AI providers: user_id NULL = server-wide (admin), otherwise private to the user.
  CREATE TABLE ai_providers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    type text NOT NULL,
    base_url text NOT NULL DEFAULT '',
    api_key_enc text NOT NULL DEFAULT '',
    created_at bigint NOT NULL
  );

  CREATE TABLE user_settings (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json jsonb NOT NULL DEFAULT '{}'
  );

  CREATE TABLE server_settings (key text PRIMARY KEY, value_json jsonb NOT NULL);

  -- Durable job queue; workers claim with FOR UPDATE SKIP LOCKED, so any number of instances can work it.
  CREATE TABLE jobs (
    id bigserial PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL,
    ref text NOT NULL,
    priority int NOT NULL DEFAULT 5,
    status text NOT NULL DEFAULT 'queued',
    attempts int NOT NULL DEFAULT 0,
    run_after bigint NOT NULL,
    error text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  );
  CREATE UNIQUE INDEX jobs_pending ON jobs(type, ref) WHERE status = 'queued';
  CREATE INDEX jobs_claim ON jobs(status, run_after, priority);

  CREATE TABLE ai_insights (
    note_id uuid PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    summary text NOT NULL DEFAULT '',
    title text NOT NULL DEFAULT '',
    tags_json jsonb NOT NULL DEFAULT '[]',
    actions_json jsonb NOT NULL DEFAULT '[]',
    content_hash text NOT NULL DEFAULT '',
    error text,
    updated_at bigint NOT NULL
  );

  -- What AI read in a page's handwriting (one row per ink canvas).
  CREATE TABLE ink_recognitions (
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    canvas_id text NOT NULL,
    text text NOT NULL DEFAULT '',
    data_json jsonb NOT NULL DEFAULT '{}',
    strokes_hash text NOT NULL DEFAULT '',
    error text,
    updated_at bigint NOT NULL,
    PRIMARY KEY (note_id, canvas_id)
  );

  CREATE TABLE embeddings (
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    chunk int NOT NULL,
    body text NOT NULL,
    model text NOT NULL,
    vec vector NOT NULL,
    PRIMARY KEY (note_id, chunk)
  );

  CREATE TABLE integrations (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    base_url text NOT NULL,
    token_enc text NOT NULL,
    settings_json jsonb NOT NULL DEFAULT '{}',
    created_at bigint NOT NULL,
    PRIMARY KEY (user_id, kind)
  );
  `,
];

export async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS migrations (id int PRIMARY KEY, applied_at bigint NOT NULL)');
  const done = new Set((await db.many('SELECT id FROM migrations')).map((r) => r.id));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (done.has(i + 1)) continue;
    await db.tx(async () => {
      for (const stmt of split(MIGRATIONS[i])) await db.q(stmt);
      await db.q('INSERT INTO migrations (id, applied_at) VALUES ($1, $2)', i + 1, Date.now());
    });
  }
}

// Extended-protocol queries take one statement each; migrations hold no semicolons inside literals.
const split = (sql) => sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
