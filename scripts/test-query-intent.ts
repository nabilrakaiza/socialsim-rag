// Held-out check for lib/query-intent.ts.
//
// needsRetrieval was written while looking at the six negative cases in
// eval/retrieval-golden.json, so scoring 6/6 there proves nothing on its own —
// it's the fixture the rule was built against. None of the messages below
// appear in the golden set.
//
// The two error kinds are not equally bad:
//
//   a greeting that retrieves    wasteful, and puts five unrelated chunks in
//                                the prompt as fact — the old behaviour, so a
//                                miss here is no worse than before this existed
//   a question that doesn't      actively harmful: the character loses access
//                                to something she genuinely knows
//
// So false-negatives on the skip side are tolerable and false-positives are
// not. Run with: npx tsx scripts/test-query-intent.ts

import { needsRetrieval } from '../lib/query-intent';

// Should NOT retrieve — no information need.
const SKIP = [
  'hey', 'hello!', 'hi there', 'yo', 'sup',
  'lol', 'haha', 'hehe', 'lmao',
  'ok', 'okay!', 'ok cool', 'alright', 'yeah', 'yep', 'nah',
  'night!', 'good night', 'see ya', 'talk to you later', 'bye',
  'thanks', 'thank you', 'ty', 'np', 'sorry!',
  'yeah true', 'fair enough', 'sounds good', 'oh ok', 'hmm', 'right',
];

// MUST retrieve — each names something a character could know.
const RETRIEVE = [
  "what's your favourite food",
  'do you cycle on weekends',
  'how was the lab today',
  'tell me about Shiori',
  'are you free saturday',
  'did you finish the report',
  'you seem quiet today',
  'what module are you taking',
  'is Marcus someone you knew',
  'how are your succulents',
  'want to get coffee',
  'did Yuki say anything',
  'hows your brother',
  'you like matcha right',
  'sorry about the lab thing',
  'ok so about the group project',
  'haha did you see the presentation',
  'night, good luck with the report tomorrow',
];

function run() {
  const wrongSkip = RETRIEVE.filter((m) => !needsRetrieval(m));
  const wrongKeep = SKIP.filter((m) => needsRetrieval(m));

  console.log(`should retrieve: ${RETRIEVE.length - wrongSkip.length}/${RETRIEVE.length}`);
  for (const m of wrongSkip) console.log(`  HARMFUL — blocked a real question: "${m}"`);

  console.log(`should skip:     ${SKIP.length - wrongKeep.length}/${SKIP.length}`);
  for (const m of wrongKeep) console.log(`  missed (falls back to old behaviour): "${m}"`);

  // Only the harmful direction fails the run. A greeting that slips through
  // costs a retrieval that would have happened anyway.
  if (wrongSkip.length > 0) {
    console.log('\nFAIL — a message with a real information need was blocked.');
    process.exitCode = 1;
  } else {
    console.log('\nPASS — no real question was blocked.');
  }
}

run();
