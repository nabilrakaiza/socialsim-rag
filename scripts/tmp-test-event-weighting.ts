// Checks the repeat weighting in resolveActivitySegment and that randomized
// details come back the same under the same seed. Pure logic — no DB, no API.

import {
  loadEvents,
  resolveActivitySegment,
  applyRandomizedDetails,
  findBeat,
  detailSeed,
  repeatWeight,
} from '../lib/events';

let failed = false;
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed = true;
}

// Share of each event among the rolls that fired one. Stranger / 0 affection /
// after lunch has exactly four eligible events, which makes the expected
// shares easy to work out by hand.
function shares(firedCounts: Record<string, number>, rolls = 40_000): Record<string, number> {
  const hits: Record<string, number> = {};
  let fired = 0;
  for (let i = 0; i < rolls; i++) {
    const result = resolveActivitySegment({
      segment: 'activity_after_lunch',
      currentStage: 'Stranger',
      affection: 0,
      yukiAffection: 0,
      firedTodayIds: [],
      firedCounts,
    });
    if (!result.firedEvent) continue;
    fired++;
    hits[result.event.id] = (hits[result.event.id] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(hits).map(([id, n]) => [id, n / fired]));
}

function expected(pool: string[], firedCounts: Record<string, number>): Record<string, number> {
  const weights = pool.map((id) => repeatWeight(firedCounts[id] ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  return Object.fromEntries(pool.map((id, i) => [id, weights[i] / total]));
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function compare(label: string, firedCounts: Record<string, number>) {
  const got = shares(firedCounts);
  const pool = Object.keys(got).sort();
  const want = expected(pool, firedCounts);
  console.log(`\n-- ${label} --`);
  for (const id of pool) {
    check(
      `${id} (fired ${firedCounts[id] ?? 0}x before)`,
      Math.abs(got[id] - want[id]) < 0.015,
      `got ${pct(got[id])}, expected ${pct(want[id])}`
    );
  }
  return pool;
}

const pool = compare('nothing fired yet: should be even', {});
check('pool is the four Stranger-tier events', pool.length === 4, pool.join(', '));
compare('same_class fired twice: should nearly vanish', { same_class: 2 });
compare('everything fired once except accidental_follow', {
  same_class: 1,
  met_with_friends_public: 1,
  yuki_econs_help: 1,
});
compare('all fired equally: level again, so even', Object.fromEntries(pool.map((id) => [id, 3])));

console.log('\n-- seeded details --');
const event = loadEvents().find((e) => e.id === 'met_with_friends_public')!;
const seed = detailSeed('session-a', 4);
const first = applyRandomizedDetails(event, seed);
const repeats = Array.from({ length: 50 }, () => applyRandomizedDetails(event, seed));
check(
  'same seed gives the same fill 50 times',
  repeats.every((r) => r.title === first.title && r.description === first.description),
  `${first.title} / ${first.description}`
);
check('no raw placeholder left', !/\[[^\]]+\]/.test(first.title + first.description));

const acrossSeeds = new Set(
  Array.from({ length: 40 }, (_, day) => applyRandomizedDetails(event, detailSeed('session-a', day)).description)
);
check('different days still vary', acrossSeeds.size > 1, `${acrossSeeds.size} distinct descriptions over 40 days`);

const unseeded = new Set(Array.from({ length: 40 }, () => applyRandomizedDetails(event).description));
check('unseeded stays random', unseeded.size > 1, `${unseeded.size} distinct`);

// The point of the seed: what the resolver showed the player and what a later
// lookup by id reconstructs must be the same text.
let shown: string | undefined;
for (let i = 0; i < 5000 && !shown; i++) {
  const result = resolveActivitySegment({
    segment: 'activity_after_lunch',
    currentStage: 'Stranger',
    affection: 0,
    yukiAffection: 0,
    firedTodayIds: [],
    firedCounts: {},
    detailSeed: seed,
  });
  if (result.firedEvent && result.event.id === event.id) shown = result.event.description;
}
const recalled = findBeat(event.id, loadEvents(), seed)?.beat.description;
check('findBeat recalls what the resolver showed', shown !== undefined && shown === recalled, `${recalled}`);

if (failed) process.exit(1);
