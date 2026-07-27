'use client';

import { motion } from 'motion/react';
import { memo, useState } from 'react';
import type { ResolvedSegment } from '@/lib/orchestrator';

// What happens during a non-free segment. Two shapes: an event the player
// answers in free text, or flavor-only filler they simply read past.
//
// Neither is timed. Free segments are where the clock bites; an event is a
// narrative beat, and putting a countdown on it would push the player to
// answer badly rather than think.
// Memoised for the same reason as ChatPanel — see the note there.
export const SegmentStage = memo(function SegmentStage({
  resolved,
  onAnswer,
  onSkip,
  saving,
}: {
  resolved: ResolvedSegment;
  onAnswer: (text: string) => void;
  onSkip: () => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState('');
  const beat = resolved.subEvent ?? resolved.event;

  if (!beat) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-line bg-surface p-6"
      >
        <p className="text-sm text-muted">Nothing much happened.</p>
        <p className="mt-2 text-lg">{resolved.flavor}</p>
        <button
          onClick={onSkip}
          className="mt-6 rounded-lg border border-line px-4 py-2 text-sm hover:bg-line"
        >
          Continue
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-line bg-surface p-6"
    >
      {resolved.event && resolved.subEvent && (
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">{resolved.event.title}</p>
      )}
      <p className="leading-relaxed">{beat.description}</p>
      <p className="mt-4 text-sm text-muted">{beat.player_action_prompt}</p>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="Describe what you do…"
        className="mt-3 w-full resize-none rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => onAnswer(draft.trim())}
          disabled={saving || !draft.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Do it'}
        </button>
        <button
          onClick={onSkip}
          disabled={saving}
          className="text-sm text-muted underline-offset-4 hover:underline disabled:opacity-40"
        >
          Do nothing
        </button>
      </div>

      {/* Said plainly rather than hidden: ignoring an event is a real choice
          with a real cost, and the player should be able to make it knowingly. */}
      <p className="mt-3 text-xs text-muted">
        Walking away is a choice too — she’ll notice you didn’t engage.
      </p>
    </motion.div>
  );
});
