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
  onContinue,
}: {
  day: number;
  recap: DayRecapEntry[];
  result: EndDayResult | null;
  progress: string | null;
  onContinue: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mx-auto max-w-lg rounded-xl border border-line bg-surface p-8 text-center"
    >
      <p className="text-xs uppercase tracking-widest text-muted">Day {day}</p>
      <h2 className="mt-1 text-2xl">The day ends</h2>

      {recap.length > 0 && (
        <ul className="mt-6 space-y-1 text-left text-sm">
          {recap.map((entry, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className={entry.answered ? 'text-accent' : 'text-muted/50'}>
                {entry.answered ? '●' : '○'}
              </span>
              <span className={entry.answered ? '' : 'text-muted'}>{entry.title}</span>
            </li>
          ))}
        </ul>
      )}

      {!result && (
        <p className="mt-8 text-sm text-muted">
          <span className="animate-breathe">{progress ?? 'settling the day…'}</span>
        </p>
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
            className="mt-6 rounded-lg bg-accent px-5 py-2 text-sm text-white"
          >
            {result.ending ? 'See how it ends' : `Begin day ${day + 1}`}
          </button>
        </div>
      )}
    </motion.div>
  );
}
