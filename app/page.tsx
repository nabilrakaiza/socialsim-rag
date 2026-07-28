'use client';

// The game. Walks the day's schedule segment by segment: `free` segments run
// the clock in real time and open chat, `activity` segments present whatever
// fired there, and `locked` segments are skipped past by the clock hook.
//
// Type-only imports from lib/ are erased at compile time, so no server code
// and no credentials reach the client bundle.

import { useCallback, useEffect, useState } from 'react';
import type { DayPlan, EndDayResult, EndDayStage, ResolvedSegment } from '@/lib/orchestrator';
import type { GameState } from '@/lib/supabase';
import type { NPCCharacter } from '@/lib/gemma';
import type { RelationshipStage } from '@/lib/relationship';
import { formatDuration, formatGameTime, useDayClock } from './useDayClock';
import { ScheduleRail } from './components/ScheduleRail';
import { ChatPanel, type ChatLine } from './components/ChatPanel';
import { SegmentStage } from './components/SegmentStage';
import { DayEnd, type DayRecapEntry } from './components/DayEnd';
import { EndingScreen } from './components/EndingScreen';

const SESSION_KEY = 'socialsim-session-id';

// Semantic stage ids come from lib/; the wording is the UI's business.
const STAGE_COPY: Record<EndDayStage, string> = {
  scoring: 'weighing what you did today…',
  reflecting: 'they’re thinking about you…',
  diary: 'Hiyori is writing in her diary…',
  saving: 'wrapping up…',
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `request failed: ${res.status}`);
  return json as T;
}

// End of day streams newline-delimited JSON so its ~90s of work reports real
// progress. Chunk boundaries can land mid-line, hence the buffer.
async function streamEndDay(sessionId: string, onStage: (stage: EndDayStage) => void): Promise<EndDayResult> {
  const res = await fetch('/api/day/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.body) throw new Error('no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: EndDayResult | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line) as { stage?: EndDayStage; result?: EndDayResult; error?: string };
      if (payload.error) throw new Error(payload.error);
      if (payload.stage) onStage(payload.stage);
      if (payload.result) result = payload.result;
    }
  }

  if (!result) throw new Error('end of day finished without a result');
  return result;
}

export default function Page() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [character, setCharacter] = useState<NPCCharacter>('hiyori');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [pendingReplies, setPendingReplies] = useState<NPCCharacter[]>([]);

  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [savingAnswer, setSavingAnswer] = useState(false);

  const [endResult, setEndResult] = useState<EndDayResult | null>(null);
  const [endProgress, setEndProgress] = useState<string | null>(null);

  const guard = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const finishDay = useCallback(
    () =>
      guard(async () => {
        if (!sessionId) return;
        setEndProgress(STAGE_COPY.scoring);
        try {
          const result = await streamEndDay(sessionId, (stage) => setEndProgress(STAGE_COPY[stage]));
          setEndResult(result);
          setState(await api<GameState>(`/api/session/${sessionId}`));
        } finally {
          setEndProgress(null);
        }
      }),
    [sessionId]
  );

  const clock = useDayClock(plan?.schedule ?? null, finishDay);
  const { advance } = clock;

  // Resume on load — the session id is all the client keeps.
  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return;
    setSessionId(stored);
    api<GameState>(`/api/session/${stored}`)
      .then(setState)
      .catch(() => {
        localStorage.removeItem(SESSION_KEY);
        setSessionId(null);
      });
  }, []);

  const newGame = () =>
    guard(async () => {
      setLoading(true);
      try {
        const created = await api<GameState>('/api/session', {});
        localStorage.setItem(SESSION_KEY, created.session_id);
        setSessionId(created.session_id);
        setState(created);
        setPlan(null);
        setLines([]);
        setAnswered({});
        setEndResult(null);
      } finally {
        setLoading(false);
      }
    });

  const beginDay = () =>
    guard(async () => {
      setLoading(true);
      try {
        setEndResult(null);
        setEndProgress(null);
        setLines([]);
        setAnswered({});
        setPlan(await api<DayPlan>('/api/day/start', { sessionId }));
      } finally {
        setLoading(false);
      }
    });

  const send = useCallback(
    (text: string) =>
      guard(async () => {
      if (!state) return;
      const stamp = `${Date.now()}`;
      // Captured now, so a reply is always filed against whoever it was sent
      // to even if the player switches tabs while waiting.
      const askedFor = character;

      setLines((prev) => [...prev, { id: `p-${stamp}`, character: askedFor, role: 'player', content: text }]);
      setPendingReplies((prev) => [...prev, askedFor]);
      try {
        const { reply } = await api<{ reply: string }>('/api/chat', {
          sessionId,
          character: askedFor,
          day: state.current_day,
          relationshipStage: state.relationship_stage as RelationshipStage,
          playerMessage: text,
        });
        setLines((prev) => [...prev, { id: `n-${stamp}`, character: askedFor, role: 'npc', content: reply }]);
      } finally {
        // Removes one entry, not every match, so concurrent asks to the same
        // person can't clear each other's indicator.
        setPendingReplies((prev) => {
          const next = [...prev];
          const at = next.indexOf(askedFor);
          if (at !== -1) next.splice(at, 1);
          return next;
        });
      }
    }),
    [state, character, sessionId]
  );

  const answerEvent = useCallback(
    (resolved: ResolvedSegment, text: string) =>
      guard(async () => {
        setSavingAnswer(true);
        try {
          await api('/api/event/respond', { eventLogId: resolved.eventLogId, playerAction: text });
          setAnswered((prev) => ({ ...prev, [resolved.eventLogId!]: true }));
          advance();
        } finally {
          setSavingAnswer(false);
        }
      }),
    [advance]
  );

  const confess = () =>
    guard(async () => {
      setLoading(true);
      try {
        await api<{ ending: string }>('/api/confess', { sessionId });
        setState(await api<GameState>(`/api/session/${sessionId}`));
        setPlan(null);
      } finally {
        setLoading(false);
      }
    });

  const currentSegmentName = clock.segment?.name;
  const handleAnswer = useCallback(
    (text: string) => {
      const resolved = plan?.segments.find((s) => s.segment === currentSegmentName);
      if (resolved) void answerEvent(resolved, text);
    },
    [plan, currentSegmentName, answerEvent]
  );

  // ---- render ----

  if (state?.game_over && state.ending_id) {
    return (
      <main className="mx-auto max-w-3xl px-6">
        <EndingScreen
          endingId={state.ending_id}
          onRestart={() => {
            localStorage.removeItem(SESSION_KEY);
            setSessionId(null);
            setState(null);
            setPlan(null);
            setEndResult(null);
          }}
        />
      </main>
    );
  }

  if (!sessionId || !state) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6">
        <span className="mb-3 block font-mono text-xs tracking-[0.12em] text-violet">// social-sim-rag</span>
        <h1 className="font-mono text-[clamp(2rem,5vw,3rem)] font-bold leading-tight">
          Thirty days to get it right
        </h1>
        <p className="mt-4 max-w-[520px] leading-[1.7] text-muted">
          A dating sim where nobody is scripted. Three people who only know what they&rsquo;ve seen for
          themselves, remembering it in a vector database. No score, no meter — just how they talk to you.
        </p>
        {error && <p className="mt-4 font-mono text-sm text-red-400">{error}</p>}
        <button
          onClick={newGame}
          disabled={loading}
          className="mt-8 self-start rounded-[10px] bg-violet px-6 py-2.5 font-mono text-sm font-medium text-white transition-shadow hover:glow-violet disabled:opacity-40"
        >
          {loading ? 'Starting…' : 'Begin →'}
        </button>
      </main>
    );
  }

  const currentResolved = plan?.segments.find((s) => s.segment === clock.segment?.name);
  const recap: DayRecapEntry[] = (plan?.segments ?? [])
    .filter((s) => s.eventLogId)
    .map((s) => ({
      title: s.subEvent?.description ?? s.event?.description ?? '',
      answered: Boolean(answered[s.eventLogId!]),
    }));

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="font-mono text-xs tracking-[0.12em] text-violet">
            // day {state.current_day} of 30
          </p>
          <p className="font-mono text-3xl font-bold tabular-nums text-mint">
            {formatGameTime(clock.inGameHour)}
          </p>
        </div>
        {plan && !clock.done && (
          <button
            onClick={confess}
            className="text-xs text-muted underline-offset-4 hover:text-mint hover:underline"
          >
            confess
          </button>
        )}
      </header>

      {plan && (
        <div className="mt-6">
          <ScheduleRail schedule={plan.schedule} currentIndex={clock.index} inGameHour={clock.inGameHour} />
        </div>
      )}

      {error && <p className="mt-4 font-mono text-sm text-red-400">{error}</p>}

      {/* Deliberately NOT wrapped in AnimatePresence. The clock re-renders this
          subtree four times a second, and an AnimatePresence with mode="wait"
          restarts its enter animation on every one of those renders — the panel
          never finishes fading in and sits permanently at partial opacity.
          A keyed motion.div still animates on mount, which is all that's wanted
          here: transitions between segments, not on every tick. */}
      <div className="mt-8">
        <>
          {!plan && (
            <div key="idle">
              <button
                onClick={beginDay}
                disabled={loading}
                className="rounded-[10px] bg-violet px-6 py-2.5 font-mono text-sm font-medium text-white transition-shadow hover:glow-violet disabled:opacity-40"
              >
                {loading ? 'Waking up…' : `Begin day ${state.current_day} →`}
              </button>
            </div>
          )}

          {plan && clock.done && (
            <div key="dayend">
              <DayEnd
                day={plan.day}
                recap={recap}
                result={endResult}
                progress={endProgress}
                onContinue={() => setPlan(null)}
              />
            </div>
          )}

          {plan && !clock.done && clock.segment?.type === 'free' && (
            <div key={`free-${clock.index}`}>
              <div className="mb-3 flex items-center justify-between font-mono text-sm">
                <span className="text-muted">
                  free time — <span className="text-mint">{clock.remainingRealMs !== null && formatDuration(clock.remainingRealMs)}</span> left
                </span>
                <button onClick={advance} className="text-muted transition-colors hover:text-mint">
                  skip ahead →
                </button>
              </div>
              <div className="relative h-[26rem] overflow-hidden rounded-[10px] border border-line bg-card p-4">
                <div className="absolute inset-x-0 top-0 h-0.5 bg-violet opacity-60" />
                <ChatPanel
                  lines={lines}
                  character={character}
                  onCharacterChange={setCharacter}
                  onSend={send}
                  pending={pendingReplies.includes(character)}
                  disabled={clock.expired}
                  disabledReason="Time’s up — you need to get going."
                />
              </div>
              {clock.expired && (
                <button
                  onClick={advance}
                  className="mt-3 rounded-[10px] bg-violet px-5 py-2 font-mono text-sm text-white"
                >
                  Move on →
                </button>
              )}
            </div>
          )}

          {plan && !clock.done && clock.segment?.type === 'activity' && currentResolved && (
            <div key={`act-${clock.index}`}>
              <SegmentStage
                resolved={currentResolved}
                saving={savingAnswer}
                onAnswer={handleAnswer}
                onSkip={advance}
              />
            </div>
          )}
        </>
      </div>
    </main>
  );
}
