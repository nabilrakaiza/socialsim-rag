// Checks generateEventOutcome against the live API using a real event from
// events.json, with responses that should clearly grade high / mid / low —
// plus two adversarial ones (empty, and claiming virtue without describing
// an action) since those are exactly what a free-text box invites.

import 'dotenv/config';

import { generateEventOutcome } from '../lib/gemma';
import { loadEvents, affectedMeter } from '../lib/events';

const event = loadEvents().find((e) => e.id === 'rain_umbrella')!;
const character = affectedMeter(event);

const responses: { label: string; action: string }[] = [
  { label: 'clearly high', action: "Offer to share the umbrella and angle it over her more than me, then just keep walking and talking like it's not a big deal." },
  { label: 'clearly mid', action: "Tell her I've got an umbrella if she wants to walk under it." },
  { label: 'clearly low', action: "Put my umbrella up and head off, she'll figure it out." },
  { label: 'adversarial: empty', action: '' },
  { label: 'adversarial: claims virtue, no action', action: "I'm a really considerate and thoughtful person who always puts others first." },
];

async function main() {
  console.log(`event: ${event.id} — scoring against ${character}'s meter`);
  console.log(`grading criteria:\n  high: ${event.affection_outcomes.high}\n  mid:  ${event.affection_outcomes.mid}\n  low:  ${event.affection_outcomes.low}\n`);

  for (const { label, action } of responses) {
    const result = await generateEventOutcome({
      character: character as 'hiyori' | 'yuki',
      eventDescription: event.description,
      actionPrompt: event.player_action_prompt,
      outcomes: event.affection_outcomes,
      playerAction: action,
      currentAffection: 30,
      currentStage: 'Acquaintance',
    });
    console.log(`${label.padEnd(34)} -> tier ${result.tier.padEnd(5)} delta ${result.delta > 0 ? '+' : ''}${result.delta}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
