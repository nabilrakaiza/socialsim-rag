// ============================================================
// lib/supabase.ts
//
// Supabase client + insert/retrieval helpers for lore_chunks.
//
// NOTE (2026-07-11): supabase/schema.sql is OUT OF DATE — the
// live lore_chunks table + RPCs were already created by hand in
// the SQL editor and drifted from that file. Do NOT run
// schema.sql; the types/signatures below match what's actually
// deployed. Differences worth knowing:
//   - id is uuid, not bigint
//   - there is no section_title column — chunking.ts still
//     produces section_title per chunk, but it has nowhere to go,
//     so leave it out of the insert payload for now
//   - match_lore_chunks / match_lore_multi_character take
//     (match_count, similarity_threshold) — there's no
//     match_session_id param, so retrieval isn't scoped by
//     playthrough session yet, just character + similarity
//   - match_lore_multi_character's per-row character column is
//     named `chara` (not `character`) in its return shape
//
// ============================================================

import { createClient } from '@supabase/supabase-js';
import type { LoreChunk } from './chunking.js';

// SERVICE_ROLE, not ANON_PUBLIC_KEY — ingestion is a server-side/trusted
// script writing data, and this key bypasses Row Level Security.
// Never expose it to a browser/frontend context.
const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SERVICE_ROLE ?? ''
);

// Shape returned by match_lore_chunks (single character — the
// character column is redundant there since you already filtered
// on it, so the live RPC doesn't return it).
export interface MatchedChunk {
  id: string;
  content: string;
  source_file: string;
  similarity: number;
}

// Shape returned by match_lore_multi_character — same as
// MatchedChunk, plus which character each row belongs to. The
// live RPC names this column `chara`, not `character`.
export interface MultiMatchedChunk extends MatchedChunk {
  chara: string;
}

// Insert a batch of already-embedded chunks into lore_chunks.
export async function insertLoreChunks(
  chunks: LoreChunk[],
  embeddings: number[][]
): Promise<void> {
  // picked explicitly, not spread — lore_chunks has no section_title column
  const rows = chunks.map((chunk, i) => ({
    content: chunk.content,
    character: chunk.character,
    source_file: chunk.source_file,
    chunk_index: chunk.chunk_index,
    is_static: chunk.is_static,
    embedding: embeddings[i],
  }));

  const { error } = await supabase.from('lore_chunks').insert(rows);

  if (error) {
    throw new Error(error.message);
  }
}

// Retrieve top-k chunks for ONE character.
export async function matchLoreChunks(
  queryEmbedding: number[],
  character: LoreChunk['character'],
  matchCount: number = 5,
  similarityThreshold: number = 0.5
): Promise<MatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_lore_chunks', {
    query_embedding: queryEmbedding,
    match_character: character,
    match_count: matchCount,
    similarity_threshold: similarityThreshold,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Same idea as matchLoreChunks, but across multiple characters in one call.
export async function matchLoreMultiCharacter(
  queryEmbedding: number[],
  characters: LoreChunk['character'][],
  matchCount: number = 8,
  similarityThreshold: number = 0.5
): Promise<MultiMatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_lore_multi_character', {
    query_embedding: queryEmbedding,
    match_characters: characters,
    match_count: matchCount,
    similarity_threshold: similarityThreshold,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
