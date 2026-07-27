'use client';

import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

interface Ending {
  id: string;
  title: string;
  description: string;
  scene: string;
}

export function EndingScreen({ endingId, onRestart }: { endingId: string; onRestart: () => void }) {
  const [ending, setEnding] = useState<Ending | null>(null);

  useEffect(() => {
    fetch(`/api/ending/${endingId}`)
      .then((r) => r.json())
      .then((data) => setEnding(data.error ? null : data))
      .catch(() => setEnding(null));
  }, [endingId]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
      className="mx-auto max-w-xl py-12"
    >
      <span className="mb-3 block font-mono text-xs tracking-[0.12em] text-violet">// ending</span>

      {/* Mono for the heading, matching the site. The prose below stays in Inter
          deliberately — these are long narrative paragraphs, and monospace at
          that length is genuinely harder to read. */}
      <h2 className="font-mono text-3xl font-bold">{ending?.title ?? 'The end'}</h2>

      {ending ? (
        <div className="mt-6 space-y-5 text-[1.05rem] leading-[1.8]">
          <p>{ending.description}</p>
          <p className="italic text-muted">{ending.scene}</p>
        </div>
      ) : (
        <p className="mt-6 text-muted">
          <span className="animate-breathe">…</span>
        </p>
      )}

      <button
        onClick={onRestart}
        className="mt-10 rounded-[10px] border border-line px-5 py-2 font-mono text-sm transition-colors hover:border-mint hover:text-mint"
      >
        Start again
      </button>
    </motion.div>
  );
}
