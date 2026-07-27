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
      {/* The prose is the payoff, so it gets serif and room to breathe rather
          than the UI treatment the rest of the game uses. */}
      <h2 className="font-serif text-3xl">{ending?.title ?? 'The end'}</h2>

      {ending ? (
        <div className="mt-6 space-y-5 font-serif text-lg leading-relaxed">
          <p>{ending.description}</p>
          <p className="text-muted italic">{ending.scene}</p>
        </div>
      ) : (
        <p className="mt-6 text-muted">
          <span className="animate-breathe">…</span>
        </p>
      )}

      <button
        onClick={onRestart}
        className="mt-10 rounded-lg border border-line px-5 py-2 text-sm hover:bg-line"
      >
        Start again
      </button>
    </motion.div>
  );
}
