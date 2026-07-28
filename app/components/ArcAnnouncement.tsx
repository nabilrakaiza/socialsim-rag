'use client';

import { motion } from 'motion/react';
import type { GameEvent } from '@/lib/events';

// Shown once, on the day an extended arc begins.
//
// Without this the arc was invisible: its sub-events simply started appearing
// among the ordinary ones, so a week of committee meetings read as unrelated
// coincidences rather than a thing the player had been pulled into. The arc's
// own `description` exists to set that up and had never been shown to anyone.
export function ArcAnnouncement({ arc, onContinue }: { arc: GameEvent; onContinue: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative mx-auto max-w-xl overflow-hidden rounded-[10px] border border-line bg-card p-8"
    >
      <div className="absolute inset-x-0 top-0 h-0.5 bg-mint opacity-70" />

      <span className="font-mono text-xs tracking-[0.12em] text-mint">// something starts</span>
      <h2 className="mt-3 font-mono text-2xl font-bold">{arc.title}</h2>

      <p className="mt-4 leading-[1.7]">{arc.description}</p>

      {/* The duration is the part that changes how the player behaves — knowing
          this runs for days is what makes it worth investing in rather than
          treating as a one-off. */}
      <p className="mt-4 font-mono text-sm text-muted">
        runs for <span className="text-mint">{arc.duration_days} days</span> — it&rsquo;ll come up
        again
      </p>

      <button
        onClick={onContinue}
        className="mt-6 rounded-[10px] bg-violet px-6 py-2.5 font-mono text-sm font-medium text-white transition-shadow hover:glow-violet"
      >
        Get on with it →
      </button>
    </motion.div>
  );
}
