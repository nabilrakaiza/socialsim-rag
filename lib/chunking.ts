// ============================================================
// lib/chunking.ts
//
// Turns a raw lore file into an array of LoreChunk objects
// ready for embedding + storage.
//
// Scope (per our chat): this is for the STATIC lore files only
// (adrian_profile.txt, hiyori_backstory.txt, hiyori_interests.txt,
// shiori_knowledge.txt, yuki_knowledge.txt, hiyori_diary.txt,
// events.json). Dynamic content generated during gameplay will
// be emitted already chunk-shaped, bypassing this file entirely.
// ============================================================

export interface LoreChunk {
  content: string;
  character: 'hiyori' | 'shiori' | 'yuki' | 'adrian' | 'events';
  source_file: string;
  chunk_index: number;
  // Widened from the literal `true` this started as: chunkLoreFile below
  // always produces static: true, but end-of-day batch eval will build
  // dynamic (is_static: false, session_id set) chunks by hand — same
  // shape, same insertLoreChunks() insert path, no separate type needed.
  is_static: boolean;
  session_id?: string;
  section_title?: string;
}

interface EventData {
  id: string;
  title: string;
  description: string;
  stage_required: string;
  affection_required: number;
  type: string;
  duration_days: number;
  randomized_details: Record<string, string[]>;
  player_action_prompt: string;
  affection_outcomes: {
    high: string;
    mid: string;
    low: string;
  };
}

// ------------------------------------------------------------
// Entry point — dispatch by filename. Diary is checked before
// the generic section splitter since it's also a .txt file.
// ------------------------------------------------------------
export function chunkLoreFile(filePath: string, rawText: string): LoreChunk[] {
  // derive character from the filename prefix (hiyori_, shiori_, etc.)
  function getCharacter(filename: string): LoreChunk['character'] {
    if (filename.includes('hiyori')) return 'hiyori';
    if (filename.includes('shiori')) return 'shiori';
    if (filename.includes('yuki')) return 'yuki';
    if (filename.includes('adrian')) return 'adrian';
    return 'events';
  }

  // Strip any directory prefix. Everything below dispatches on and stores this
  // rather than filePath: an absolute path makes source_file machine-specific,
  // which breaks anything that compares against it (see eval/retrieval-golden.json),
  // and lets a parent directory name leak into the "diary"/character matching.
  const pathParts = filePath.split("/");
  const filename = pathParts[pathParts.length - 1];

  if (filename.endsWith(".json")){
    const rawChunks = chunkEvents(rawText);
    const loreChunks: LoreChunk[] = rawChunks.map((chunk, index) => ({
        ...chunk,
        character: getCharacter(filename),
        source_file: filename,
        chunk_index: index,
        is_static: true
    }))

    return loreChunks
  }

  else if (filename.includes("diary")){
    const rawChunks = chunkDiary(rawText);
    const loreChunks: LoreChunk[] = rawChunks.map((chunk, index) => ({
        ...chunk,
        character: getCharacter(filename),
        source_file: filename,
        chunk_index: index,
        is_static: true
    }))

    return loreChunks
  }

  else {
    const rawChunks = chunkSections(rawText);
    const loreChunks: LoreChunk[] = rawChunks.map((chunk, index) => ({
        ...chunk,
        character: getCharacter(filename),
        source_file: filename,
        chunk_index: index,
        is_static: true
    }))

    return loreChunks
  }
}

// ------------------------------------------------------------
// Strategy 1: section-header files (backstory / interests /
// knowledge / profile .txt files). Delimiter looks like:
//   --- PERSONALITY ---   (on its own line)
// Text before the first header (e.g. the name/stats block in
// adrian_profile.txt and shiori_knowledge.txt) becomes its own
// chunk with no section_title.
// ------------------------------------------------------------
function chunkSections(rawText: string): { content: string; section_title?: string }[] {
  const regex = /^---\s*(.+?)\s*---$/gm
  const matches = [...rawText.matchAll(regex)]

  const introText = rawText.slice(0, matches[0]?.index).trim();

  const sectionChunks: { content: string; section_title?: string }[] = matches.map((match, i) => ({
    content: rawText.slice(match.index + match[0].length, matches[i + 1]?.index ?? rawText.length).trim(),
    section_title: match[1]
  }))

  if (introText.length > 0) {
    sectionChunks.unshift({ content: introText });
  }

  return sectionChunks;
}

// ------------------------------------------------------------
// Strategy 2: diary entries (hiyori_diary.txt). Entries are
// separated by a bare `---` on its own line, and each entry has
// a bracketed header somewhere inside it, e.g:
//   [3 months before sem starts — June, Summer Break]
// The first block also contains the file's intro banner glued
// onto entry 1 (there's no `---` before it in the source file) —
// accepted as-is rather than a bug worth solving.
// ------------------------------------------------------------
function chunkDiary(rawText: string): { content: string; section_title?: string }[] {
  const regex = /^---$/gm
  const blocks = rawText.split(regex);

  const regexHeader = /^\[(.+?)\]$/m

  const diaryChunks: { content: string; section_title?: string }[] = blocks.map((block) => {
    const headerMatch = block.match(regexHeader);
    const content = block.replace(headerMatch?.[0] ?? '', '').trim();

    return {
      content,
      section_title: headerMatch?.[1]
    };
  })

  return diaryChunks;
}

// ------------------------------------------------------------
// Strategy 3: events.json — one chunk per event object.
// content is a natural-language paragraph (not raw JSON) so it
// matches how a player would actually phrase a query.
// randomized_details is skipped — it's template placeholders
// for the game engine, not something a player would search for.
// ------------------------------------------------------------
function chunkEvents(rawText: string): { content: string; section_title?: string }[] {
  const parsedJSON: {events: EventData[]} = JSON.parse(rawText);
  const eventChunks: {content: string; section_title?: string}[] = parsedJSON.events.map((event) => ({
    content: `${event.title}. ${event.description}\nIf handled well: ${event.affection_outcomes.high}\nIf handled decently: ${event.affection_outcomes.mid}\nIf handled poorly: ${event.affection_outcomes.low}`,
    section_title: event.title
  }))

  return eventChunks;
}
