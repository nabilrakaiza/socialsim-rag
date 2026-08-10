// ============================================================
// lib/adrian-profile.ts
//
// What each NPC knows about Adrian, as a fixed prompt block.
//
// lore/adrian_profile.txt was being chunked and embedded like every other lore
// file, but nothing could ever retrieve it: matchLoreChunks is only ever called
// with an NPCCharacter ('hiyori' | 'shiori' | 'yuki'), so the four chunks filed
// under 'adrian' sat in the table unreachable. He is the one thing every
// character is forming an opinion about, and none of them could see him.
//
// Retrieval is the wrong mechanism for it anyway. Similarity search exists to
// pick the relevant few from many; Adrian is relevant to every single turn, so
// there is nothing to select. It belongs in the prompt unconditionally, where
// it also stops competing with genuine memories for the five available slots.
//
// The file is the source of truth rather than a copy pasted in here, so
// editing lore/ stays the way you change what characters know.
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import type { NPCCharacter } from './gemma';

const PROFILE_PATH = join(process.cwd(), 'lore', 'adrian_profile.txt');

// Sections are delimited the same way the other lore files delimit theirs:
// `--- TITLE ---` on its own line.
function extractSection(raw: string, title: string): string {
  const pattern = new RegExp(`^---\\s*${title}[^-]*---$`, 'm');
  const start = raw.search(pattern);
  if (start === -1) return '';

  const afterHeader = raw.slice(start).replace(pattern, '');
  const next = afterHeader.search(/^---\s*.+?\s*---$/m);
  return (next === -1 ? afterHeader : afterHeader.slice(0, next)).trim();
}

// Inside THINGS THE NPCS KNOW ABOUT ADRIAN, each character has her own
// bulleted list under a "<Name> knows:" heading. These must NOT be merged:
// Yuki remembers his coffee order from secondary school and Shiori knows he's
// been asking about Hiyori more than casually — handing either fact to the
// other character breaks the siloed-knowledge rule the whole design rests on.
function extractCharacterKnowledge(raw: string, name: string): string {
  const section = extractSection(raw, 'THINGS THE NPCS KNOW ABOUT ADRIAN');
  const pattern = new RegExp(`^${name} knows:$`, 'im');
  const start = section.search(pattern);
  if (start === -1) return '';

  const after = section.slice(start).replace(pattern, '');
  const next = after.search(/^\w+ knows:$/im);
  return (next === -1 ? after : after.slice(0, next)).trim();
}

// Read once at module load. The file is static lore and the process is
// short-lived; re-reading per turn would just add filesystem work to a path
// that already waits on an LLM.
const RAW = readFileSync(PROFILE_PATH, 'utf-8');

// Shared across all three characters — how he comes across to anyone who has
// spent time with him.
//
// Deliberately NOT the BACKGROUND section, which reads "He met Hiyori through
// Shiori. He didn't think much of it at first. That has changed." That is
// Adrian's internal state, and putting it in Hiyori's prompt would tell her
// how he feels — the single thing the entire thirty-day game is built around
// her not knowing.
const SHARED = extractSection(RAW, 'PERSONALITY');

const PER_CHARACTER: Record<NPCCharacter, string> = {
  hiyori: '',
  shiori: extractCharacterKnowledge(RAW, 'Shiori'),
  yuki: extractCharacterKnowledge(RAW, 'Yuki'),
};

/**
 * Adrian as this character perceives him, ready to drop into a prompt.
 *
 * Hiyori gets only the shared read on his manner: she met him this semester
 * through Shiori and knows nothing about him beyond what she has observed —
 * which is exactly what her accumulated dynamic chunks are for.
 */
export function adrianProfileFor(character: NPCCharacter): string {
  const specific = PER_CHARACTER[character];
  return specific ? `${SHARED}\n\nWhat ${character[0].toUpperCase() + character.slice(1)} knows about him specifically:\n${specific}` : SHARED;
}
