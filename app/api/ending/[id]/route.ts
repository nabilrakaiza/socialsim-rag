import { readFileSync } from 'fs';
import { join } from 'path';
import { fail, ok } from '../../_shared';

interface Ending {
  id: string;
  title: string;
  description: string;
  scene: string;
}

// The ending prose lives in lore/events.json, which is server-side content.
// Rather than ship the whole file to the client, the ending id comes back from
// endDay/confess and the text is fetched here once the run is actually over.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const raw = readFileSync(join(process.cwd(), 'lore', 'events.json'), 'utf-8');
    const endings = (JSON.parse(raw) as { endings: Record<string, Ending> }).endings;

    const ending = endings[id];
    if (!ending) {
      return fail(new Error(`unknown ending: ${id}`), 404);
    }
    return ok(ending);
  } catch (err) {
    return fail(err);
  }
}
