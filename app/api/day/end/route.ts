import { endDay } from '@/lib/orchestrator';
import type { EndDayStage } from '@/lib/orchestrator';
import { readJson, requireString } from '../../_shared';

// The slow one: grades every event the player answered, then runs the whole
// batch evaluation. Measured at ~1m40s. maxDuration is raised because Vercel's
// default function timeout would cut it off well before it finishes.
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
