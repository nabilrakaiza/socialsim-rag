-- ============================================================
-- affection-engine: Supabase Schema
-- ============================================================
-- Reference copy of the live schema — verified against the actual
-- project via Supabase MCP (list_tables/list_extensions/execute_sql)
-- on 2026-07-13. Every statement below already exists live (tables,
-- indexes, FKs, RLS, both RPCs, and the cron job), most of it built
-- incrementally in the SQL editor before this file was consolidated.
--
-- DO NOT run this end-to-end — every `create table`/`create
-- extension` will error with "already exists". If you need to
-- reproduce this on a fresh project, add `if not exists` first.
-- ============================================================

-- 1. EXTENSIONS
-- ============================================================
create extension if not exists vector;


-- 2. LORE CHUNKS (RAG core)
-- ============================================================
-- Stores all embedded lore chunks used for RAG retrieval.
-- Each chunk has an embedding, metadata for filtering, and
-- the source text that gets injected into Gemma's prompt.

create table public.lore_chunks (
  id           uuid primary key default gen_random_uuid(),
  source_file  text not null,         -- e.g. 'hiyori_backstory.txt'
  character    text not null,         -- 'hiyori' | 'shiori' | 'yuki' | 'adrian' | 'events'
  chunk_index  integer not null,      -- order within source file
  content      text not null,         -- raw text of this chunk
  embedding    vector(768) not null,  -- gemini-embedding-001, truncated to 768 dims
  is_static    boolean default true,  -- true = base lore (shared), false = generated during gameplay
  session_id   text,                  -- set only for dynamic (is_static=false) chunks
  created_at   timestamptz default now()
);

-- IVFFlat with lists=100 — note this is oversized for the current
-- ~60-row table (most lists end up empty/near-empty at this scale,
-- which can hurt recall since IVFFlat only probes a handful of lists
-- by default). Retrieval has been manually verified as good anyway
-- (see scripts/test-retrieval.ts results in project memory), so not
-- an active problem, but if recall quality ever looks off, this
-- index — or switching to HNSW, which doesn't need a large dataset
-- to build good clusters — is the first thing to revisit.
create index on public.lore_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Index for filtering by character before similarity search
create index on public.lore_chunks (character);

-- Index for filtering static vs dynamic chunks, and by session
create index on public.lore_chunks (is_static, session_id);


-- 3. GAME STATE
-- ============================================================
-- One row per game session. Stores the live game state.

create table public.game_state (
  id                    uuid primary key default gen_random_uuid(),
  session_id            text unique not null,   -- frontend-generated session ID
  current_day           integer default 1,
  -- VESTIGIAL as of 2026-07-26: the action-point system was dropped in
  -- favour of the schedule itself being the day's scarcity (see README's
  -- Daily Flow). Nothing reads or writes this column any more. Kept
  -- because dropping a column is irreversible and it costs nothing.
  action_points         integer default 3,
  affection             integer default 0,      -- 0-100, never exposed to player
  -- Default was lowercase 'stranger' while lib/relationship.ts's
  -- RelationshipStage only ever produces capitalized values, so a fresh
  -- row held something that type says is impossible. Fixed 2026-07-27 —
  -- the live default is now 'Stranger'. Still a plain text column with no
  -- check constraint, so treat the stored value as untrusted anyway: it's
  -- denormalized (always affectionToStage(affection)), written by
  -- batch-eval for display. Game logic should derive the stage from
  -- affection rather than read this column.
  relationship_stage    text default 'Stranger',
  yuki_affection        integer default 0,      -- hidden, for secret end
  confessed             boolean default false,
  game_over             boolean default false,
  ending_id             text,                   -- set when game ends
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

alter table public.lore_chunks
  add constraint lore_chunks_session_id_fkey
  foreign key (session_id) references public.game_state(session_id)
  on delete cascade;


-- 4. CONVERSATION HISTORY
-- ============================================================
-- Stores chat messages per session per NPC.
-- Last N messages are included in Gemma's prompt context.

create table public.messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   text not null references public.game_state(session_id) on delete cascade,
  day          integer not null,
  character    text not null,   -- 'hiyori' | 'shiori' | 'yuki'
  role         text not null,   -- 'player' | 'npc' — matches lib/gemma.ts's DialogueTurn
  content      text not null,
  created_at   timestamptz default now()
);

create index on public.messages (session_id, character, created_at);


-- 5. DIARY ENTRIES
-- ============================================================
-- Hiyori's dynamic diary entries, generated by Gemma.
-- Also embedded and stored in lore_chunks for RAG.

create table public.diary_entries (
  id                    uuid primary key default gen_random_uuid(),
  session_id            text not null references public.game_state(session_id) on delete cascade,
  day                   integer not null,
  entry_text            text not null,
  affection_tier        integer not null,   -- 1-5, at time of generation
  trigger_type          text not null,      -- 'event' | 'threshold' | 'periodic' | 'confession'
  event_id              text,               -- references events.json id, nullable
  created_at            timestamptz default now()
);

create index on public.diary_entries (session_id, day);


-- 6. EVENTS LOG
-- ============================================================
-- Tracks which events have fired in a session and their outcomes.

create table public.events_log (
  id              uuid primary key default gen_random_uuid(),
  session_id      text not null references public.game_state(session_id) on delete cascade,
  event_id        text not null,          -- references events.json id
  day_triggered   integer not null,
  player_action   text,                   -- what the player typed
  affection_delta integer default 0,      -- how much affection changed
  created_at      timestamptz default now()
);

create index on public.events_log (session_id);


-- 7. HELPER FUNCTION: match_lore_chunks
-- ============================================================
-- Called by the RAG retrieval layer (lib/supabase.ts's matchLoreChunks).
-- Filters by character, then returns top-k by cosine similarity.

create or replace function public.match_lore_chunks(
  query_embedding    vector(768),
  match_character    text,
  match_count        int     default 5,
  similarity_threshold float  default 0.5
)
returns table (
  id          uuid,
  content     text,
  source_file text,
  similarity  float
)
language sql stable
as $$
  select
    public.lore_chunks.id,
    public.lore_chunks.content,
    public.lore_chunks.source_file,
    1 - (public.lore_chunks.embedding <=> query_embedding) as similarity
  from public.lore_chunks
  where
    public.lore_chunks.character = match_character
    and 1 - (public.lore_chunks.embedding <=> query_embedding) > similarity_threshold
  order by public.lore_chunks.embedding <=> query_embedding
  limit match_count;
$$;


-- 8. HELPER FUNCTION: match_lore_multi_character
-- ============================================================
-- Same as above but accepts an array of characters (lib/supabase.ts's
-- matchLoreMultiCharacter) — for scenes involving more than one NPC.

create or replace function public.match_lore_multi_character(
  query_embedding    vector(768),
  match_characters   text[],
  match_count        int     default 8,
  similarity_threshold float  default 0.5
)
returns table (
  id          uuid,
  content     text,
  source_file text,
  chara       text,
  similarity  float
)
language sql stable
as $$
  select
    public.lore_chunks.id,
    public.lore_chunks.content,
    public.lore_chunks.source_file,
    public.lore_chunks.character,
    1 - (public.lore_chunks.embedding <=> query_embedding) as similarity
  from public.lore_chunks
  where
    public.lore_chunks.character = any(match_characters)
    and 1 - (public.lore_chunks.embedding <=> query_embedding) > similarity_threshold
  order by public.lore_chunks.embedding <=> query_embedding
  limit match_count;
$$;


-- 9. ROW LEVEL SECURITY
-- ============================================================
-- Only the Next.js API routes (using the service_role key) talk
-- to these tables — the browser never queries Supabase directly.
-- service_role bypasses RLS regardless, so enabling this with no
-- policies simply blocks any anon/authenticated key from touching
-- these tables directly, even if that key ever leaks.

alter table public.lore_chunks enable row level security;
alter table public.game_state enable row level security;
alter table public.messages enable row level security;
alter table public.diary_entries enable row level security;
alter table public.events_log enable row level security;

-- No policies are added on purpose — this means anon/authenticated
-- have zero access by default. service_role (used server-side) is
-- unaffected and can still read/write everything.


-- 10. SCHEDULED CLEANUP (stale sessions)
-- ============================================================
-- Deletes any session inactive for 7+ days. Because messages,
-- diary_entries, events_log, and lore_chunks (dynamic rows) all
-- have "on delete cascade" back to game_state, deleting the
-- game_state row is enough to clean up everything for that session.

create extension if not exists pg_cron;

select cron.schedule(
  'delete-stale-sessions',
  '0 3 * * *',  -- every day at 3am UTC
  $$
    delete from public.game_state
    where updated_at < now() - interval '7 days';
  $$
);
