import { startDay } from '@/lib/orchestrator';
import { fail, ok, readJson, requireString } from '../../_shared';

export async function POST(request: Request) {
  try {
    const body = await readJson<{ sessionId?: string }>(request);
    return ok(await startDay(requireString(body.sessionId, 'sessionId')));
  } catch (err) {
    return fail(err);
  }
}
