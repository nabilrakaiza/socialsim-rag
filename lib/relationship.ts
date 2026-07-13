// ============================================================
// lib/relationship.ts
//
// Pure, deterministic logic for turning an affection number into
// the tier/stage labels the rest of the pipeline needs, plus the
// end-of-day diary trigger check. No API calls here on purpose —
// per diary_system.md, these are exact numeric rules, not
// something worth spending a Gemma call (or risking hallucinated
// judgment) on.
//
// Resolves a gap flagged in lib/gemma.ts: README mentions "5
// tiers" for the hidden meter but only names 4 relationship
// stages. diary_system.md's tier table actually pins this down —
// tiers 1-4 map 1:1 to the four stages; tier 5 (81-100) is just
// the upper half of Close Friend, used only to flavor Hiyori's
// diary voice ("confession-ready"). So `game_state` only needs to
// store `relationship_stage` — tier is always derivable from
// `affection` on demand, never stored separately.
// ============================================================

export type Tier = 1 | 2 | 3 | 4 | 5;

export type RelationshipStage = 'Stranger' | 'Acquaintance' | 'Friend' | 'Close Friend';

// Ranges from diary_system.md's "ENTRY EXAMPLES BY AFFECTION TIER" headers.
export function affectionToTier(affection: number): Tier {
  if (affection <= 20){
    return 1;
  }
  else if (affection <= 40){
    return 2;
  }
  else if (affection <= 60){
    return 3;
  }
  else if (affection <= 80){
    return 4;
  }
  else {
    return 5;
  }
}

export function tierToStage(tier: Tier): RelationshipStage {
  switch(tier) {
    case 1:
      return "Stranger";
    case 2:
      return "Acquaintance";
    case 3:
      return "Friend";
    case 4:
      return "Close Friend";
    case 5:
      return "Close Friend";
  }
}

export function affectionToStage(affection: number): RelationshipStage {
  return tierToStage(affectionToTier(affection));
}

// Only ever passed into the diary-generation prompt — diary_system.md
// is explicit that the raw number/tier never reach Gemma's NPC-dialogue
// prompts, only this label.
const TIER_LABELS: Record<Tier, string> = {
  1: 'she barely thinks about him',
  2: "she's mildly aware of him",
  3: "she notices him but won't admit it",
  4: "she's developing feelings, which unsettles her",
  5: "she knows how she feels, she's just scared",
};

export function tierLabel(tier: Tier): string {
  switch(tier) {
    case 1:
      return TIER_LABELS[1];
    case 2:
      return TIER_LABELS[2];
    case 3:
      return TIER_LABELS[3];
    case 4:
      return TIER_LABELS[4];
    case 5:
      return TIER_LABELS[5];
  }
}

export type DiaryTriggerType = 'event' | 'threshold' | 'periodic' | 'confession';

export interface DiaryTriggerInput {
  confessedToday: boolean;
  eventConcludedToday: boolean;
  canonEventToday: boolean;
  daysSinceLastEntry: number;
  affectionDeltaToday: number;
}

export interface DiaryTriggerResult {
  shouldGenerate: boolean;
  triggerType: DiaryTriggerType | null;
}

// Priority order per diary_system.md: confession outranks everything
// ("triggers a final entry regardless"), then event-based triggers
// (doc's stated tiebreak for same-day conflicts), then the affection
// swing threshold, then the periodic slice-of-life entry. Capping at
// one entry/day is the caller's responsibility (only invoke once/day).
export function checkDiaryTrigger(input: DiaryTriggerInput): DiaryTriggerResult {
  if (input.confessedToday){
    return {shouldGenerate: true, triggerType: 'confession'}
  }

  if (input.eventConcludedToday || input.canonEventToday){
    return {shouldGenerate: true, triggerType: 'event'}
  }

  if (Math.abs(input.affectionDeltaToday) >= 15){
    return {shouldGenerate: true, triggerType: 'threshold'}
  }

  if (input.daysSinceLastEntry >= 3){
    return {shouldGenerate: true, triggerType: 'periodic'}
  }

  return {shouldGenerate: false, triggerType: null};
}
