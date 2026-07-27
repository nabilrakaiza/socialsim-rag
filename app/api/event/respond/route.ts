import { recordEventResponse } from '@/lib/orchestrator';
import { fail, ok, readJson, requireString } from '../../_shared';

// Persists only — scoring waits for endDay so the live segment clock never
// blocks on an LLM round trip.
export async function POST(request: Request) {
  try {
    const body = await readJson<{ eventLogId?: string; playerAction?: string }>(request);
    await recordEventResponse(
      requireString(body.eventLogId, 'eventLogId'),
      requireString(body.playerAction, 'playerAction')
    );
    return ok({ recorded: true });
  } catch (err) {
    return fail(err);
  }
}
