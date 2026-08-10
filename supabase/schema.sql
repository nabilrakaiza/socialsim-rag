-- ============================================================
-- affection-engine: Supabase Schema
-- ============================================================
-- Reference copy of the live schema — verified against the actual
-- project via Supabase MCP (list_tables/list_extensions/execute_sql)
-- on 2026-07-13, refreshed 2026-08-10 for hybrid retrieval.
--
-- Changes since are tracked as files in supabase/migrations/ and
-- folded back into this file; this stays the single readable
-- snapshot of what is actually live. Every statement below already exists live (tables,
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
  character    text not null,         -- 'hiyori' | 'shiori' | 'yuki' (see note below)
  chunk_index  integer not null,      -- order within source file
  content      text not null,         -- raw text of this chunk
  embedding    vector(768) not null,  -- gemini-embedding-001, truncated to 768 dims
  is_static    boolean default true,  -- true = base lore (shared), false = generated during gameplay
  session_id   text,                  -- set only for dynamic (is_static=false) chunks
  created_at   timestamptz default now(),
  -- Lexical arm of hybrid retrieval. Generated, so ingestion writes
  -- nothing extra and existing rows backfill on add.
  content_tsv  tsvector generated always as (to_tsvector('english', content)) stored
);

-- `character` held 'adrian' and 'events' until 2026-08-10. Retrieval is
-- only ever called with an NPC, so those 34 chunks (48% of the static
-- corpus) were embedded and unreachable — they are gone, and
-- lib/chunking.ts now throws rather than defaulting a file into a pool
-- nothing searches. See README "Unreachable chunks".

-- IVFFlat with lists=100 — note this is oversized for the current
-- ~37-row table (most lists end up empty/near-empty at this scale,
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

-- Full-text index backing match_lore_hybrid's sparse arm.
create index if not exists lore_chunks_content_tsv_idx
  on public.lore_chunks using gin (content_tsv);


-- 3. GAME STATE
-- ============================================================
-- One row per game session. Stores the live game state.

create table public.game_state (
  id                    uuid primary key default gen_random_uuid(),
  session_id            text unique not null,   -- frontend-generated session ID
  -- Player-chosen save name, so a run can be found again from a different
  -- browser or device. An IDENTIFIER, NOT A SECRET: anyone who guesses it can
  -- open that save, and because confessing is permanent they can end it. That
  -- trade buys a one-field flow and is deliberate — don't build anything on
  -- top of this that needs real authentication. Unique case-insensitively via
  -- game_state_username_unique; null for sessions predating it.
  username              text,
  current_day           integer default 1,
  -- Day most recently claimed for end-of-day scoring. Written ONLY by
  -- claim_day_for_scoring / release_day_scoring_claim (section 12) — never
  -- set it directly. Added 2026-08-10 after a real playthrough had day 1
  -- scored twice, which is unrepairable rather than merely untidy.
  scoring_day           integer,
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
-- Deletes any session inactive for 30+ days. Because messages,
-- diary_entries, events_log, and lore_chunks (dynamic rows) all
-- have "on delete cascade" back to game_state, deleting the
-- game_state row is enough to clean up everything for that session.
--
-- This was 7 days and it was NOT an inactivity purge, despite what
-- this comment used to claim. updated_at defaulted to now() on
-- insert with no trigger maintaining it and no application code
-- writing it, so the column was really created_at and the job
-- deleted every session seven days after it BEGAN, however
-- actively it was being played. For a thirty-day game that is the
-- expected path, not an edge case.
--
-- Fixed in supabase/migrations/0003_session_retention.sql: a
-- before-update trigger keeps updated_at honest (section 11), and
-- the window widened to 30 days now that it means what it says.
-- Storage is not the constraint here — a whole session is roughly
-- 100KB against a 500MB free tier.

create extension if not exists pg_cron;

select cron.schedule(
  'delete-stale-sessions',
  '0 3 * * *',  -- every day at 3am UTC
  $$
    delete from public.game_state
    where updated_at < now() - interval '30 days';
  $$
);


-- 11. updated_at MAINTENANCE
-- ============================================================
-- What makes the cleanup job above an inactivity purge rather than
-- an age purge. Every write the game makes to a session goes
-- through updateGameState — ending a day, confessing, claiming a
-- day for scoring — so any real play pushes the retention window
-- out. Chat alone doesn't touch game_state, but a day with
-- conversation in it ends in a batch eval that writes affection.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger game_state_set_updated_at
  before update on public.game_state
  for each row
  execute function public.set_updated_at();


-- 11. HELPER FUNCTION: match_lore_hybrid
-- ============================================================
-- Full-text search fused with vector search via Reciprocal Rank
-- Fusion. This is what lib/chat.ts calls; match_lore_chunks above
-- is kept so both paths stay scoreable against the golden set.
--
-- Cosine alone cannot rank a short conversational message: every
-- chunk lands within ~0.03 of every other. The two arms fail on
-- different queries, which is why they are fused rather than one
-- replacing the other. Full rationale, including the three
-- implementation traps, lives in
-- supabase/migrations/0001_hybrid_search.sql.
--
-- rrf_k defaults to 3, not the literature's 60: swept against
-- eval/retrieval-golden.json, 60 scored MRR 0.554 and 3 scored
-- 0.598. Re-sweep after any change to chunking or corpus size.

-- (definition kept in supabase/migrations/0001_hybrid_search.sql —
-- reproduced there in full with its reasoning, rather than
-- duplicated here where the two copies would drift apart)


-- 12. END-OF-DAY CLAIM
-- ============================================================
-- endDay is minutes of LLM work and is NOT idempotent: a second run
-- scores the same day again, writes duplicate knowledge chunks, and
-- applies affection twice with no record of each run's contribution.
-- A real playthrough lost its save to exactly that — the two runs
-- also interpreted the day differently, leaving every character
-- holding contradictory memories of it.
--
-- claim_day_for_scoring(session_id) -> integer
--   Claims the current day atomically. Returns the day, or NULL when
--   it is already claimed. The conditional UPDATE is what makes this
--   safe: two concurrent calls serialise on the row lock, and under
--   READ COMMITTED the loser re-evaluates its WHERE against the
--   winner's committed row and matches nothing. A read-then-write in
--   application code would not have that property.
--
-- release_day_scoring_claim(session_id) -> void
--   Clears the claim. Failure path only — end of day is retryable by
--   design, and a claim held through a transient model error would
--   strand the session permanently.
--
-- Definitions live in supabase/migrations/0002_end_of_day_claim.sql.


-- 13. USERNAME SAVES
-- ============================================================
-- lower() so "Nabil" and "nabil" cannot both be claimed, and so a
-- player who capitalises differently on their return still finds
-- their save. Postgres excludes nulls from unique indexes, so every
-- session created before this kept its null without colliding.
--
-- The index is also the only thing that can decide a race: two
-- players claiming the same name in the same moment would both see
-- it free under a check-then-insert, so insertGameState catches the
-- 23505 unique_violation rather than pre-checking.

create unique index if not exists game_state_username_unique
  on public.game_state (lower(username));
