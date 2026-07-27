import {
  loadEvents,
  resolveActivitySegment,
  checkExtendedEventTrigger,
  EXTENDED_EVENT_DAILY_CHANCE,
} from '../lib/events';

const events = loadEvents();
console.log('total events loaded:', events.length);
console.log('extended events:', events.filter((e) => e.type === 'extended_event').length);

// ============================================================
// resolveActivitySegment — regression check after the meetsGates refactor
// ============================================================
console.log('\n--- 200 rolls, activity_after_lunch, stranger/0/0 ---');
const earlyGameCounts: Record<string, number> = {};
for (let i = 0; i < 200; i++) {
  const result = resolveActivitySegment({
    segment: 'activity_after_lunch',
    currentStage: 'Stranger',
    affection: 0,
    yukiAffection: 0,
  });
  const key = result.firedEvent ? `EVENT:${result.event.id}` : 'flavor';
  earlyGameCounts[key] = (earlyGameCounts[key] ?? 0) + 1;
}
console.log(earlyGameCounts);
const eventHits = Object.entries(earlyGameCounts)
  .filter(([k]) => k.startsWith('EVENT:'))
  .reduce((sum, [, v]) => sum + v, 0);
console.log(`event fire rate: ${eventHits}/200 (expected ~70%)`);
console.log('no extended events leaked in:', !Object.keys(earlyGameCounts).some((k) => {
  const id = k.replace('EVENT:', '');
  return events.find((e) => e.id === id)?.type === 'extended_event';
}));

// ============================================================
// checkExtendedEventTrigger
// ============================================================
function collectArcs(input: Parameters<typeof checkExtendedEventTrigger>[0], n: number) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const arc = checkExtendedEventTrigger(input);
    const key = arc ? arc.id : '(none)';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

console.log('\n--- day 1, stranger/0/0, nothing used (1000 rolls) ---');
const day1 = collectArcs(
  { currentDay: 1, currentStage: 'Stranger', affection: 0, yukiAffection: 0, usedExtendedEventIds: [] },
  1000
);
console.log(day1);
const day1Fires = 1000 - (day1['(none)'] ?? 0);
console.log(`trigger rate: ${day1Fires}/1000 (expected ~${EXTENDED_EVENT_DAILY_CHANCE * 100}%)`);
console.log('yuki_econs_crunch blocked at yukiAffection=0:', !('yuki_econs_crunch' in day1), '(expected true)');

console.log('\n--- same, but yukiAffection=10 (yuki gate now met) ---');
const withYuki = collectArcs(
  { currentDay: 1, currentStage: 'Stranger', affection: 0, yukiAffection: 10, usedExtendedEventIds: [] },
  1000
);
console.log(withYuki);
console.log('yuki_econs_crunch now appears:', 'yuki_econs_crunch' in withYuki, '(expected true)');

console.log('\n--- day 28, friend/60/60 — long arcs must not fit ---');
const lateDay = collectArcs(
  { currentDay: 28, currentStage: 'Friend', affection: 60, yukiAffection: 60, usedExtendedEventIds: [] },
  1000
);
console.log(lateDay);
const tooLong = Object.keys(lateDay)
  .filter((k) => k !== '(none)')
  .filter((id) => {
    const e = events.find((ev) => ev.id === id)!;
    return 28 + e.duration_days - 1 > 30;
  });
console.log('arcs that would overrun day 30:', tooLong.length ? tooLong : 'none (expected none)');

console.log('\n--- day 30, friend/60/60 — only 1-day arcs could fit (there are none) ---');
console.log(collectArcs(
  { currentDay: 30, currentStage: 'Friend', affection: 60, yukiAffection: 60, usedExtendedEventIds: [] },
  200
));

console.log('\n--- day 1, stranger/0/0, both eligible arcs already used ---');
console.log(collectArcs(
  {
    currentDay: 1,
    currentStage: 'Stranger',
    affection: 0,
    yukiAffection: 0,
    usedExtendedEventIds: ['orientation_committee', 'hall_sports_tournament'],
  },
  200
));
