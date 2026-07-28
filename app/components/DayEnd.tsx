'use client';

import { motion } from 'motion/react';
import type { EndDayResult } from '@/lib/orchestrator';

export interface DayRecapEntry {
  title: string;
  answered: boolean;
}

// Deliberately shows no numbers. The affection meter is never exposed — it's
// meant to be inferred from how the characters behave — and the relationship
// stage would leak nearly as much, so neither appears here.
//
// What the recap gives instead is memory: what happened today and whether the
// player engaged with it. That's information they already had, presented back.
export function DayEnd({
  day,
  recap,
  result,
  progress,
  error,
  onRetry,
  onContinue,
}: {
  day: number;
  recap: DayRecapEntry[];
  result: EndDayResult | null;
  progress: string | null;
  error: string | null;
  onRetry: () => void;
  onContinue: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="relative mx-auto max-w-lg overflow-hidden rounded-[10px] border border-line bg-card p-8 text-center"
    >
      <div className="absolute inset-x-0 top-0 h-0.5 bg-violet opacity-60" />
      <p className="font-mono text-xs tracking-[0.12em] text-violet">// day {day}</p>
      <h2 className="mt-2 font-mono text-2xl font-bold">The day ends</h2>

      {recap.length > 0 && (
        <ul className="mt-6 space-y-1 text-left text-sm">
          {recap.map((entry, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className={entry.answered ? 'text-mint' : 'text-muted/50'}>
                {entry.answered ? '●' : '○'}
              </span>
              <span className={entry.answered ? '' : 'text-muted'}>{entry.title}</span>
            </li>
          ))}
        </ul>
      )}

      {/* End of day is minutes of sequential LLM work and can genuinely fail —
          a timeout at the platform's ceiling, a dropped connection mid-stream.
          Without a way back the player was stranded on a panel that said
          "settling the day…" forever. Retrying is safe: scored beats already
          carry their delta, and the batch eval is keyed to the same day. */}
      {error && !result && (
        <div className="mt-8">
          <p className="font-mono text-sm text-red-400">the day didn&rsquo;t settle</p>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <button
            onClick={onRetry}
            className="mt-5 rounded-[10px] border border-line px-5 py-2 font-mono text-sm transition-colors hover:border-mint hover:text-mint"
          >
            Try again →
          </button>
        </div>
      )}

      {!result && !error && (
        <div className="mt-8">
          <p className="text-sm text-muted">
            <span className="animate-breathe">{progress ?? 'settling the day…'}</span>
          </p>
          {/* Stated plainly rather than left to a spinner. Measured runs have
              ranged from under two minutes to nearly four and a half, so an
              honest upper bound beats an optimistic one — a player who expects
              90 seconds and waits four assumes it has broken. */}
          <p className="mt-3 text-xs text-muted/70">
            Everyone&rsquo;s catching up on their day. This can take up to about five
            minutes — you can leave this open.
          </p>
        </div>
      )}

      {result && (
        <div className="mt-8">
          <p className="text-sm text-muted">
            {result.diaryGenerated
              ? 'Somewhere across campus, a diary gets a new entry.'
              : 'Tomorrow, then.'}
          </p>
          <button
            onClick={onContinue}
            className="mt-6 rounded-[10px] bg-violet px-6 py-2.5 font-mono text-sm font-medium text-white transition-shadow hover:glow-violet"
          >
            {result.ending ? 'See how it ends' : `Begin day ${day + 1}`}
          </button>
        </div>
      )}
    </motion.div>
  );
}
