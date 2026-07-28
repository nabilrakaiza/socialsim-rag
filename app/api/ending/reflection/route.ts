import { buildEndingReflection } from '@/lib/ending-reflection';
import { fail, ok, readJson, requireString } from '../../_shared';

// Two prose generations, both on the fast model, so this is seconds rather
// than the minutes end-of-day takes.
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const body = await readJson<{ sessionId?: string }>(request);
    return ok(await buildEndingReflection(requireString(body.sessionId, 'sessionId')));
  } catch (err) {
    return fail(err);
  }
}
