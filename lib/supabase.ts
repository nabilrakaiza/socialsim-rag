// ============================================================
// lib/supabase.ts
//
// Supabase client + insert/retrieval helpers for lore_chunks and
// the end-of-day batch eval tables (game_state/messages/diary_entries).
//
// NOTE (2026-07-13): supabase/schema.sql is now an accurate, MCP-
// verified snapshot of the live schema (previously it was stale —
// see git history if curious). Still no section_title column on
// lore_chunks, so chunking.ts's section_title gets folded into
// content at ingestion time (see scripts/ingest.ts) rather than
// stored separately. match_lore_multi_character's per-row character
// column is named `chara`, not `character`, in its return shape.
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
    session_id: chunk.session_id ?? null,
    embedding: embeddings[i],
  }));

  const { error } = await supabase.from('lore_chunks').insert(rows);

  if (error) {
    throw new Error(error.message);
  }
}

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

// ============================================================
// End-of-day batch eval helpers — game_state / messages /
// diary_entries. Columns below match the live tables (checked via
// Supabase MCP list_tables), not a drafted schema — no drift risk
// like lore_chunks/schema.sql had, but keep it that way: if you
// change a column live, update the type here too.
// ============================================================

export interface GameState {
  session_id: string;
  current_day: number;
  action_points: number;
  affection: number;
  relationship_stage: string;
  yuki_affection: number;
  confessed: boolean;
  game_over: boolean;
  ending_id: string | null;
}

// role reuses DialogueTurn's 'player' | 'npc' union — messages rows are
// assumed to be written with those same values by whatever chat/game
// loop ends up inserting them (not built yet). Worth confirming once
// that exists, since nothing enforces it at the DB level (role is a
// plain text column).
export interface Message {
  id: string;
  session_id: string;
  day: number;
  character: LoreChunk['character'];
  role: 'player' | 'npc';
  content: string;
  created_at: string;
}

export interface DiaryEntry {
  id: string;
  session_id: string;
  day: number;
  entry_text: string;
  affection_tier: number;
  trigger_type: string;
  event_id: string | null;
  created_at: string;
}

// .single() errors if 0 or 2+ rows come back, which is what you want
// here — session_id is unique.
export async function getGameState(sessionId: string): Promise<GameState> {
  const { data, error } = await supabase.from('game_state').select('*').eq('session_id', sessionId).single();

  if (error){
    throw new Error(error.message);
  }

  return data;
}

export async function updateGameState(
  sessionId: string,
  updates: Partial<Omit<GameState, 'session_id'>>
): Promise<void> {
  const {error} = await supabase.from('game_state').update(updates).eq('session_id', sessionId);

  if (error){
    throw new Error(error.message);
  } 
}

// Scoped to one session+day on purpose — "today's conversation," not
// the whole game's history (see lib/gemma.ts's history-scoping design).
export async function getMessagesForDay(sessionId: string, day: number): Promise<Message[]> {
  const { data, error } = await supabase.from('messages').select('*').eq('session_id', sessionId).eq('day', day).order('created_at');

  if (error){
    throw new Error(error.message);
  }

  return data;
}

// Comes back newest-first — caller (generateDiaryEntry's context) may
// want to .reverse() so they read chronologically in the prompt.
export async function getLastDiaryEntries(sessionId: string, limit: number = 2): Promise<DiaryEntry[]> {
  const { data, error } = await supabase.from('diary_entries').select('*').eq('session_id', sessionId).order('day', {ascending: false}).limit(limit);

  if (error){
    throw new Error(error.message);
  }
  return data;
}

// event_id is nullable — only set when trigger_type is 'event'.
export async function insertDiaryEntry(
  entry: Omit<DiaryEntry, 'id' | 'created_at'>
): Promise<void> {
  const { error } = await supabase.from('diary_entries').insert(entry);

  if (error){
    throw new Error(error.message);
  }
}
