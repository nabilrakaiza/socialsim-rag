-- ============================================================
-- supabase/schema.sql
--
-- Proposed schema for lore_chunks, matching lib/chunking.ts's
-- LoreChunk type. README says these were already "drafted" —
-- if you already created a version of this directly in the
-- Supabase SQL editor, diff against that before running this,
-- don't just run it blind.
--
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor),
-- not via a migration tool, unless you've already set one up.
--
-- STALE as of 2026-07-11: the live project already has a
-- hand-created lore_chunks table + RPCs that diverged from this
-- file (uuid id instead of bigint, no section_title column,
-- similarity_threshold instead of match_session_id). Do not run
-- this as-is — lib/supabase.ts was updated to match the live
-- schema instead. Keeping this file as a record of the original
-- design in case session-scoped retrieval gets added back later.
-- ============================================================

-- pgvector extension (vector similarity search)
create extension if not exists vector;

create table if not exists lore_chunks (
  id bigint generated always as identity primary key,
  content text not null,
  character text not null check (character in ('hiyori', 'shiori', 'yuki', 'adrian', 'events')),
  source_file text not null,
  chunk_index integer not null,
  is_static boolean not null default true,
  -- null for static lore (shared across all playthroughs).
  -- set for dynamic content, scoped to one playthrough.
  session_id uuid,
  section_title text,
  -- 768 dims to match embedText()'s outputDimensionality in lib/embeddings.ts
  embedding vector(768) not null,
  created_at timestamptz not null default now()
);

-- HNSW over IVFFlat: this table starts small (~30-40 static rows)
-- and grows during gameplay. IVFFlat needs a decently sized
-- dataset already present to build good clusters; HNSW performs
-- well from a small starting size and doesn't need rebuilding
-- as rows get added.
create index if not exists lore_chunks_embedding_idx
  on lore_chunks
  using hnsw (embedding vector_cosine_ops);

-- Retrieve top-k chunks for ONE character, scoped to static lore
-- plus whatever this playthrough has generated so far.
-- Call with match_session_id = null to pull static-only (e.g.
-- before any playthrough session exists yet).
create or replace function match_lore_chunks (
  query_embedding vector(768),
  match_character text,
  match_session_id uuid,
  match_count int default 5
)
returns table (
  id bigint,
  content text,
  character text,
  section_title text,
  similarity float
)
language sql stable
as $$
  select
    lore_chunks.id,
    lore_chunks.content,
    lore_chunks.character,
    lore_chunks.section_title,
    1 - (lore_chunks.embedding <=> query_embedding) as similarity
  from lore_chunks
  where lore_chunks.character = match_character
    and (lore_chunks.is_static = true or lore_chunks.session_id = match_session_id)
  order by lore_chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- Same idea, but across multiple characters in one call — e.g.
-- for scenes involving more than one NPC at once.
create or replace function match_lore_multi_character (
  query_embedding vector(768),
  match_characters text[],
  match_session_id uuid,
  match_count int default 5
)
returns table (
  id bigint,
  content text,
  character text,
  section_title text,
  similarity float
)
language sql stable
as $$
  select
    lore_chunks.id,
    lore_chunks.content,
    lore_chunks.character,
    lore_chunks.section_title,
    1 - (lore_chunks.embedding <=> query_embedding) as similarity
  from lore_chunks
  where lore_chunks.character = any (match_characters)
    and (lore_chunks.is_static = true or lore_chunks.session_id = match_session_id)
  order by lore_chunks.embedding <=> query_embedding
  limit match_count;
$$;
