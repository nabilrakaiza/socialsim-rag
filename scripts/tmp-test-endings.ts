// Checks checkEnding against every boundary in events.json's `endings`
// triggers, and confirms each id it can return actually exists in the data.

import { checkEnding, TOTAL_GAME_DAYS, type EndingId } from '../lib/endings';
import { readFileSync } from 'fs';
import { join } from 'path';

const endingsInData: Record<string, { title: string }> = JSON.parse(
  readFileSync(join(process.cwd(), 'lore', 'events.json'), 'utf-8')
).endings;

interface Case {
  label: string;
  input: Parameters<typeof checkEnding>[0];
  expect: EndingId | null;
}

const cases: Case[] = [
  // confession — affection decides how it lands, day is irrelevant
  { label: 'confess at 80 (good boundary)', input: { currentDay: 12, affection: 80, yukiAffection: 0, confessed: true }, expect: 'good_end' },
  { label: 'confess at 79 (just under good)', input: { currentDay: 12, affection: 79, yukiAffection: 0, confessed: true }, expect: 'friend_zone_end' },
  { label: 'confess at 40 (friend-zone floor)', input: { currentDay: 12, affection: 40, yukiAffection: 0, confessed: true }, expect: 'friend_zone_end' },
  { label: 'confess at 39 (just under)', input: { currentDay: 12, affection: 39, yukiAffection: 0, confessed: true }, expect: 'bad_end' },
  { label: 'confess at 0', input: { currentDay: 1, affection: 0, yukiAffection: 0, confessed: true }, expect: 'bad_end' },
  { label: 'confess on day 1 at 100', input: { currentDay: 1, affection: 100, yukiAffection: 0, confessed: true }, expect: 'good_end' },
  // confession outranks Yuki's route even at max yuki affection
  { label: 'confess while yuki at 100', input: { currentDay: 30, affection: 90, yukiAffection: 100, confessed: true }, expect: 'good_end' },

  // no confession — game continues until the clock runs out
  { label: 'day 29, high affection, no confession', input: { currentDay: 29, affection: 95, yukiAffection: 0, confessed: false }, expect: null },
  { label: 'day 29, yuki already at 100', input: { currentDay: 29, affection: 0, yukiAffection: 100, confessed: false }, expect: null },
  { label: 'day 1, nothing happening', input: { currentDay: 1, affection: 0, yukiAffection: 0, confessed: false }, expect: null },

  // clock runs out
  { label: 'day 30, yuki at 70 (secret boundary)', input: { currentDay: 30, affection: 0, yukiAffection: 70, confessed: false }, expect: 'secret_end' },
  { label: 'day 30, yuki at 69 (just under)', input: { currentDay: 30, affection: 0, yukiAffection: 69, confessed: false }, expect: 'too_late_end' },
  { label: 'day 30, high hiyori affection but never confessed', input: { currentDay: 30, affection: 99, yukiAffection: 0, confessed: false }, expect: 'too_late_end' },
];

let failures = 0;
for (const c of cases) {
  const actual = checkEnding(c.input);
  const ok = actual === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.label.padEnd(45)} -> ${actual ?? 'null'}${ok ? '' : `  (expected ${c.expect ?? 'null'})`}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);

// every id the function can return must exist in events.json
const reachable: EndingId[] = ['good_end', 'friend_zone_end', 'bad_end', 'too_late_end', 'secret_end'];
const missing = reachable.filter((id) => !(id in endingsInData));
const orphaned = Object.keys(endingsInData).filter((id) => !reachable.includes(id as EndingId));
console.log('ending ids missing from events.json:', missing.length ? missing : 'none');
console.log('endings in events.json the code can never return:', orphaned.length ? orphaned : 'none');
console.log('TOTAL_GAME_DAYS:', TOTAL_GAME_DAYS);

if (failures > 0) process.exitCode = 1;
