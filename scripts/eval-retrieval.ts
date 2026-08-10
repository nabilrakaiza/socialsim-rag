// ============================================================
// scripts/eval-retrieval.ts
//
// Scores retrieval against the hand-labelled set in eval/retrieval-golden.json.
//
// The difference between this and scripts/test-retrieval.ts: that one prints
// what came back so you can read it and form an opinion. This one knows what
// SHOULD have come back, so it can fail.
//
// Usage:
//   npm run eval-retrieval
//   npm run eval-retrieval -- --k 5 --threshold 0.55
//   npm run eval-retrieval -- --hybrid        (full-text + vector via RRF)
//   npm run eval-retrieval -- --save          (writes eval/baseline.json)
//
// Once a baseline exists, every run prints a delta against it — which is the
// whole point. You're about to make a dozen retrieval changes, several of
// which overlap, and at least one of which will make things worse.
// ============================================================

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { embedText } from '../lib/embeddings';
import { matchLoreChunks, matchLoreHybrid } from '../lib/supabase';
import { needsRetrieval } from '../lib/query-intent';
import type { MatchedChunk } from '../lib/supabase';
import type { NPCCharacter } from '../lib/gemma';

const GOLDEN_PATH = join(process.cwd(), 'eval', 'retrieval-golden.json');
const BASELINE_PATH = join(process.cwd(), 'eval', 'baseline.json');

interface ChunkLabel {
  /** Filename as stored, e.g. "hiyori_interests.txt". */
  file: string;
  /** Distinctive substring of the chunk's content. Section headings are the most stable. */
  contains: string;
}

interface GoldenCase {
  id: string;
  query: string;
  character: NPCCharacter;
  /** Empty array = nothing should be retrieved. A valid and important answer. */
  expect: ChunkLabel[];
  note?: string;
  /**
   * Reserved for testing "embed more than the bare message" (README item B1):
   * the last few conversation turns to prepend before embedding. Nothing reads
   * this yet — wire it up when you get to that change, so the same golden set
   * scores both variants.
   */
  context?: string[];
}

interface CaseResult {
  id: string;
  negative: boolean;
  returned: number;
  /** Did any expected chunk appear in the top k? Always false for negative cases. */
  hit: boolean;
  /** 1/rank of the first correct chunk, 0 if absent. For negatives: 1 if empty, else 0. */
  rr: number;
  /** Best similarity minus worst, across what came back. 0 when fewer than 2 results. */
  spread: number;
  topSimilarity: number;
}

interface Summary {
  label: string;
  k: number;
  threshold: number;
  hitRate: number;
  mrr: number;
  cleanNegatives: number;
  meanSpread: number;
  meanReturned: number;
}

// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------

function loadGoldenSet(): GoldenCase[] {
  const parsed: { cases: GoldenCase[] } = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));
  return parsed.cases;
}

function parseArgs(): { k: number; threshold: number; save: boolean; hybrid: boolean; rrfK: number } {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: number) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
  };

  // Defaults mirror matchLoreChunks' own defaults, so a bare run measures
  // exactly what the game currently does.
  return {
    k: value('--k', 5),
    threshold: value('--threshold', 0.5),
    save: args.includes('--save'),
    // Both paths stay callable so the same golden set scores each one. The
    // threshold flag is ignored under --hybrid: RRF consumes ranks, so there
    // is no cosine cutoff to apply (see matchLoreHybrid).
    hybrid: args.includes('--hybrid'),
    // Matches matchLoreHybrid's default so a bare --hybrid run measures what
    // the game actually does. Swept: 60 -> MRR 0.554, 3 -> 0.598.
    rrfK: value('--rrf-k', 3),
  };
}

// ------------------------------------------------------------
// YOUR PART — the scoring
// ------------------------------------------------------------

/**
 * Does this retrieved chunk satisfy this label?
 *
 * Two conditions, both required: the filenames match, and chunk.content
 * contains the label's `contains` string.
 *
 * Matched this way rather than by id or chunk_index because `npm run ingest`
 * deletes and reinserts every static row, so ids are new each time, and
 * chunk_index shifts the moment a file is re-chunked (item A5). A label has to
 * survive both.
 */
function matchesLabel(chunk: MatchedChunk, label: ChunkLabel): boolean {
  return label.file == chunk.source_file && chunk.content.includes(label.contains)
}

/**
 * Reciprocal rank of the first correct result.
 *
 * Rank 1 scores 1.0, rank 2 scores 0.5, rank 5 scores 0.2, absent scores 0.
 *
 * This is the metric that catches this codebase's actual failure: hit rate can
 * read 88% while the right chunk sits at rank 4 behind three diary entries —
 * and the model reads rank 1 hardest.
 */
function reciprocalRank(results: MatchedChunk[], expect: ChunkLabel[]): number {
  let pos = 1
  
  for (const result of results){
    for (const ex of expect){
      if (matchesLabel(result, ex)){
        return 1/pos;
      }
    }
    pos += 1
  }

  return 0;
}

/**
 * Best similarity minus worst, across what came back.
 *
 * Zero when fewer than 2 results came back — a single hit has no spread, and
 * neither does an empty set.
 *
 * Not a standard IR metric, but it's the diagnostic for your specific failure.
 * A 0.04 spread means the ranking is arbitrary even when the right chunk
 * happened to win; 0.112 means the embedding is genuinely discriminating.
 * Tracking it separates "the right answer won" from "the right answer won by
 * accident."
 *
 * Only comparable at a FIXED --threshold. Raising the threshold truncates the
 * low-scoring tail, which shrinks the spread mechanically without anything
 * having improved — so a threshold sweep will show spread falling and that
 * means nothing. Compare spread across corpus and query changes, not across
 * retrieval settings.
 */
function spread(results: MatchedChunk[]): number {
  if (results.length < 2) return 0;

  let maxScore = -Infinity;
  let minScore = Infinity;

  for (const result of results){
    maxScore = Math.max(maxScore, result.similarity);
    minScore = Math.min(minScore, result.similarity);
  }

  return maxScore - minScore;
}

/**
 * Score one case.
 *
 * A negative case (expect is empty) can't "hit" — there is nothing to hit — so
 * it scores rr = 1 when nothing came back and 0 otherwise. That convention lets
 * a negative contribute to the same average as a positive, which is what makes
 * "retrieve less" visible in MRR instead of silently free.
 */
function scoreCase(kase: GoldenCase, results: MatchedChunk[]): CaseResult {
  let hit = false, rr;
  
  // positive case
  if (kase.expect.length > 0){
    for (const result of results){
      for (const ex of kase.expect){
        if (matchesLabel(result, ex)){
          hit = true;
          break;
        }
      }
    }
    rr = reciprocalRank(results, kase.expect);
  }

  // negative case
  else {
    hit = false;
    rr = results.length == 0 ? 1 : 0;
  }

  const spreadResult = spread(results);

  let topSimilarity = 0;

  for (const result of results){
    topSimilarity = Math.max(topSimilarity, result.similarity)
  }

  return {
    id: kase.id,
    negative: kase.expect.length === 0,
    returned: results.length,
    hit: hit,
    rr: rr,
    spread: spreadResult,
    topSimilarity: topSimilarity
  }
}

/**
 * Roll the per-case results up.
 *
 * Consumes what scoreCase already produced — one CaseResult per golden case.
 * Never re-derives a score, never touches a chunk. Pure arithmetic.
 *
 * Takes scored CASES, not retrieved chunks — unlike the `results` in scoreCase
 * and spread above. The per-case chunk count lives on `kase.returned`.
 *
 * Only two of the five metrics are means over every case. The rest each have
 * their own population, which is why this partitions rather than running one
 * loop over a shared denominator:
 *
 *   mrr, meanReturned  all cases
 *   hitRate            positive cases only  (a negative case can never hit)
 *   cleanNegatives     negative cases only
 *   meanSpread         cases that returned 2+ chunks
 */
function summarize(cases: CaseResult[], label: string, k: number, threshold: number): Summary {
  const positives = cases.filter((kase) => !kase.negative);
  const negatives = cases.filter((kase) => kase.negative);
  // Spread needs two chunks to be a difference at all. Cases that returned
  // nothing would contribute a 0, which would make "retrieved nothing" read as
  // perfect discrimination — and raising the threshold produces more of them.
  const comparable = cases.filter((kase) => kase.returned >= 2);

  // Each population can independently be empty: a golden set with no negatives
  // yet, or a threshold high enough that nothing comes back anywhere.
  const fraction = (list: CaseResult[], predicate: (kase: CaseResult) => boolean) =>
    list.length === 0 ? 0 : list.filter(predicate).length / list.length;

  const mean = (list: CaseResult[], pick: (kase: CaseResult) => number) =>
    list.length === 0 ? 0 : list.reduce((total, kase) => total + pick(kase), 0) / list.length;

  return {
    label,
    k,
    threshold,
    hitRate: fraction(positives, (kase) => kase.hit),
    mrr: mean(cases, (kase) => kase.rr),
    cleanNegatives: fraction(negatives, (kase) => kase.returned === 0),
    meanSpread: mean(comparable, (kase) => kase.spread),
    meanReturned: mean(cases, (kase) => kase.returned),
  };
}

// ------------------------------------------------------------
// Runner + output
// ------------------------------------------------------------

// A label that resolves to no chunk is a broken test, not a retrieval failure —
// but it scores identically to one, so it would read as a regression and send
// you looking in the wrong place. Checked up front, against the corpus as
// actually ingested, so re-chunking or editing a lore file can't quietly rot
// the golden set.
async function validateLabels(cases: GoldenCase[]): Promise<void> {
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
  const { data, error } = await supabase
    .from('lore_chunks')
    .select('source_file, content, character')
    .eq('is_static', true);

  if (error) throw new Error(error.message);
  const chunks = data ?? [];

  const broken: string[] = [];
  for (const kase of cases) {
    for (const label of kase.expect) {
      const hits = chunks.filter(
        (chunk) => chunk.source_file === label.file && chunk.content.includes(label.contains)
      );
      if (hits.length !== 1) {
        broken.push(`${kase.id}: "${label.contains}" in ${label.file} matched ${hits.length} chunks, want 1`);
      } else if (hits[0].character !== kase.character) {
        broken.push(`${kase.id}: label lives in '${hits[0].character}' but the case searches '${kase.character}'`);
      }
    }
  }

  if (broken.length > 0) {
    throw new Error(`golden set has broken labels:\n  ${broken.join('\n  ')}`);
  }
}

async function runCase(
  kase: GoldenCase,
  k: number,
  threshold: number,
  hybrid: boolean,
  rrfK: number
): Promise<CaseResult> {
  // The same gate lib/chat.ts applies. Runs before embedding, so a greeting
  // costs neither an embedding call nor a query.
  if (!needsRetrieval(kase.query)) {
    return scoreCase(kase, []);
  }

  const embedding = await embedText(kase.query);
  // sessionId null = static lore only. Dynamic memory is per-playthrough and
  // can't be labelled ahead of time, so the golden set measures the base
  // corpus. Worth revisiting once a full run's chunks exist to label.
  //
  // Hybrid returns the true cosine in `similarity` alongside its RRF `score`,
  // so spread stays measured on the same scale as the vector-only baseline.
  const results = hybrid
    ? await matchLoreHybrid(embedding, kase.query, kase.character, null, k, rrfK)
    : await matchLoreChunks(embedding, kase.character, null, k, threshold);
  return scoreCase(kase, results);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function printCases(results: CaseResult[]): void {
  console.log('\ncase                     kind      returned  rank   spread  top');
  console.log('─'.repeat(68));

  for (const r of results) {
    // Negatives have no rank — their rr encodes "returned nothing", and
    // rendering that as 1/1 would read as a correct chunk winning the top slot.
    const rank = r.negative ? (r.returned === 0 ? 'clean' : 'noisy') : r.rr > 0 ? `1/${Math.round(1 / r.rr)}` : '—';
    console.log(
      r.id.padEnd(24) +
        (r.negative ? 'negative' : 'positive').padEnd(10) +
        String(r.returned).padEnd(10) +
        rank.padEnd(7) +
        r.spread.toFixed(3).padEnd(8) +
        r.topSimilarity.toFixed(3)
    );
  }
}

function printSummary(now: Summary, before: Summary | null): void {
  const delta = (current: number, previous: number | undefined, format: (n: number) => string) => {
    if (previous === undefined) return '';
    const diff = current - previous;
    if (Math.abs(diff) < 0.0005) return '  (unchanged)';
    return `  (${diff > 0 ? '+' : ''}${format(diff)} vs ${before!.label})`;
  };

  console.log(`\n=== ${now.label.split(' ')[0] === 'hybrid' ? now.label.split(' ').slice(0, 2).join(' ') : 'vector'}, k=${now.k}, threshold=${now.threshold} ===`);
  console.log(`  hit rate (positive)   ${pct(now.hitRate)}${delta(now.hitRate, before?.hitRate, pct)}`);
  console.log(`  MRR                   ${now.mrr.toFixed(3)}${delta(now.mrr, before?.mrr, (n) => n.toFixed(3))}`);
  console.log(`  clean negatives       ${pct(now.cleanNegatives)}${delta(now.cleanNegatives, before?.cleanNegatives, pct)}`);
  console.log(`  mean spread           ${now.meanSpread.toFixed(3)}${delta(now.meanSpread, before?.meanSpread, (n) => n.toFixed(3))}`);
  console.log(`  mean chunks returned  ${now.meanReturned.toFixed(1)}${delta(now.meanReturned, before?.meanReturned, (n) => n.toFixed(1))}`);
}

async function main() {
  const { k, threshold, save, hybrid, rrfK } = parseArgs();
  const cases = loadGoldenSet();
  await validateLabels(cases);

  if (cases.length < 10) {
    console.warn(
      `⚠  only ${cases.length} labelled cases — aim for ~20 before trusting a delta.\n` +
        `   Below that, one case flipping moves every number several points.\n`
    );
  }

  // Sequential rather than Promise.all: embedding is 100 rpm and this is not
  // on a latency path. Reading the cases in order is worth more than speed.
  const results: CaseResult[] = [];
  for (const kase of cases) {
    results.push(await runCase(kase, k, threshold, hybrid, rrfK));
  }

  const label = `${hybrid ? `hybrid rrf_k=${rrfK}` : 'vector'} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const summary = summarize(results, label, k, threshold);

  const before: Summary | null =
    existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) : null;

  printCases(results);
  printSummary(summary, before);

  if (save) {
    mkdirSync(join(process.cwd(), 'eval'), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(summary, null, 2));
    console.log(`\nbaseline written to eval/baseline.json (${label})`);
  } else if (!before) {
    console.log('\nno baseline yet — re-run with --save to record this as the reference point');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
