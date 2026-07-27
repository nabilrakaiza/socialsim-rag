import { endDay } from '@/lib/orchestrator';
import type { EndDayStage } from '@/lib/orchestrator';
import { readJson, requireString } from '../../_shared';

// The slow one: grades every event the player answered, then runs the whole
// batch evaluation. Measured between 1m40s and 4m24s across runs, with no
// retries or model failures in between — that spread is raw LLM latency.
//
// 300s is not a comfortable margin, it is the ceiling: Vercel's Hobby plan
// allows 300s as both the default AND the maximum (Pro goes to 800s). The
// slowest observed run used 264s of that — 88% — so a slower one returns a
// 504 and strands the player mid-day-end.
//
// The durable fix is splitting this into two requests (score events, then
// batch-eval) so neither approaches the cap. Until then this is a known risk,
// and the UI warns the player the wait can run to several minutes.
export const maxDuration = 300;

// Streamed as newline-delimited JSON rather than returned in one shot. A single
// response means well over a minute of silence, which is indistinguishable from
// a hang; this reports each phase as it actually starts, so what the player sees
// reflects real progress rather than a timed guess.
export async function POST(request: Request) {
  const encoder = new TextEncoder();

  let sessionId: string;
  try {
    const body = await readJson<{ sessionId?: string }>(request);
    sessionId = requireString(body.sessionId, 'sessionId');
  } catch (err) {
    // Bad input fails before the stream opens, so it can still be a plain error.
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));

      try {
        const result = await endDay(sessionId, (stage: EndDayStage) => send({ stage }));
        send({ result });
      } catch (err) {
        // The stream is already open by this point, so a failure travels as a
        // final line rather than an HTTP status the client stopped watching for.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[api] day/end', message);
        send({ error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      // Long-lived response — stop any proxy buffering it into a single chunk,
      // which would defeat the point of streaming progress at all.
      'cache-control': 'no-cache, no-transform',
    },
  });
}
