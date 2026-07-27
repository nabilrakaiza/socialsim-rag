'use client';

// Phase 1: a deliberately plain harness that can play a full day through the
// real API. No clock, no schedule rendering, no styling to speak of — the
// point is to prove the loop works in a browser before building the real UI.
//
// Type-only imports from lib/ are erased at compile time, so nothing
// server-side (and no key) reaches the client bundle.

import { useEffect, useState } from 'react';
import type { DayPlan, EndDayResult, EndDayStage } from '@/lib/orchestrator';
import type { GameState } from '@/lib/supabase';
import type { NPCCharacter } from '@/lib/gemma';
import type { RelationshipStage } from '@/lib/relationship';

const CHARACTERS: NPCCharacter[] = ['hiyori', 'shiori', 'yuki'];
const SESSION_KEY = 'socialsim-session-id';

// The lib layer emits semantic stage ids; the wording lives here, since copy
// is the UI's business.
const STAGE_COPY: Record<EndDayStage, string> = {
  scoring: 'weighing what you did today',
  reflecting: 'they\u2019re thinking about you',
  diary: 'Hiyori is writing in her diary',
  saving: 'wrapping up the day',
};

// Reads the newline-delimited JSON the end-of-day route streams, invoking
// onStage as each phase actually begins. Split on newlines rather than parsing
// per chunk, because a chunk boundary can land mid-line.
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

  if (!result) throw new Error('end of day finished without returning a result');
  return result;
}

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

export default function Page() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const [character, setCharacter] = useState<NPCCharacter>('hiyori');
  const [message, setMessage] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const say = (line: string) => setLog((prev) => [...prev, line]);

  // Resume on load — the session id is the only thing the client persists.
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

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  const newGame = () =>
    run('starting a new game', async () => {
      const created = await api<GameState>('/api/session', {});
      localStorage.setItem(SESSION_KEY, created.session_id);
      setSessionId(created.session_id);
      setState(created);
      setPlan(null);
      setLog([`new game — session ${created.session_id.slice(0, 8)}…`]);
    });

  const startDay = () =>
    run('generating the day', async () => {
      const dayPlan = await api<DayPlan>('/api/day/start', { sessionId });
      setPlan(dayPlan);
      setAnswers({});
      say(`day ${dayPlan.day} started${dayPlan.startedArc ? ` — arc began: ${dayPlan.startedArc.title}` : ''}`);
    });

  const send = () =>
    run('waiting for a reply', async () => {
      if (!state || !message.trim()) return;
      const sent = message;
      setMessage('');
      say(`you → ${character}: ${sent}`);
      const { reply } = await api<{ reply: string }>('/api/chat', {
        sessionId,
        character,
        day: state.current_day,
        relationshipStage: state.relationship_stage as RelationshipStage,
        playerMessage: sent,
      });
      say(`${character}: ${reply}`);
    });

  const answer = (eventLogId: string) =>
    run('recording your answer', async () => {
      await api('/api/event/respond', { eventLogId, playerAction: answers[eventLogId] });
      say(`answered event ${eventLogId.slice(0, 8)}…`);
    });

  const finishDay = () =>
    run('ending the day\u2026', async () => {
      const result = await streamEndDay(sessionId!, (stage) => setBusy(STAGE_COPY[stage]));
      say(
        `day ended — stage ${result.newStage}` +
          `${result.diaryGenerated ? ', diary written' : ''}` +
          `${result.ending ? `, ENDING: ${result.ending}` : ''}`
      );
      setPlan(null);
      setState(await api<GameState>(`/api/session/${sessionId}`));
    });

  const doConfess = () =>
    run('confessing', async () => {
      const { ending } = await api<{ ending: string }>('/api/confess', { sessionId });
      say(`confessed — ENDING: ${ending}`);
      setState(await api<GameState>(`/api/session/${sessionId}`));
    });

  const firedEvents = (plan?.segments ?? []).filter((s) => s.eventLogId);

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>social-sim-rag</h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>Phase 1 harness — plays a full day through the real API.</p>

      {error && (
        <p style={{ color: '#dc2626', border: '1px solid currentColor', padding: 8, borderRadius: 6 }}>{error}</p>
      )}
      {busy && <p style={{ color: 'var(--accent)' }}>⋯ {busy}</p>}

      <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
        <button onClick={newGame} disabled={Boolean(busy)}>New game</button>
        {state && (
          <span style={{ marginLeft: 12, color: 'var(--muted)' }}>
            day {state.current_day} · {state.relationship_stage}
            {state.game_over && ` · GAME OVER (${state.ending_id})`}
          </span>
        )}
      </section>

      {state && !state.game_over && (
        <>
          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
            <button onClick={startDay} disabled={Boolean(busy) || Boolean(plan)}>Start day</button>
            <button onClick={finishDay} disabled={Boolean(busy) || !plan} style={{ marginLeft: 8 }}>End day</button>
            <button onClick={doConfess} disabled={Boolean(busy)} style={{ marginLeft: 8 }}>Confess</button>
          </section>

          {plan && (
            <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
              <h2 style={{ fontSize: 15 }}>Today&apos;s activity segments</h2>
              <ul style={{ paddingLeft: 18 }}>
                {plan.segments.map((s) => (
                  <li key={s.segment}>
                    <code>{s.segment}</code>{' '}
                    {s.eventLogId ? <strong>{s.subEvent?.id ?? s.event?.id}</strong> : <em>{s.flavor}</em>}
                  </li>
                ))}
              </ul>

              {firedEvents.map((s) => (
                <div key={s.eventLogId} style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 12, marginTop: 8 }}>
                  <p style={{ marginTop: 0 }}>{s.subEvent?.description ?? s.event?.description}</p>
                  <p style={{ color: 'var(--muted)' }}>{s.subEvent?.player_action_prompt ?? s.event?.player_action_prompt}</p>
                  <textarea
                    rows={2}
                    style={{ width: '100%' }}
                    value={answers[s.eventLogId!] ?? ''}
                    onChange={(e) => setAnswers((a) => ({ ...a, [s.eventLogId!]: e.target.value }))}
                    placeholder="What do you do?"
                  />
                  <button onClick={() => answer(s.eventLogId!)} disabled={Boolean(busy) || !answers[s.eventLogId!]}>
                    Save answer
                  </button>
                </div>
              ))}
            </section>
          )}

          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
            <h2 style={{ fontSize: 15 }}>Chat</h2>
            <select value={character} onChange={(e) => setCharacter(e.target.value as NPCCharacter)}>
              {CHARACTERS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input
              style={{ width: '60%', marginLeft: 8 }}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && send()}
              placeholder="Say something…"
            />
            <button onClick={send} disabled={Boolean(busy) || !message.trim()} style={{ marginLeft: 8 }}>Send</button>
          </section>
        </>
      )}

      <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 16 }}>
        <h2 style={{ fontSize: 15 }}>Log</h2>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{log.join('\n')}</pre>
      </section>
    </main>
  );
}
