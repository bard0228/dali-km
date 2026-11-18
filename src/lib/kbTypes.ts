export interface SearchIndexEntry {
  id: string;
  title: string;
  source_type: 'screenshot' | 'article' | 'youtube' | 'ig_video' | 'podcast' | 'book' | string;
  status: 'completed' | 'partial_capture' | 'in_progress' | string;
  category: string;
  tags: string[];
  source_url: string;
  raw_assets: string[];
  user_summary: string;
  created_at: string;
  path: string;
  excerpt: string;
  word_count: number;
}

export interface SearchIndexPayload {
  version: number;
  generated_at: string;
  total: number;
  notes: SearchIndexEntry[];
}

export function resolveAssetRepoPath(rawAsset: string): string {
  return rawAsset.replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
}

export function isImageAsset(pathStr: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(pathStr);
}

/** Strip YAML frontmatter from a Knowledge Note Markdown string */
export function stripFrontmatter(md: string): string {
  const match = md.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
  return match ? match[1].trim() : md.trim();
}

/** Local zero-cost Top-K keyword & tag retrieval over search-index.json */
export function rankNotesByQuery(
  notes: SearchIndexEntry[],
  query: string,
  topK = 4
): SearchIndexEntry[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return notes.slice(0, topK);

  const tokens = clean
    .split(/[\s,，、。？！?!]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1);

  const scored = notes.map((note) => {
    let score = 0;
    const titleLow = note.title.toLowerCase();
    const summaryLow = note.user_summary.toLowerCase();
    const excerptLow = note.excerpt.toLowerCase();
    const catLow = note.category.toLowerCase();
    const tagsLow = note.tags.map((t) => t.toLowerCase());

    if (titleLow.includes(clean)) score += 10;
    if (summaryLow.includes(clean)) score += 8;
    if (excerptLow.includes(clean)) score += 5;

    for (const tok of tokens) {
      if (titleLow.includes(tok)) score += 5;
      if (tagsLow.some((tg) => tg.includes(tok))) score += 6;
      if (catLow.includes(tok)) score += 4;
      if (summaryLow.includes(tok)) score += 4;
      if (excerptLow.includes(tok)) score += 2;
    }

    return { note, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const positives = scored.filter((s) => s.score > 0).slice(0, topK);
  if (positives.length > 0) return positives.map((s) => s.note);
  return notes.slice(0, Math.min(topK, notes.length));
}
