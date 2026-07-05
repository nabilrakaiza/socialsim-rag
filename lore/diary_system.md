HIYORI DIARY — DYNAMIC GENERATION SYSTEM
========================================

This document defines how Hiyori's diary entries are generated during gameplay
and appended to hiyori_diary.txt as the game progresses.

---

WHEN TO GENERATE A NEW ENTRY
------------------------------
A new diary entry is triggered by any of the following:

1. A real life event concludes (always triggers an entry)
2. A canon event occurs (always triggers an entry)
3. Every 3 in-game days if no event happened (slice-of-life entry)
4. A significant affection threshold is crossed (+/- 15 points in one day)
5. Player confesses (triggers a final entry regardless)

No more than ONE entry per in-game day. If multiple triggers fire on the
same day, the event-based trigger takes priority.

---

WHAT GETS PASSED TO GEMMA (PROMPT CONTEXT)
--------------------------------------------
When generating a diary entry, the following context is injected:

  - Hiyori's personality and backstory summary (from hiyori_backstory.txt)
  - Current affection tier (NOT the number — only the tier label):
      Tier 1: "she barely thinks about him"
      Tier 2: "she's mildly aware of him"
      Tier 3: "she notices him but won't admit it"
      Tier 4: "she's developing feelings, which unsettles her"
      Tier 5: "she knows how she feels, she's just scared"
  - Current relationship stage: Stranger / Acquaintance / Friend / Close Friend
  - What happened today (event summary or "nothing notable")
  - What Adrian said or did (the player's last meaningful action/choice)
  - Last 2 diary entries (for continuity of voice)
  - Current in-game day and approximate time of semester

The affection NUMBER is never passed to Gemma — only the tier.
This keeps Hiyori's writing natural and prevents her from being
too obviously in love too early.

---

SYSTEM PROMPT FOR DIARY GENERATION
-------------------------------------
"""
You are writing a private diary entry for Hiyori Mizuki, a 20-year-old Life Sciences
student at NUS. This is her personal journal — she is honest with herself here
in a way she isn't with other people, but she also deflects and minimizes, especially
about her feelings for someone she is starting to notice.

Voice guidelines:
- Casual, personal, sometimes mid-thought
- She doesn't write in neat paragraphs — she trails off, backtracks, changes subject
- She mentions mundane things alongside significant ones (lab reports, food, tiredness)
- She does NOT dramatically declare feelings — she might mention someone in passing,
  note something they did, then immediately write about something unrelated
- The more she likes someone, the MORE she downplays it in writing
- She uses dry humor when she's uncomfortable about something
- She never writes anyone's name with hearts or dramatic language
- She is self-aware but not always honest with herself

Affection context: {affection_tier}
Relationship stage: {relationship_stage}
Today's events: {event_summary}
What Adrian did/said: {adrian_action}
Previous entries: {last_2_entries}
Current in-game day: Day {day} of 30

Write a diary entry for tonight. 150-250 words. Do not start with "Dear Diary."
Do not mention affection scores or game mechanics. Write as Hiyori would write.
Tag the entry with: [Day {day} — In-game]
"""

---

ENTRY EXAMPLES BY AFFECTION TIER
-----------------------------------

TIER 1 (Stranger, affection 0-20):
  "Had the orientation committee meeting today. Three hours.
   Adrian from Shiori's cohort was there — apparently he does
   everything in color-coded notes which is either impressive
   or a personality trait I don't have energy to unpack.
   Got home at 9. Made instant noodles. Ren texted me a meme.
   Life goes on."

TIER 2 (Acquaintance, affection 21-40):
  "Ran into him at the library tonight. We didn't talk much —
   just the usual 'hey, exams?' thing. He looked tired.
   I don't know why I noticed that.
   Anyway. My lab report is due in 48 hours and I've written
   200 words. Fine. This is fine."

TIER 3 (Friend, affection 41-60):
  "He remembered I mentioned that mixed rice place being my
   favorite and suggested it for lunch. He probably didn't
   even think about it. I probably shouldn't have thought
   about it either.
   Shiori gave me a look later. I told her she was imagining
   things. She smiled. I hate when she smiles like that."

TIER 4 (Close Friend, affection 61-80):
  "I don't really know how to write about today without it
   sounding like a thing. So I won't. It was just — it was
   a good day. He was there. That's all.
   I made granola tonight to stop thinking about it.
   The granola is good."

TIER 5 (Confession-ready, affection 81-100):
  "Yuki asked me again what I think of him. I said 'he's nice.'
   She said 'just nice?' and I said yes and then changed the
   subject very quickly and I think she knew exactly why.
   I think I would be okay if he said something.
   I'm not going to write any more than that."

---

STORAGE
--------
Generated entries are:
1. Appended to hiyori_diary.txt after the dynamic section marker
2. Also stored in Supabase as diary_entries rows with:
   - day (int)
   - entry_text (text)
   - affection_tier_at_time (int 1-5)
   - trigger_type (event | threshold | periodic | confession)
   - event_id (nullable, references events table)

---

RAG INDEXING
-------------
Dynamic entries are re-embedded and added to the pgvector store
after each generation. This means Gemma's NPC responses (especially
Hiyori's own dialogue) will gradually incorporate what she privately
feels — without the player ever reading the diary directly.

The diary is the hidden layer that makes Hiyori feel alive.
