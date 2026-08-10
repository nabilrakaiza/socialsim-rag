'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { USERNAME_MAX } from '@/lib/username';

// Shown once, between "Begin" and day 1.
//
// The landing copy sets a tone but teaches nothing: a new player didn't know
// they were Adrian, who the other three were, that a run is thirty days, that
// free time is spent in real minutes, or that confessing ends everything
// immediately.
//
// The one that actually needed saying is "no meter". The whole design is that
// affection is hidden and you read behaviour instead — and an invisible
// mechanic nobody mentions doesn't read as subtle, it reads as a missing UI.

interface Section {
  tag: string;
  title: string;
  body: React.ReactNode;
}

const SECTIONS: Section[] = [
  {
    tag: '// who you are',
    title: 'Adrian',
    body: (
      <>
        Second-year Computer Science at NUS. Your coursemate <Name>Shiori</Name> introduced you to{' '}
        <Name>Hiyori</Name>, who studies environmental biology, cycles on weekends, and takes a while to
        warm up to anyone. <Name>Yuki</Name>{' '}
        went to your secondary school; you drifted, and she&rsquo;s around again.
        <br />
        <br />
        Nobody is scripted. Each of them only knows what she has personally seen or been told — there is
        no gossip system, so what one knows another may not.
      </>
    ),
  },
  {
    tag: '// the shape of a day',
    title: 'Thirty days',
    body: (
      <>
        A day runs in eight blocks, from waking to sleeping. Three of them are <Free>free</Free> — getting
        ready, lunch, dinner — and those are the only times you can talk to anyone.
        <br />
        <br />
        The blocks in between are class, work, and everything else. You don&rsquo;t play those, but things
        happen during them.
      </>
    ),
  },
  {
    tag: '// what you actually spend',
    title: 'Time, not points',
    body: (
      <>
        There are no action points. Free time runs at{' '}
        <Highlight>one in-game hour per fifteen real minutes</Highlight>, and a reply takes a couple of
        seconds of it. Lunch is not long.
        <br />
        <br />
        <Highlight>Skip ahead</Highlight> ends a block immediately and moves you on. Use it — the clock is
        there to make time feel finite, not to make you sit through it.
      </>
    ),
  },
  {
    tag: '// the important one',
    title: 'There is no meter',
    body: (
      <>
        She has an opinion of you. You will never see it as a number, a bar, or a percentage. There is no
        hidden UI you failed to find — it is deliberately not shown.
        <br />
        <br />
        You find out the way you would find out in life: <Highlight>how she talks to you</Highlight>.
        Whether she asks a follow-up. Whether she deflects. Whether she remembers something you mentioned
        once and brings it back a week later.
      </>
    ),
  },
  {
    tag: '// things that happen',
    title: 'Events, in your own words',
    body: (
      <>
        Things come up during the day — some one-off, some running across a week. When one does, you
        answer in <Highlight>free text</Highlight>. There are no options to pick from and no obviously
        right choice.
        <br />
        <br />
        Ignoring an event is also an answer, and it costs less than handling one badly — but it isn&rsquo;t
        free.
      </>
    ),
  },
  {
    tag: '// how it ends',
    title: 'Saying it',
    body: (
      <>
        You can tell her how you feel at any point, and it{' '}
        <Highlight>ends the run immediately</Highlight>{' '}
        — on day 3 or day 29, whatever the answer turns out to be. You&rsquo;ll be asked to confirm first.
        <br />
        <br />
        There are <Highlight>five endings</Highlight>. Three depend on how she feels when you say it. One
        is what happens if you never do. The last one you would have to notice on your own.
      </>
    ),
  },
];

function Name({ children }: { children: React.ReactNode }) {
  return <span className="text-mint">{children}</span>;
}

function Highlight({ children }: { children: React.ReactNode }) {
  return <span className="text-violet">{children}</span>;
}

function Free({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-mint">{children}</span>;
}

export function HowToPlay({
  onStart,
  starting,
  error,
}: {
  onStart: (username: string) => void;
  starting: boolean;
  error: string | null;
}) {
  const [username, setUsername] = useState('');

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="mx-auto max-w-xl px-6 py-16"
    >
      <span className="mb-3 block font-mono text-xs tracking-[0.12em] text-violet">// before you start</span>
      <h1 className="font-mono text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight">How this works</h1>

      <div className="mt-10 space-y-10">
        {SECTIONS.map((section, i) => (
          <motion.section
            key={section.title}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            // Staggered rather than all at once: six blocks appearing together
            // reads as a wall and invites skipping the one that matters.
            transition={{ delay: 0.08 * i, duration: 0.35 }}
          >
            <span className="font-mono text-xs tracking-[0.12em] text-muted">{section.tag}</span>
            <h2 className="mt-2 font-mono text-lg font-bold">{section.title}</h2>
            <p className="mt-3 leading-[1.8] text-muted">{section.body}</p>
          </motion.section>
        ))}
      </div>

      {/* The name is asked for HERE rather than on the landing screen, so the
          player has read what they're committing to before naming it. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!starting) onStart(username);
        }}
        className="mt-12 border-t border-line pt-8"
      >
        <label htmlFor="new-username" className="font-mono text-xs tracking-[0.12em] text-mint">
          // name this save
        </label>
        <input
          id="new-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={USERNAME_MAX}
          autoComplete="off"
          placeholder="anything you'll remember"
          className="mt-3 block w-full rounded-[10px] border border-line bg-card px-4 py-2.5 font-mono text-sm outline-none placeholder:text-muted focus:border-mint"
        />
        {error && <p className="mt-2 font-mono text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={starting || username.trim().length === 0}
          className="mt-5 rounded-[10px] bg-violet px-6 py-2.5 font-mono text-sm font-medium text-white transition-shadow hover:glow-violet disabled:opacity-40"
        >
          {starting ? 'Starting…' : 'Start day 1 →'}
        </button>

        {/* Said plainly because it is the one thing that can lose a run and the
            player cannot guess it: the name is how you get back in, and it is
            not a password. */}
        <p className="mt-4 font-mono text-xs leading-[1.7] text-muted">
          type this name on <span className="text-mint">Continue</span> to pick the run back up on any
          browser. it isn&rsquo;t a password — anyone who knows it can open your save
        </p>
      </form>
    </motion.main>
  );
}
