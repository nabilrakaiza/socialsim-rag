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
        className="relative overflow-hidden rounded-[10px] border border-line bg-card p-6"
      >
        <div className="absolute inset-x-0 top-0 h-0.5 bg-muted opacity-40" />
        <span className="font-mono text-xs tracking-[0.12em] text-muted">// nothing much</span>
        <p className="mt-3 text-lg">{resolved.flavor}</p>
        <button
          onClick={onSkip}
          className="mt-6 rounded-[10px] border border-line px-5 py-2 font-mono text-sm transition-colors hover:border-mint hover:text-mint"
        >
          Continue →
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-[10px] border border-line bg-card p-6"
    >
      <div className="absolute inset-x-0 top-0 h-0.5 bg-violet opacity-60" />
      <span className="font-mono text-xs tracking-[0.12em] text-violet">
        // {resolved.event && resolved.subEvent ? resolved.event.title.toLowerCase() : 'something happens'}
      </span>
      <p className="mt-3 leading-[1.7]">{beat.description}</p>
      <p className="mt-4 text-sm text-muted">{beat.player_action_prompt}</p>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder="Describe what you do…"
        className="mt-3 w-full resize-none rounded-[10px] border border-line bg-canvas px-3 py-2 text-sm outline-none transition-colors focus:border-violet"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => onAnswer(draft.trim())}
          disabled={saving || !draft.trim()}
          className="rounded-[10px] bg-violet px-5 py-2 font-mono text-sm text-white transition-shadow hover:glow-violet disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Do it →'}
        </button>
        <button
          onClick={onSkip}
          disabled={saving}
          className="font-mono text-sm text-muted transition-colors hover:text-mint disabled:opacity-40"
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
