'use client';

import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

interface Ending {
  id: string;
  title: string;
  description: string;
  scene: string;
}

interface Reflection {
  finalEntry: string;
  archive: { day: number; text: string }[];
  yukiEpilogue: string | null;
}

export function EndingScreen({
  endingId,
  sessionId,
  onRestart,
}: {
  endingId: string;
  sessionId: string;
  onRestart: () => void;
}) {
  const [ending, setEnding] = useState<Ending | null>(null);
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [showArchive, setShowArchive] = useState(false);

  useEffect(() => {
    fetch(`/api/ending/${endingId}`)
      .then((r) => r.json())
      .then((data) => setEnding(data.error ? null : data))
      .catch(() => setEnding(null));
  }, [endingId]);

  // Generated separately from the static prose above, so the scripted ending
  // appears immediately and the written-for-this-run part fills in behind it.
  useEffect(() => {
    fetch('/api/ending/reflection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then((r) => r.json())
      .then((data) => setReflection(data.error ? null : data))
      .catch(() => setReflection(null));
  }, [sessionId]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
      className="mx-auto max-w-xl py-12"
    >
      <span className="mb-3 block font-mono text-xs tracking-[0.12em] text-violet">// ending</span>
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

      {/* Her closing entry. The whole game withholds the affection meter and
          asks the player to read her behaviour instead; this is where she
          finally says it plainly, in the one place she's ever honest. */}
      <section className="mt-12 border-t border-line pt-8">
        <span className="font-mono text-xs tracking-[0.12em] text-mint">// her diary, that night</span>

        {reflection ? (
          <article className="mt-4 whitespace-pre-line rounded-[10px] border border-line bg-card p-6 leading-[1.9]">
            {reflection.finalEntry}
          </article>
        ) : (
          <p className="mt-4 text-sm text-muted">
            <span className="animate-breathe">she&rsquo;s still writing…</span>
          </p>
        )}

        {reflection && reflection.archive.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowArchive((open) => !open)}
              className="font-mono text-xs text-muted transition-colors hover:text-mint"
            >
              {showArchive ? '− hide' : '+ read'} the {reflection.archive.length} entries before this
            </button>

            {showArchive && (
              <div className="mt-4 space-y-4">
                {reflection.archive.map((entry, i) => (
                  <article
                    key={i}
                    className="whitespace-pre-line rounded-[10px] border border-line bg-card/50 p-5 text-[0.95rem] leading-[1.9] text-muted"
                  >
                    {entry.text}
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Only rendered when there was genuinely something unsaid — see
          YUKI_REVEAL_FLOOR, and note it's suppressed on the secret ending,
          where she already said it. */}
      {reflection?.yukiEpilogue && (
        <section className="mt-10 border-t border-line pt-8">
          <span className="font-mono text-xs tracking-[0.12em] text-violet">// and one more thing</span>
          <p className="mt-4 leading-[1.9] text-muted">{reflection.yukiEpilogue}</p>
        </section>
      )}

      <button
        onClick={onRestart}
        className="mt-12 rounded-[10px] border border-line px-5 py-2 font-mono text-sm transition-colors hover:border-mint hover:text-mint"
      >
        Start again
      </button>
    </motion.div>
  );
}
