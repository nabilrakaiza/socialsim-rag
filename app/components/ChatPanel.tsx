'use client';

import { AnimatePresence, motion } from 'motion/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { NPCCharacter } from '@/lib/gemma';

export interface ChatLine {
  id: string;
  character: NPCCharacter;
  role: 'player' | 'npc';
  content: string;
}

const NAMES: Record<NPCCharacter, string> = {
  hiyori: 'Hiyori',
  shiori: 'Shiori',
  yuki: 'Yuki',
};

// Memoised deliberately. The page re-renders several times a second to drive
// the clock, and without this the message animations restart on every tick and
// never finish — the panel renders permanently part-faded.
export const ChatPanel = memo(function ChatPanel({
  lines,
  character,
  onCharacterChange,
  onSend,
  pending,
  disabled,
  disabledReason,
}: {
  lines: ChatLine[];
  character: NPCCharacter;
  onCharacterChange: (next: NPCCharacter) => void;
  onSend: (message: string) => void;
  pending: boolean;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // Only this character's side of the conversation — the siloed-knowledge rule
  // applies to what the player sees too, not just what the characters know.
  const visible = lines.filter((line) => line.character === character);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visible.length, pending]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled || pending) return;
    setDraft('');
    onSend(text);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-line pb-3">
        {(Object.keys(NAMES) as NPCCharacter[]).map((c) => (
          <button
            key={c}
            onClick={() => onCharacterChange(c)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              c === character ? 'bg-accent text-white' : 'text-muted hover:bg-line'
            }`}
          >
            {NAMES[c]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-4">
        {visible.length === 0 && !pending && (
          <p className="text-sm text-muted">
            No messages with {NAMES[character]} today. Say something before the time runs out.
          </p>
        )}

        <AnimatePresence initial={false}>
          {visible.map((line) => (
            <motion.div
              key={line.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={line.role === 'player' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                  line.role === 'player'
                    ? 'rounded-br-sm bg-accent text-white'
                    : 'rounded-bl-sm bg-surface text-ink ring-1 ring-line'
                }`}
              >
                {line.content}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* A reply takes ~14s, which is long enough that silence reads as
            breakage. Naming who is typing makes the wait feel accounted for. */}
        {pending && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-surface px-4 py-2 text-sm text-muted ring-1 ring-line">
              <span className="animate-breathe">{NAMES[character]} is typing…</span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line pt-3">
        {disabled ? (
          <p className="text-sm text-muted">{disabledReason ?? 'You can’t chat right now.'}</p>
        ) : (
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder={`Message ${NAMES[character]}…`}
              className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={submit}
              disabled={pending || !draft.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-40"
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
