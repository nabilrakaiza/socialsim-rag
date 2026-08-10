'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { USERNAME_MAX } from '@/lib/username';

// Finding a save again from the name it was given.
//
// The everyday path is still localStorage — a returning player on the same
// browser lands straight in their day and never sees this. This is the
// recovery path: a cleared browser, a different device, a private window.

export function ResumeSave({
  onResume,
  onBack,
  loading,
  error,
}: {
  onResume: (username: string) => void;
  onBack: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [username, setUsername] = useState('');

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6"
    >
      <span className="mb-3 block font-mono text-xs tracking-[0.12em] text-violet">// continue</span>
      <h1 className="font-mono text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight">
        Pick it back up
      </h1>
      <p className="mt-4 max-w-[460px] leading-[1.7] text-muted">
        The name you gave your save when you started. Capitalisation doesn&rsquo;t matter.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading) onResume(username);
        }}
        className="mt-8"
      >
        <input
          id="resume-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={USERNAME_MAX}
          autoComplete="off"
          autoFocus
          placeholder="your save name"
          className="block w-full rounded-[10px] border border-line bg-card px-4 py-2.5 font-mono text-sm outline-none placeholder:text-muted focus:border-mint"
        />
        {error && <p className="mt-2 font-mono text-xs text-red-400">{error}</p>}

        <div className="mt-5 flex items-center gap-3">
          <button
            type="submit"
            disabled={loading || username.trim().length === 0}
            className="rounded-[10px] bg-violet px-6 py-2.5 font-mono text-sm font-medium text-white transition-shadow hover:glow-violet disabled:opacity-40"
          >
            {loading ? 'Looking…' : 'Continue →'}
          </button>
          <button
            type="button"
            onClick={onBack}
            className="font-mono text-sm text-muted transition-colors hover:text-mint"
          >
            back
          </button>
        </div>
      </form>
    </motion.main>
  );
}
