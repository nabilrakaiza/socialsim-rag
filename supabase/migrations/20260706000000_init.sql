-- ============================================================
-- Baseline schema: the database as it stood just before the first
-- tracked migration (20260810030640_hybrid_search).
--
-- The live project was built by hand in the SQL editor in July 2026,
-- so there was no migration for this starting point. This file
-- reconstructs it from the live catalog (checked 2026-11-26), minus
-- what the later migrations add:
--
--   20260810030640  lore_chunks.content_tsv, its GIN index, match_lore_hybrid
--   20260810040813  game_state.scoring_day, claim/release_day_scoring_claim
--   20260810140030  set_updated_at trigger, 30-day retention job
--   20260810141249  game_state.username + its unique index
--
-- Applying this file and then every later migration in order, on an
-- empty database, produces the live schema. supabase/schema.sql is a
-- readable snapshot of that end state; it is not meant to be run.
--
-- Already-live projects: this version is not in the live project's
-- migration history. Run
--   supabase migration repair --status applied 20260706000000
-- before any `supabase db push`, or the CLI will try to apply it.
-- ============================================================


-- 1. EXTENSIONS
-- ============================================================
-- vector lives in public on the live project, so the function
-- signatures below (and the app's RPC calls) resolve it unqualified.
create extension if not exists vector with schema public;
create extension if not exists pg_cron;


-- 2. LORE CHUNKS (RAG core)
-- ============================================================
-- Every chunk, static or generated during play, in one table.
--   is_static = true,  session_id null  -> base lore, shared by all playthroughs
--   is_static = false, session_id set   -> one playthrough's generated memory
create table public.lore_chunks (
  id           uuid primary key default gen_random_uuid(),
  source_file  text not null,         -- bare filename, e.g. 'hiyori_backstory.txt'
  character    text not null,         -- 'hiyori' | 'shiori' | 'yuki'
  chunk_index  integer not null,      -- order within source file
  content      text not null,
  embedding    vector(768) not null,  -- gemini-embedding-001, truncated to 768 dims
  is_static    boolean default true,
  session_id   text,
  created_at   timestamptz default now()
);

-- Not used by the planner at this table size: retrieval filters by
-- character first and sorts the survivors exactly. Kept to match live.
create index lore_chunks_embedding_idx on public.lore_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index lore_chunks_character_idx on public.lore_chunks (character);
create index lore_chunks_is_static_session_id_idx on public.lore_chunks (is_static, session_id);


-- 3. GAME STATE
-- ============================================================
create table public.game_state (
  id                  uuid primary key default gen_random_uuid(),
  session_id          text unique not null,
  current_day         integer default 1,
  action_points       integer default 3,   -- vestigial: nothing reads or writes it
  affection           integer default 0,   -- 0-100, never shown to the player
  relationship_stage  text default 'Stranger',
  yuki_affection      integer default 0,
  confessed           boolean default false,
  game_over           boolean default false,
  ending_id           text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

alter table public.lore_chunks
  add constraint lore_chunks_session_id_fkey
  foreign key (session_id) references public.game_state(session_id)
  on delete cascade;


-- 4. CONVERSATION HISTORY
-- ============================================================
create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null references public.game_state(session_id) on delete cascade,
  day         integer not null,
  character   text not null,   -- 'hiyori' | 'shiori' | 'yuki'
  role        text not null,   -- 'player' | 'npc'
  content     text not null,
  created_at  timestamptz default now()
);

create index messages_session_id_character_created_at_idx
  on public.messages (session_id, character, created_at);


-- 5. DIARY ENTRIES
-- ============================================================
create table public.diary_entries (
  id              uuid primary key default gen_random_uuid(),
  session_id      text not null references public.game_state(session_id) on delete cascade,
  day             integer not null,
  entry_text      text not null,
  affection_tier  integer not null,   -- 1-5 at time of generation
  trigger_type    text not null,      -- 'event' | 'threshold' | 'periodic' | 'confession'
  event_id        text,
  created_at      timestamptz default now()
);

create index diary_entries_session_id_day_idx on public.diary_entries (session_id, day);


-- 6. EVENTS LOG
-- ============================================================
create table public.events_log (
  id               uuid primary key default gen_random_uuid(),
  session_id       text not null references public.game_state(session_id) on delete cascade,
  event_id         text not null,     -- id in lore/events.json
  day_triggered    integer not null,
  player_action    text,
  affection_delta  integer default 0,
  created_at       timestamptz default now()
);

create index events_log_session_id_idx on public.events_log (session_id);


-- 7. DENSE RETRIEVAL
-- ============================================================
-- Session-scoped: static lore plus this playthrough's own memory.
-- The scoping was added in the SQL editor in July and never captured
-- as a migration; these are the live definitions.
create or replace function public.match_lore_chunks(
  query_embedding       vector,
  match_character       text,
  match_session_id      text default null,
  match_count           integer default 5,
  similarity_threshold  double precision default 0.5
)
returns table (id uuid, content text, source_file text, similarity double precision)
language sql
stable
as $$
  select
    lore_chunks.id,
    lore_chunks.content,
    lore_chunks.source_file,
    1 - (lore_chunks.embedding <=> query_embedding) as similarity
  from public.lore_chunks
  where
    lore_chunks.character = match_character
    and (lore_chunks.is_static = true or lore_chunks.session_id = match_session_id)
    and 1 - (lore_chunks.embedding <=> query_embedding) > similarity_threshold
  order by lore_chunks.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_lore_multi_character(
  query_embedding       vector,
  match_characters      text[],
  match_session_id      text default null,
  match_count           integer default 8,
  similarity_threshold  double precision default 0.5
)
returns table (id uuid, content text, source_file text, chara text, similarity double precision)
language sql
stable
as $$
  select
    lore_chunks.id,
    lore_chunks.content,
    lore_chunks.source_file,
    lore_chunks.character,
    1 - (lore_chunks.embedding <=> query_embedding) as similarity
  from public.lore_chunks
  where
    lore_chunks.character = any(match_characters)
    and (lore_chunks.is_static = true or lore_chunks.session_id = match_session_id)
    and 1 - (lore_chunks.embedding <=> query_embedding) > similarity_threshold
  order by lore_chunks.embedding <=> query_embedding
  limit match_count;
$$;


-- 8. ROW LEVEL SECURITY
-- ============================================================
-- Enabled with no policies: anon and authenticated keys see nothing.
-- The server uses the service role key, which bypasses RLS.
alter table public.lore_chunks   enable row level security;
alter table public.game_state    enable row level security;
alter table public.messages      enable row level security;
alter table public.diary_entries enable row level security;
alter table public.events_log    enable row level security;


-- 9. SESSION CLEANUP (original version)
-- ============================================================
-- The first retention job: 7 days on updated_at, which nothing kept
-- current at the time, so it deleted saves 7 days after creation.
-- 20260810140030_session_retention replaces it. It is created here
-- because that migration unschedules it by name.
select cron.schedule(
  'delete-stale-sessions',
  '0 3 * * *',
  $$
    delete from public.game_state
    where updated_at < now() - interval '7 days';
  $$
);
