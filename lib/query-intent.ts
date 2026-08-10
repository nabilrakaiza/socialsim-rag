// ============================================================
// lib/query-intent.ts
//
// Does this message need memory at all?
//
// Measured against eval/retrieval-golden.json, six of 23 cases are greetings
// and acknowledgements that should retrieve NOTHING — and all six returned a
// full set of chunks, handed to the model under the heading "RELEVANT MEMORY
// (things Hiyori knows)". Five unrelated diary entries presented as fact is a
// worse prompt than no memory at all.
//
// Two cheaper approaches were measured first and both failed:
//
//   cosine similarity  greetings scored 0.515-0.592, short real questions
//                      0.547-0.574 — the ranges overlap, and two greetings
//                      outscored every real question
//   fused RRF score    best possible cut keeps 16/17 positives but still
//                      admits 3/6 greetings
//
// Neither population is separable by score, so this decides from the message
// itself. Deliberately a lexical rule and not an LLM call: chat already runs
// ~14s, and spending a round trip to recognise "morning" is not a trade worth
// making.
// ============================================================

// Words that cannot refer to anything a character knows: English function
// words plus the closed classes of conversational speech — greetings,
// farewells, acknowledgements, politeness markers, laughter.
//
// Grouped by class rather than as one flat list, because the classes are what
// justify membership. Adding a word because it happens to appear in a failing
// test case is how this kind of rule quietly overfits to its own fixtures.
const FUNCTION_WORDS = [
  'a', 'about', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if',
  'in', 'is', 'it', 'its', 'just', 'me', 'my', 'not', 'of', 'on', 'or', 'so', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'too', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you',
  'your', 'im', 'ive', 'youre', 'its', 'dont', 'u', 's', 't', 'm', 're', 'll', 've',
];

const GREETINGS = ['hi', 'hii', 'hello', 'hey', 'heyy', 'yo', 'morning', 'afternoon', 'evening', 'sup'];

const FAREWELLS = ['bye', 'byebye', 'goodbye', 'night', 'nite', 'cya', 'later', 'gtg'];

const ACKNOWLEDGEMENTS = [
  'ok', 'okay', 'okok', 'k', 'kk', 'yeah', 'yea', 'yep', 'yup', 'ya', 'no', 'nope', 'nah',
  'sure', 'right', 'true', 'cool', 'nice', 'great', 'good', 'fine', 'alright', 'fair',
  'enough', 'guess', 'sounds', 'sound', 'oh', 'ah', 'ahh', 'hm', 'hmm', 'well', 'anyway',
];

const POLITENESS = ['thanks', 'thank', 'thx', 'ty', 'please', 'pls', 'sorry', 'oops', 'np', 'welcome'];

const LAUGHTER = ['haha', 'hahaha', 'hah', 'hehe', 'lol', 'lmao', 'lmfao', 'xd'];

const FILLER = new Set([
  ...FUNCTION_WORDS,
  ...GREETINGS,
  ...FAREWELLS,
  ...ACKNOWLEDGEMENTS,
  ...POLITENESS,
  ...LAUGHTER,
]);

// Multi-word farewells, which token filtering alone can't catch: "see you
// tomorrow" leaves "tomorrow", a word that carries real meaning in other
// messages ("what are you doing tomorrow"). Anchored to the start of the
// message so "did you see her yesterday" is untouched.
const FAREWELL_PHRASES = [
  'see you', 'see ya', 'seeya', 'talk to you', 'talk later', 'catch you',
  'good night', 'goodnight', 'good morning', 'good evening',
];

function normalize(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the message contains at least one word that could refer to
 * something a character knows.
 *
 * The test is subtractive rather than a pattern match: strip every word that
 * carries no information need and see whether anything is left. "sorry i'm
 * late" keeps "late" and retrieves — the chunk naming lateness as a
 * deal-breaker is exactly what should ground that reply — while "sorry!" alone
 * keeps nothing and doesn't.
 */
export function needsRetrieval(message: string): boolean {
  const normalized = normalize(message);
  if (normalized.length === 0) return false;

  if (FAREWELL_PHRASES.some((phrase) => normalized.startsWith(phrase))) return false;

  return normalized.split(' ').some((token) => !FILLER.has(token));
}
