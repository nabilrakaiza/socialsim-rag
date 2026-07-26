# social-sim-rag

A narrative, RAG-powered dating simulation built as a learning project for retrieval-augmented generation (RAG) architecture. The gameplay is a wrapper — the real point of this project is to design and implement a working RAG pipeline end to end: chunking, embedding, vector storage, retrieval, and grounded LLM generation.

> Working title: `social-sim-rag'

---

## Concept

Adrian (CS, NUS) is introduced to Hiyori (Life Sciences, NUS) through his coursemate Shiori. Over 30 in-game days, the player navigates conversations, random real-life events, and a slowly evolving relationship — all while a hidden affection meter and relationship tier quietly drive how each character responds.

NPC dialogue isn't scripted — it's grounded in per-character lore stored in a vector database. Each character only "knows" what they've personally witnessed or been told directly by Adrian. There's no shared gossip system between NPCs; information flows only through the player's choices.

---

## Characters

| Name | Role | Details |
|---|---|---|
| **Hiyori** | Main love interest | Life Sciences, NUS. Tsundere, cycling club, tutors secondary schoolers. Warms up slowly. |
| **Shiori** | Friend / intel source | CS, NUS. Adrian's coursemate. Direct, protective of Hiyori, won't do the work for Adrian. |
| **Yuki** | Secret route | Economics, NUS. Same secondary school as Adrian. Quiet, unresolved feelings — never surfaces unless the player pays attention to her specifically. |
| **Adrian** | Player character | CS, NUS. No stored knowledge base — he *is* the player. |

---

## Core Systems

### Hidden Affection Meter
A 0–100 score for Hiyori (and a separate hidden meter for Yuki) that is **never shown to the player**. It's inferred only through dialogue tone and NPC behavior, and mapped to 5 tiers used to guide Gemma's writing voice without ever exposing the raw number.

### Relationship Stages
`Stranger → Acquaintance → Friend → Close Friend` — gates which events and dialogue are available.

### Daily Flow
1. Player sees their schedule for the day (some free time slots, some fixed commitments).
2. Each free-time slot converts to a chat-time budget (e.g. 5 hours of in-game free time ≈ 30 minutes of actual chatting — exact conversion rate TBD) rather than a fixed action-point count. During free time, the player can spend from that budget to text Hiyori, Shiori, or Yuki, or do nothing. No separate action-point system — the schedule itself is the scarcity.
3. **Random events fire unpredictably** — even during "busy" schedule blocks — with higher probability during free time. The player cannot fully predict when or what, and events aren't gated by the chat-time budget above.
4. At end of day, a batch evaluation runs:
   - Updates the hidden affection score and relationship tier
   - Updates each NPC's individual knowledge base (what they know/feel about Adrian, based only on what they personally experienced that day)
   - Generates a new Hiyori diary entry if a trigger condition is met
   - Re-embeds all new dynamic content into the vector store

### Extended ("Active") Events
Some events span multiple days (max 7) rather than resolving in one scene — e.g. a week-long orientation committee arc. While active, the game tracks `days_remaining` and biases event generation toward related `sub_events`, while still allowing unrelated events to occur at lower frequency.

### Endings
| Ending | Trigger |
|---|---|
| ✅ Good End | Confess with affection ≥ 80 |
| 😔 Friend Zone | Confess with affection 40–79 |
| 😨 Bad End | Confess with affection < 40, or too many wrong moves accumulate |
| ⏰ Too Late | Day 30 passes with no confession — Hiyori suddenly gets an overseas exchange + internship opportunity and the timing closes on its own |
| 🌸 Secret End | Yuki's hidden affection ≥ 70, and the player never confessed to Hiyori |

Confession is **never gated** by affection — the player can shoot their shot at any point, for better or worse.

---

## Tech Stack

| Layer | Tool |
|---|---|
| LLM | Gemma (via Google AI Studio, free tier, 32k context) |
| Embeddings | Google `gemini-embedding-001`, truncated to 768-dim (`text-embedding-004` was shut down by Google before this project reached ingestion) |
| Vector DB | Supabase pgvector |
| Database | Supabase (game state, messages, diary entries, events log) |
| Frontend | Next.js + TypeScript + Tailwind + Framer Motion |
| Backend | Next.js API Routes |
| Deployment | Vercel |

All chosen for generous free tiers — this project is designed to run at zero cost.

---

## RAG Architecture

```
Player action
  ↓
Embed query (gemini-embedding-001)
  ↓
pgvector similarity search, filtered by character + similarity threshold
  ↓
Retrieve top-k lore chunks
  ↓
Build prompt: [system + character personality + retrieved chunks + conversation history]
  ↓
Gemma generates response + affection delta (as JSON)
  ↓
Update Supabase game state
  ↓
End of day: re-embed + store new diary/knowledge chunks if triggered
```

### `lore_chunks` table design
Every chunk (static lore or dynamically generated) lives in one table, distinguished by:
- `is_static` — `true` for base lore ingested once, `false` for content generated during gameplay
- `session_id` — `null` for static lore (shared across all playthroughs), set for dynamic content (scoped to one playthrough)
- `character` — which NPC's knowledge this chunk belongs to (`hiyori`, `shiori`, `yuki`, or `events`)

This lets retrieval pull `is_static = true OR session_id = current_session` in one query — base lore plus whatever this specific playthrough has generated so far.

> **Current gap:** the live `match_lore_chunks`/`match_lore_multi_character` functions filter by `character` + a similarity threshold only — the `is_static`/`session_id` scoping above is the intended design but isn't wired into retrieval yet. Fine for now since only static lore exists; needs to go back in before dynamic per-playthrough content is added.

### Chunking strategy
Hybrid paragraph + section-heading split:
- Backstory/knowledge/interest files → split on `---` section headers
- Diary entries → one chunk per entry (already self-contained)
- `events.json` → one chunk per event object

Target size: 150–400 tokens per chunk.

---

## Lore Documents

- `hiyori_backstory.txt` — family, academic background, past relationships, habits
- `hiyori_interests.txt` — personality, likes/dislikes, hobbies, things she wants but won't say
- `hiyori_diary.txt` — static pre-game entries + dynamic entries generated during gameplay
- `diary_system.md` — spec for how/when diary entries are generated and what context Gemma receives
- `shiori_knowledge.txt` — what Shiori knows about Hiyori and Adrian, her advice style
- `yuki_knowledge.txt` — Yuki's background, her hidden feelings for Adrian, what she knows about Hiyori
- `adrian_profile.txt` — player character background (for NPCs to reference, not for a knowledge base of his own)
- `events.json` — all real-life events, extended/active events with sub-events, and the 5 endings

Adrian does **not** have a dynamic knowledge base — only Hiyori, Shiori, and Yuki maintain evolving perceptions of him.

---

## Project Status

**Done:**
- Core game design (daily flow, action points, event system, ending conditions)
- Full lore documents for all 4 characters
- `events.json` finalized with capped extended-event durations and sub-events
- Supabase schema live (`lore_chunks`, `game_state`, `messages`, `diary_entries`, `events_log`) — note the live `lore_chunks` table and RPCs diverged from the originally drafted `supabase/schema.sql` (see `lib/supabase.ts` for the current, accurate contract)
- Full RAG ingestion pipeline built and verified end-to-end: `lib/chunking.ts` → `lib/embeddings.ts` → `lib/supabase.ts` → `scripts/ingest.ts` → `scripts/test-retrieval.ts`
- 61 static lore chunks embedded and ingested into `lore_chunks`; retrieval manually verified against real queries
- Gemma integration for NPC dialogue (`lib/gemma.ts`'s `generateDialogue`), grounded in retrieved lore + relationship stage
- Relationship tier/stage + diary-trigger logic (`lib/relationship.ts`)
- End-of-day batch evaluation (`lib/batch-eval.ts`'s `runEndOfDayBatchEval`) — updates per-NPC knowledge chunks, affection score, relationship stage, and diary entries (with RAG re-indexing). Verified end-to-end against the live DB + Gemini API (`scripts/tmp-test-batch-eval.ts`); independent Gemini calls run concurrently with a retry-once-after-60s wrapper for rate-limit resilience

**Next up:**
- Wire `is_static`/`session_id` scoping back into retrieval (see gap note above) — now a real blocker, not just a future one: the batch eval above already writes dynamic chunks that retrieval can't see yet
- Game loop / orchestrator wiring `generateDialogue` + retrieval + `runEndOfDayBatchEval` into an actual playable daily flow (chat-time budget, end-of-day trigger)
- Next.js frontend (chat UI, schedule view, event prompts)
- Checkpoint/save system (password-based, session data purged after 1 week of inactivity)

---

## Design Principles

- **Learning first, game second.** Architectural clarity is prioritized over gameplay complexity.
- **Siloed NPC knowledge.** No NPC-to-NPC gossip system — each character only knows what they experienced directly or were told by the player. Reduces complexity and keeps information flow entirely player-driven.
- **Narrative coherence matters.** Story details (like Hiyori's exchange program hint) are planted deliberately so late-game twists feel earned, not arbitrary.