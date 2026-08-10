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
import type { LoreChunk } from './chunking';

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

// Shape returned by match_lore_hybrid. `similarity` is still the true cosine
// value so the eval harness's spread metric stays comparable against the
// pre-hybrid baseline; `score` is the RRF value the ordering actually used.
export interface HybridMatchedChunk extends MatchedChunk {
  score: number;
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

// Scoped to is_static = true, and that scoping is the whole point: dynamic
// chunks (is_static = false, session_id set) are a playthrough's generated
// memory — knowledge updates and diary entries — and deleting those would
// erase what the characters remember. Only the ingested base lore is
// disposable, because it can be rebuilt from lore/ at any time.
export async function deleteStaticLoreChunks(): Promise<number> {
  const { data, error } = await supabase
    .from('lore_chunks')
    .delete()
    .eq('is_static', true)
    .select('id');

  if (error) {
    throw new Error(error.message);
  }

  return data?.length ?? 0;
}

export async function matchLoreChunks(
  queryEmbedding: number[],
  character: LoreChunk['character'],
  sessionId: string | null = null,
  matchCount: number = 5,
  similarityThreshold: number = 0.5
): Promise<MatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_lore_chunks', {
    query_embedding: queryEmbedding,
    match_character: character,
    match_session_id: sessionId,
    match_count: matchCount,
    similarity_threshold: similarityThreshold,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Full-text search fused with vector search — see
// supabase/migrations/0001_hybrid_search.sql for why and how.
//
// Deliberately a separate function rather than a flag on matchLoreChunks: the
// point is to score both paths against the same golden set, and that needs
// both to stay callable. Once the numbers settle, one of them gets deleted.
//
// No similarity threshold parameter, unlike matchLoreChunks. RRF ranks rather
// than scores, so a cosine cutoff would truncate the input to fusion rather
// than filter its output — if a threshold belongs anywhere here, it belongs
// after the fusion, on `score`.
export async function matchLoreHybrid(
  queryEmbedding: number[],
  queryText: string,
  character: LoreChunk['character'],
  sessionId: string | null = null,
  matchCount: number = 5,
  // Swept against eval/retrieval-golden.json: the literature default of 60
  // scored MRR 0.554, everything from 10 up was identical, and 3 peaked at
  // 0.598 — see the migration for why low k wins on a corpus this size.
  rrfK: number = 3
): Promise<HybridMatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_lore_hybrid', {
    query_embedding: queryEmbedding,
    query_text: queryText,
    match_character: character,
    match_session_id: sessionId,
    match_count: matchCount,
    rrf_k: rrfK,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Claims the current day for end-of-day scoring. Returns the day on success,
// null when it is already claimed — see
// supabase/migrations/0002_end_of_day_claim.sql for why the atomicity has to
// live in SQL rather than in a read-then-write here.
export async function claimDayForScoring(sessionId: string): Promise<number | null> {
  const { data, error } = await supabase.rpc('claim_day_for_scoring', {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

// Releases the claim so the day can be scored again. Only for the failure
// path: end of day is retryable by design, and holding a claim through a
// transient model error would strand the session permanently.
export async function releaseDayScoringClaim(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('release_day_scoring_claim', {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function matchLoreMultiCharacter(
  queryEmbedding: number[],
  characters: LoreChunk['character'][],
  sessionId: string | null = null,
  matchCount: number = 8,
  similarityThreshold: number = 0.5
): Promise<MultiMatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_lore_multi_character', {
    query_embedding: queryEmbedding,
    match_characters: characters,
    match_session_id: sessionId,
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
  // Vestigial — the action-point system was dropped for the schedule-based
  // one (README's Daily Flow). Still a live column, so it stays on the type,
  // but nothing reads or writes it.
  action_points: number;
  affection: number;
  // Deliberately `string`, not RelationshipStage: it's a plain text column
  // with no constraint, so the DB can hold anything. It's also denormalized
  // — always affectionToStage(affection), written by batch-eval for display.
  // Derive the stage from affection in logic rather than trusting this.
  relationship_stage: string;
  yuki_affection: number;
  confessed: boolean;
  game_over: boolean;
  ending_id: string | null;
  /**
   * Day most recently claimed for end-of-day scoring. Managed entirely by
   * claimDayForScoring / releaseDayScoringClaim — never write it directly.
   */
  scoring_day: number | null;
}

// role reuses DialogueTurn's 'player' | 'npc' union — confirmed as of
// lib/chat.ts's sendPlayerMessage, the only writer of messages rows so
// far. Nothing enforces this at the DB level (role is a plain text
// column), so any future writer needs to keep using the same values.
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

// Every column is written explicitly rather than leaning on the table's
// defaults. The defaults exist, but relying on them is how relationship_stage
// ended up defaulting to lowercase 'stranger' while the code only ever
// produces 'Stranger' — a fresh row held a value the type said was impossible.
export async function insertGameState(sessionId: string): Promise<GameState> {
  const { data, error } = await supabase
    .from('game_state')
    .insert({
      session_id: sessionId,
      current_day: 1,
      affection: 0,
      relationship_stage: 'Stranger',
      yuki_affection: 0,
      confessed: false,
      game_over: false,
      ending_id: null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
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

// Oldest first, unlike getLastDiaryEntries — this is for reading the whole
// run back at the end, where chronological order is the point.
export async function getDiaryArchive(sessionId: string): Promise<DiaryEntry[]> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select('*')
    .eq('session_id', sessionId)
    .order('day', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// A character's accumulated memory of this playthrough, fetched directly
// rather than by similarity. Every retrieval path so far goes through an
// embedding, but the ending wants the whole record, not the parts that match
// a query.
export async function getDynamicChunks(
  sessionId: string,
  character: LoreChunk['character']
): Promise<{ content: string; source_file: string }[]> {
  const { data, error } = await supabase
    .from('lore_chunks')
    .select('content, source_file')
    .eq('session_id', sessionId)
    .eq('character', character)
    .eq('is_static', false)
    // Chronological, so the ending reads her impressions in the order she
    // formed them. Not by source_file: that's `dynamic-day-N`, and sorting
    // text puts day 10 before day 2. chunk_index breaks ties within a day —
    // the knowledge update (0) before the diary entry (2).
    .order('created_at', { ascending: true })
    .order('chunk_index', { ascending: true });

  if (error) {
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

export async function insertMessage(
  message: Omit<Message, 'id' | 'created_at'>
): Promise<void> {
  const { error } = await supabase.from('messages').insert(message);

  if (error){
    throw new Error(error.message);
  }
}
// ============================================================
// events_log — what fired, when, and how the player handled it.
//
// This table is the only persisted event state. lib/events.ts is pure
// logic and stores nothing, so the orchestrator reconstructs everything
// it needs from these rows: which extended arcs a playthrough has already
// used, which arc is currently active and when it started, and which of
// its sub-events have fired.
//
// player_action holds the player's free-text response, written during the
// day; affection_delta stays 0 until the end-of-day batch eval scores that
// response (see lib/gemma.ts's generateEventOutcome) and fills it in.
// ============================================================

export interface EventLog {
  id: string;
  session_id: string;
  // Either a GameEvent id or a SubEvent id — sub-events are logged in their
  // own right, since "which sub-events have fired" is what drives an arc's
  // force-out logic.
  event_id: string;
  day_triggered: number;
  player_action: string | null;
  affection_delta: number;
  created_at: string;
}

// Returns the inserted row rather than void: the orchestrator writes a row
// when an event fires and needs its id straight away to hand to the client,
// which passes it back with the player's response. A caller that can't
// identify what it just wrote would have to guess.
// Deletes specific rows by id. The caller decides which — see startDay, where
// working out what's safe to discard needs events.json and so can't be done
// from a query alone.
export async function deleteEventLogsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const { data, error } = await supabase.from('events_log').delete().in('id', ids).select('id');

  if (error) {
    throw new Error(error.message);
  }

  return data?.length ?? 0;
}

export async function insertEventLog(
  entry: Omit<EventLog, 'id' | 'created_at'>
): Promise<EventLog> {
  const { data, error } = await supabase.from('events_log').insert(entry).select().single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// player_action is filled in when the player answers; it stays null on rows
// for events that were ignored, which is what tells the batch eval to apply
// skipPenalty instead of spending an LLM call grading silence.
export async function updateEventLogAction(
  eventLogId: string,
  playerAction: string
): Promise<void> {
  const { error } = await supabase.from('events_log').update({ player_action: playerAction }).eq('id', eventLogId);

  if (error) {
    throw new Error(error.message);
  }
}

// Scored at end-of-day rather than on the spot, so the batch eval needs to
// find the day's rows again to fill in their affection_delta.
export async function getEventLogsForDay(sessionId: string, day: number): Promise<EventLog[]> {
  const { data, error } = await supabase
    .from('events_log')
    .select('*')
    .eq('session_id', sessionId)
    .eq('day_triggered', day)
    .order('created_at');

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Whole-playthrough history — the orchestrator needs this to work out which
// arcs are already used (they're one-time-only) and to rebuild active-arc state.
export async function getAllEventLogs(sessionId: string): Promise<EventLog[]> {
  const { data, error } = await supabase
    .from('events_log')
    .select('*')
    .eq('session_id', sessionId)
    .order('day_triggered');

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function updateEventLogOutcome(
  eventLogId: string,
  affectionDelta: number
): Promise<void> {
  const { error } = await supabase
    .from('events_log')
    .update({ affection_delta: affectionDelta })
    .eq('id', eventLogId);

  if (error) {
    throw new Error(error.message);
  }
}
