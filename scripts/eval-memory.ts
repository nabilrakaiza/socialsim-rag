// ============================================================
// scripts/eval-memory.ts
//
// Is a playthrough's accumulated memory a corpus you can actually search?
//
// eval/retrieval-golden.json measures the 37 STATIC chunks — it runs with
// sessionId null. The per-session memory a run generates has never been
// measured at all, and it's the part that makes this a RAG project rather than
// a search box.
//
// It also can't be measured the same way. A golden case labels its answer as
// {file, contains}, which needs a chunk that exists before the test runs.
// Dynamic chunks don't exist until someone plays, and the model writes fresh
// prose every end-of-day, so there is nothing stable to point at.
//
// So this measures properties instead of answers, and needs almost no labels:
//
//   exact-query hit@1  FLOOR CHECK ONLY. Querying with a chunk's own stored
//                      embedding scores cosine 1.0 against itself and takes
//                      rank 1 in both arms, so 100% is guaranteed unless
//                      something is grossly broken. Do not read it as a
//                      quality signal — it was reported as one in the first
//                      version of this script and it meant nothing.
//   excerpt hit@1      ALSO near-tautological, and kept only as a second
//                      floor check. The excerpt is verbatim text from the
//                      chunk, so the lexical arm of hybrid retrieval matches
//                      its source trivially. Measured 100% on every pool,
//                      dynamic and static alike. A test that genuinely
//                      discriminates needs PARAPHRASE queries — same meaning,
//                      different words — which means either an LLM call per
//                      chunk or hand-written labels. Neither is free, which is
//                      why this is documented as a gap rather than faked.
//   nearest neighbour  how close the closest OTHER chunk sits. Tests whether
//                      ~30 knowledge chunks, all from one prompt with one
//                      instruction, all reading "Adrian did X — she took that
//                      to mean Y", collapse into a tight cluster.
//
// The static corpus runs as a CONTROL, and the comparison is SIZE-MATCHED,
// which turned out to be the whole ballgame: nearest-neighbour similarity
// rises with corpus size (more chunks, closer neighbours, by chance alone), so
// comparing an 11-chunk dynamic pool against 24 static chunks would flatter
// the dynamic one. Subsampling static down to the dynamic pool's size and
// resampling gives a distribution to place the dynamic number against.
//
// That comparison is the only part of this script that discriminates. Both
// hit@1 numbers are floor checks; the finding lives in the subsample test.
//
// Usage:
//   npm run eval-memory                  (most recently updated session)
//   npm run eval-memory -- --session <id>
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { matchLoreHybrid } from '../lib/supabase';
import { embedText } from '../lib/embeddings';
import type { NPCCharacter } from '../lib/gemma';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');

const CHARACTERS: NPCCharacter[] = ['hiyori', 'shiori', 'yuki'];

interface Chunk {
  id: string;
  content: string;
  character: NPCCharacter;
  source_file: string;
  embedding: number[];
}

// pgvector comes back over PostgREST as its text form, "[0.1,0.2,...]".
function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  return JSON.parse(String(raw)) as number[];
}

async function loadChunks(sessionId: string | null): Promise<Chunk[]> {
  const query = supabase.from('lore_chunks').select('id, content, character, source_file, embedding');
  const { data, error } = sessionId
    ? await query.eq('session_id', sessionId).eq('is_static', false)
    : await query.eq('is_static', true);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    id: row.id,
    content: row.content,
    character: row.character as NPCCharacter,
    source_file: row.source_file,
    embedding: parseEmbedding(row.embedding),
  }));
}

/**
 * Rank each chunk retrieves itself at, querying with its own stored embedding
 * and its own text.
 *
 * This is a FLOOR CHECK, not a discriminability test, and reading it as one
 * would be a mistake. Querying with the stored vector gives cosine 1.0 against
 * itself, and the chunk's own text is its own best lexical match, so it takes
 * rank 1 in both arms and scores 2/(rrf_k+1) — unbeatable. 100% here is
 * guaranteed unless something is grossly broken (session scoping, a missing
 * row, an RPC returning the wrong ids), which is exactly what it's for.
 *
 * The real measurement is excerptRetrieval below.
 */
async function exactRetrieval(chunks: Chunk[], sessionId: string | null) {
  const ranks: { chunk: Chunk; rank: number }[] = [];

  for (const chunk of chunks) {
    // Deep enough that a failure is visible as a rank rather than an absence.
    const results = await matchLoreHybrid(chunk.embedding, chunk.content, chunk.character, sessionId, 10);
    const at = results.findIndex((result) => result.id === chunk.id);
    ranks.push({ chunk, rank: at === -1 ? 0 : at + 1 });
  }

  return ranks;
}

/**
 * The same question asked honestly: can a chunk still be found from a PARTIAL
 * recollection of it?
 *
 * Queries with a contiguous excerpt of the chunk — roughly the middle half of
 * its words, with the [Day N] marker stripped — re-embedded fresh. That's the
 * shape of a real recall query ("remember the umbrella thing?"): derived from
 * the memory, but not identical to it, so siblings genuinely compete and
 * cosine to the target is well below 1.0.
 *
 * Costs one embedding call per chunk, which is why it's separate from the
 * free floor check rather than replacing it.
 */
async function excerptRetrieval(chunks: Chunk[], sessionId: string | null) {
  const ranks: { chunk: Chunk; rank: number }[] = [];

  for (const chunk of chunks) {
    const words = chunk.content.replace(/^\[Day[^\]]*\]\s*/, '').split(/\s+/);
    const from = Math.floor(words.length * 0.25);
    const excerpt = words.slice(from, from + Math.max(8, Math.floor(words.length * 0.5))).join(' ');

    const results = await matchLoreHybrid(await embedText(excerpt), excerpt, chunk.character, sessionId, 10);
    const at = results.findIndex((result) => result.id === chunk.id);
    ranks.push({ chunk, rank: at === -1 ? 0 : at + 1 });
  }

  return ranks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * How close the nearest OTHER chunk sits, per chunk.
 *
 * Self-retrieval says whether the corpus is searchable; this says how much
 * room is left. A pool whose members average 0.9 to their nearest neighbour is
 * one where any query lands in a fog of near-identical candidates, even while
 * self-retrieval still technically passes.
 */
function neighbourStats(chunks: Chunk[]) {
  if (chunks.length < 2) return null;

  const nearest = chunks.map((chunk) =>
    Math.max(...chunks.filter((other) => other.id !== chunk.id).map((other) => cosine(chunk.embedding, other.embedding)))
  );

  const sorted = [...nearest].sort((a, b) => a - b);
  return {
    mean: nearest.reduce((s, x) => s + x, 0) / nearest.length,
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function rate(ranks: { rank: number }[]) {
  const first = ranks.filter((r) => r.rank === 1).length;
  const found = ranks.filter((r) => r.rank > 0);
  return {
    first,
    pct: (first / ranks.length) * 100,
    meanRank: found.length ? found.reduce((s, r) => s + r.rank, 0) / found.length : 0,
    missing: ranks.filter((r) => r.rank === 0).length,
  };
}

function summarise(
  label: string,
  exact: { chunk: Chunk; rank: number }[],
  excerpt: { chunk: Chunk; rank: number }[],
  chunks: Chunk[]
) {
  if (exact.length === 0) {
    console.log(`\n${label}: no chunks`);
    return null;
  }

  const e = rate(exact);
  const x = rate(excerpt);

  console.log(`\n${label}  (${exact.length} chunks)`);
  console.log(`  exact-query hit@1    ${e.first}/${exact.length}  (${e.pct.toFixed(0)}%)   [floor check — 100% expected]`);
  console.log(`  excerpt hit@1        ${x.first}/${excerpt.length}  (${x.pct.toFixed(0)}%)   mean rank ${x.meanRank.toFixed(2)}, unfound ${x.missing}`);

  const nn = neighbourStats(chunks);
  if (nn) {
    console.log(`  nearest neighbour    mean ${nn.mean.toFixed(3)}  median ${nn.median.toFixed(3)}  max ${nn.max.toFixed(3)}`);
  }

  const failures = excerpt.filter((r) => r.rank !== 1);
  if (failures.length > 0) {
    console.log('  excerpts that landed on a sibling:');
    for (const f of failures.slice(0, 6)) {
      console.log(`    rank ${f.rank === 0 ? '>10' : f.rank}  ${f.chunk.content.slice(0, 66)}…`);
    }
  }

  return { exact: e, excerpt: x };
}

/**
 * Where the dynamic pool's clustering sits against static lore of the SAME
 * size, resampled — so the comparison isn't just measuring that one pool is
 * bigger.
 */
function subsampleComparison(dynamic: Chunk[], statik: Chunk[], trials = 400) {
  if (dynamic.length < 2 || statik.length <= dynamic.length) return null;

  const target = neighbourStats(dynamic)!.mean;
  const samples: number[] = [];

  for (let t = 0; t < trials; t++) {
    const shuffled = [...statik].sort(() => Math.random() - 0.5).slice(0, dynamic.length);
    samples.push(neighbourStats(shuffled)!.mean);
  }
  samples.sort((a, b) => a - b);

  return {
    target,
    mean: samples.reduce((s, x) => s + x, 0) / samples.length,
    p05: samples[Math.floor(trials * 0.05)],
    p95: samples[Math.floor(trials * 0.95)],
    atLeastAsClustered: samples.filter((x) => x >= target).length,
    trials,
  };
}

async function mostRecentSession(): Promise<string | null> {
  const { data } = await supabase
    .from('game_state')
    .select('session_id, current_day, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);
  return data?.[0]?.session_id ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--session');
  const sessionId = flag >= 0 && args[flag + 1] ? args[flag + 1] : await mostRecentSession();

  if (!sessionId) {
    console.log('No session found. Play a day (or seed one) and re-run.');
    return;
  }

  const dynamic = await loadChunks(sessionId);
  const statik = await loadChunks(null);

  console.log(`session ${sessionId}`);
  console.log(`dynamic chunks: ${dynamic.length}   static chunks: ${statik.length}`);

  if (dynamic.length === 0) {
    console.log('\nThis session has no dynamic chunks yet — end at least one day first.');
    return;
  }

  for (const character of CHARACTERS) {
    const mine = dynamic.filter((c) => c.character === character);
    if (mine.length === 0) continue;
    summarise(`DYNAMIC · ${character}`, await exactRetrieval(mine, sessionId), await excerptRetrieval(mine, sessionId), mine);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('SIZE-MATCHED CLUSTERING — dynamic pool vs static lore subsampled');
  console.log('to the same size. This is the measurement that discriminates;');
  console.log('the hit@1 numbers above are floor checks.');

  for (const character of CHARACTERS) {
    const mine = dynamic.filter((c) => c.character === character);
    const theirs = statik.filter((c) => c.character === character);
    const cmp = subsampleComparison(mine, theirs);
    if (!cmp) continue;

    console.log(`\n${character}  (dynamic n=${mine.length}, static n=${theirs.length})`);
    console.log(`  dynamic nearest-neighbour   ${cmp.target.toFixed(3)}`);
    console.log(`  static, same size           ${cmp.mean.toFixed(3)}   p05 ${cmp.p05.toFixed(3)}  p95 ${cmp.p95.toFixed(3)}`);
    console.log(`  static subsamples at least as clustered: ${cmp.atLeastAsClustered}/${cmp.trials}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('CONTROL — the same measurement over static lore. If these are');
  console.log('also imperfect, the metric is noisy rather than memory being bad.');

  for (const character of CHARACTERS) {
    const mine = statik.filter((c) => c.character === character);
    if (mine.length === 0) continue;
    summarise(`STATIC · ${character}`, await exactRetrieval(mine, null), await excerptRetrieval(mine, null), mine);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
