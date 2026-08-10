// ============================================================
// lib/chunking.ts
//
// Turns a raw lore file into an array of LoreChunk objects
// ready for embedding + storage.
//
// Scope: the retrievable static lore files only — hiyori_backstory.txt,
// hiyori_interests.txt, hiyori_diary.txt, shiori_knowledge.txt,
// yuki_knowledge.txt. Dynamic content generated during gameplay is emitted
// already chunk-shaped and bypasses this file entirely.
//
// events.json and adrian_profile.txt used to be chunked here and no longer
// are: nothing could retrieve either (see LoreChunk.character), the event
// chunks embedded their own affection_outcomes and so were scoring-rubric
// spoilers, and Adrian's profile is now a fixed prompt block in
// lib/adrian-profile.ts. What a character learns from an event she lived
// through still reaches her — via the dynamic knowledge chunk that
// lib/batch-eval.ts writes at end of day.
// ============================================================

export interface LoreChunk {
  content: string;
  // Only the three NPCs. Retrieval is only ever called with one of these
  // (matchLoreChunks/matchLoreHybrid take an NPCCharacter), so a chunk filed
  // under anything else is unreachable by construction — which is exactly what
  // happened to the 'adrian' and 'events' chunks before they were removed.
  character: 'hiyori' | 'shiori' | 'yuki';
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

// Which lore files carry a character's memory, and so belong in the vector
// store. Everything else in lore/ is reference material for the game engine or
// for humans — events.json is read directly by lib/events.ts, diary_system.md
// documents the trigger rules, adrian_profile.txt is a prompt block.
export function isRetrievableLoreFile(filename: string): boolean {
  return /\.txt$/.test(filename) && /hiyori|shiori|yuki/.test(filename);
}

// ------------------------------------------------------------
// Entry point — dispatch by filename. Diary is checked before
// the generic section splitter since it's also a .txt file.
// ------------------------------------------------------------
export function chunkLoreFile(filePath: string, rawText: string): LoreChunk[] {
  // derive character from the filename prefix (hiyori_, shiori_, etc.)
  //
  // Throws rather than falling back: a silent default is how 34 chunks ended
  // up filed under characters nothing could ever search for. scripts/ingest.ts
  // filters to retrievable files before calling this, so reaching the throw
  // means a new lore file was added without deciding whose memory it belongs
  // to.
  function getCharacter(filename: string): LoreChunk['character'] {
    if (filename.includes('hiyori')) return 'hiyori';
    if (filename.includes('shiori')) return 'shiori';
    if (filename.includes('yuki')) return 'yuki';
    throw new Error(`${filename} doesn't belong to an NPC — see isRetrievableLoreFile`);
  }

  // Strip any directory prefix. Everything below dispatches on and stores this
  // rather than filePath: an absolute path makes source_file machine-specific,
  // which breaks anything that compares against it (see eval/retrieval-golden.json),
  // and lets a parent directory name leak into the "diary"/character matching.
  const pathParts = filePath.split("/");
  const filename = pathParts[pathParts.length - 1];

  if (filename.includes("diary")){
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
// knowledge .txt files). Delimiter looks like:
//   --- PERSONALITY ---   (on its own line)
// Text before the first header (e.g. the name/stats block in
// shiori_knowledge.txt) becomes its own chunk with no
// section_title.
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

