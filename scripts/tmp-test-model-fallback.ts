// Throwaway check that the dialogue chain really falls from
// gemini-3.5-flash-lite to gemini-3.1-flash-lite — once when 3.5 is out of
// quota (429) and once when it hangs. 3.5's requests are faked at the fetch
// layer; everything else, including the 3.1 call, is the live API.

import 'dotenv/config';

import { generateDialogue } from '../lib/gemma';

type Sabotage = 'quota' | 'hang' | 'none';

const realFetch = globalThis.fetch;
let sabotage: Sabotage = 'none';
let modelsCalled: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const model = url.match(/models\/([^:]+):generateContent/)?.[1];
  if (!model) return realFetch(input, init);
  modelsCalled.push(model);

  if (model === 'gemini-3.5-flash-lite' && sabotage === 'quota') {
    return new Response(
      JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded (simulated)' } }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  }

  if (model === 'gemini-3.5-flash-lite' && sabotage === 'hang') {
    // Never answers; only the caller's abort signal ends it. The interval
    // stands in for the open socket a real request would hold: the SDK unrefs
    // its timeout timer, so with nothing else pending Node would just exit.
    return new Promise<Response>((_, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      init?.signal?.addEventListener('abort', () => {
        clearInterval(keepAlive);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  }

  return realFetch(input, init);
}) as typeof fetch;

async function scenario(mode: Sabotage, expected: string[]): Promise<boolean> {
  sabotage = mode;
  modelsCalled = [];
  const started = performance.now();
  const result = await generateDialogue('hiyori', 'morning. you look tired', [], [], 'Stranger', {
    day: 1,
    inGameHour: 7.5,
  });
  const secs = ((performance.now() - started) / 1000).toFixed(1);

  const pass = JSON.stringify(modelsCalled) === JSON.stringify(expected) && result.reply.length > 0;
  console.log(`${pass ? 'PASS' : 'FAIL'} [3.5 ${mode}] ${secs}s — called: ${modelsCalled.join(' -> ')}`);
  console.log(`      reply: ${result.reply}`);
  return pass;
}

async function main() {
  const results = [
    await scenario('none', ['gemini-3.5-flash-lite']),
    await scenario('quota', ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']),
    await scenario('hang', ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']),
  ];
  if (results.includes(false)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
