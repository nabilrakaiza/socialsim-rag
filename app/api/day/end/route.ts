import { endDay } from '@/lib/orchestrator';
import { fail, ok, readJson, requireString } from '../../_shared';

// The slow one: scores every event the player answered, then runs the whole
// batch evaluation. Several sequential LLM calls, so expect tens of seconds.
// maxDuration is raised because Vercel's default function timeout would cut
// this off well before it finishes.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await readJson<{ sessionId?: string }>(request);
    return ok(await endDay(requireString(body.sessionId, 'sessionId')));
  } catch (err) {
    return fail(err);
  }
}
