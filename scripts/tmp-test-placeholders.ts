// Confirms randomized_details actually fills the [placeholder] slots, and that
// no event can reach the player or the grader with raw bracket text.
import { loadEvents, applyRandomizedDetails } from '../lib/events';

const events = loadEvents();
const withPlaceholders = events.filter((e) =>
  /\[[^\]]+\]/.test(`${e.title} ${e.description} ${e.player_action_prompt}`)
);

console.log(`events containing placeholders: ${withPlaceholders.map((e) => e.id).join(', ')}\n`);

let leftovers = 0;
for (const event of withPlaceholders) {
  // Several draws, since each fill is a random pick — one clean run could be luck.
  for (let i = 0; i < 20; i++) {
    const filled = applyRandomizedDetails(event);
    const combined = `${filled.title} ${filled.description} ${filled.player_action_prompt}`;
    const remaining = combined.match(/\[[^\]]+\]/g);
    if (remaining) {
      leftovers++;
      console.log(`  LEFTOVER in ${event.id}: ${remaining.join(', ')}`);
      break;
    }
  }
  const sample = applyRandomizedDetails(event);
  console.log(`${event.id}\n  title: ${sample.title}\n  desc:  ${sample.description.slice(0, 110)}…\n`);
}

// Variety check — a fill that always returns the same option isn't randomising.
const target = events.find((e) => e.id === 'met_with_friends_public')!;
const seen = new Set(Array.from({ length: 40 }, () => applyRandomizedDetails(target).title));
console.log(`distinct titles across 40 draws of met_with_friends_public: ${seen.size}`);

console.log(`\n${leftovers === 0 ? 'PASS — no raw placeholders survive' : `FAIL — ${leftovers} events still leak placeholders`}`);
if (leftovers > 0) process.exitCode = 1;
