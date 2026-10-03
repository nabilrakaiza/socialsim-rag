// Throwaway benchmark: gemini-3.5-flash-lite vs gemini-3.1-flash-lite on the
// real dialogue prompt. Re-checks the "3.5-lite times out entirely on this key"
// note at the top of lib/gemma.ts's model chains.
//
// The prompt is the one generateDialogue actually sends, captured off the wire
// rather than rebuilt here, so the two can't drift apart.

import 'dotenv/config';

import { GoogleGenAI } from '@google/genai';
import { embedText } from '../lib/embeddings';
import { matchLoreChunks } from '../lib/supabase';
import { generateDialogue, type DialogueTurn } from '../lib/gemma';

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const;
const RUNS = Number(process.env.RUNS ?? 5);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 60_000);

const playerMessage = 'hey, what did you get up to this weekend?';
const history: DialogueTurn[] = [
  { role: 'player', content: 'oh hey, is this seat taken?' },
  { role: 'npc', content: "It's a canteen, not a reserved table. Sit if you want." },
  { role: 'player', content: 'thanks. the queue for the chicken rice was insane today' },
  { role: 'npc', content: 'It always is at this hour. You get used to timing it.' },
];

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' });

// Runs generateDialogue once with fetch stubbed out, so the prompt it would
// have sent is returned instead of being spent on a real call.
async function captureRealPrompt(): Promise<string> {
  const queryEmbedding = await embedText(playerMessage);
  const chunks = await matchLoreChunks(queryEmbedding, 'hiyori', null, 5, 0.5);
  console.log(`retrieved ${chunks.length} chunks for the prompt`);

  const realFetch = globalThis.fetch;
  let captured = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(':generateContent')) return realFetch(input, init);

    const body = JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] };
    captured = body.contents[0].parts[0].text;
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"reply":"stub"}' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    await generateDialogue('hiyori', playerMessage, chunks, history, 'Acquaintance', {
      day: 3,
      inGameHour: 12.5,
      activity: 'lunch',
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  if (!captured) throw new Error('prompt capture failed — the SDK did not go through global fetch');
  return captured;
}

interface Run {
  ok: boolean;
  ms: number;
  validJson: boolean;
  reply?: string;
  outTokens?: number;
  thoughtTokens?: number;
  promptTokens?: number;
  error?: string;
}

function isValidReply(text: string): { valid: boolean; reply?: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { reply?: unknown };
    return typeof parsed.reply === 'string' ? { valid: true, reply: parsed.reply } : { valid: false };
  } catch {
    return { valid: false };
  }
}

async function timeOne(model: string, prompt: string): Promise<Run> {
  const started = performance.now();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { httpOptions: { timeout: TIMEOUT_MS } },
    });
    const ms = performance.now() - started;
    const text = response.text ?? '';
    const { valid, reply } = isValidReply(text);
    return {
      ok: text.length > 0,
      ms,
      validJson: valid,
      reply: reply ?? text.slice(0, 200),
      outTokens: response.usageMetadata?.candidatesTokenCount,
      thoughtTokens: response.usageMetadata?.thoughtsTokenCount,
      promptTokens: response.usageMetadata?.promptTokenCount,
      error: text.length > 0 ? undefined : 'returned no text',
    };
  } catch (err) {
    return { ok: false, ms: performance.now() - started, validJson: false, error: (err as Error).message.slice(0, 300) };
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  // Is each id even a model this key can see? Separates "wrong/retired id"
  // from "exists but slow".
  for (const model of MODELS) {
    try {
      const info = await ai.models.get({ model });
      console.log(`${model}: visible (${info.displayName ?? info.name})`);
    } catch (err) {
      console.log(`${model}: models.get FAILED — ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // A trivial prompt first: if this fails too, the problem isn't prompt size.
  console.log('\n-- trivial prompt ("Reply with the single word: ok") --');
  for (const model of MODELS) {
    const run = await timeOne(model, 'Reply with the single word: ok');
    console.log(`${model}: ${run.ok ? secs(run.ms) : `FAILED after ${secs(run.ms)} — ${run.error}`}`);
  }

  const prompt = await captureRealPrompt();
  console.log(`\n-- real dialogue prompt (${prompt.length} chars), ${RUNS} runs each, interleaved, ${TIMEOUT_MS / 1000}s timeout --`);

  const results: Record<string, Run[]> = Object.fromEntries(MODELS.map((m) => [m, []]));
  const givenUp = new Set<string>();

  for (let i = 0; i < RUNS; i++) {
    for (const model of MODELS) {
      if (givenUp.has(model)) continue;
      const run = await timeOne(model, prompt);
      results[model].push(run);
      console.log(
        run.ok
          ? `run ${i + 1} ${model}: ${secs(run.ms)}  json=${run.validJson}  out=${run.outTokens} thought=${run.thoughtTokens ?? 0}\n      ${run.reply}`
          : `run ${i + 1} ${model}: FAILED after ${secs(run.ms)} — ${run.error}`
      );
      // Two straight failures from a cold start is the old "times out entirely"
      // result; no point burning three more timeouts to confirm it.
      if (results[model].length === 2 && results[model].every((r) => !r.ok)) {
        givenUp.add(model);
        console.log(`      (${model}: 2/2 failed, skipping its remaining runs)`);
      }
    }
  }

  // End-of-day batch work fires ~9 calls at once, so a model that is quick one
  // at a time but 429s under a burst is no use to it.
  const BURST = Number(process.env.BURST ?? 9);
  console.log(`\n-- burst: ${BURST} concurrent calls per model --`);
  for (const model of MODELS) {
    if (givenUp.has(model)) continue;
    const started = performance.now();
    const burst = await Promise.all(Array.from({ length: BURST }, () => timeOne(model, prompt)));
    const wall = performance.now() - started;
    const failed = burst.filter((r) => !r.ok);
    const slowest = Math.max(...burst.map((r) => r.ms));
    console.log(
      `${model}: ${BURST - failed.length}/${BURST} ok, valid JSON ${burst.filter((r) => r.validJson).length}/${BURST}, wall ${secs(wall)}, slowest ${secs(slowest)}`
    );
    for (const error of new Set(failed.map((r) => r.error))) console.log(`      failure: ${error}`);
  }

  console.log('\n-- summary --');
  for (const model of MODELS) {
    const runs = results[model];
    const good = runs.filter((r) => r.ok);
    if (good.length === 0) {
      console.log(`${model}: 0/${runs.length} succeeded`);
      continue;
    }
    const times = good.map((r) => r.ms).sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const median = times[Math.floor(times.length / 2)];
    const avg = (pick: (r: Run) => number | undefined) =>
      Math.round(good.reduce((a, r) => a + (pick(r) ?? 0), 0) / good.length);
    console.log(
      `${model}: ${good.length}/${runs.length} ok | mean ${secs(mean)} median ${secs(median)} min ${secs(times[0])} max ${secs(times[times.length - 1])}` +
        ` | valid JSON ${good.filter((r) => r.validJson).length}/${good.length}` +
        ` | avg tokens: prompt ${avg((r) => r.promptTokens)}, out ${avg((r) => r.outTokens)}, thought ${avg((r) => r.thoughtTokens)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
