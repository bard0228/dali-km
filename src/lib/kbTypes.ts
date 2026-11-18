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

export interface TimelinePointItem {
  location: string;
  point: string;
  quote: string;
}

export interface ParsedNoteSections {
  summaryBullets: string[];
  summaryParagraph: string;
  timelinePoints: TimelinePointItem[];
  imageCaptions: Record<string, string>;
  transcript: string;
  ocrText: string;
  rawBody: string;
}

export function parseNoteSections(body: string): ParsedNoteSections {
  const sections: Record<string, string> = {};
  const parts = body.split(/^##\s+/m);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const heading = part.slice(0, nl).trim();
    const content = part.slice(nl + 1).trim();
    sections[heading] = content;
  }

  const aiRaw = sections['AI 結構化摘要'] || '';
  const summaryBullets: string[] = [];
  const paraLines: string[] = [];
  for (const ln of aiRaw.split('\n')) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('- ')) {
      summaryBullets.push(trimmed.slice(2).trim());
    } else {
      paraLines.push(trimmed);
    }
  }

  const tlRaw = sections['各時間點／段落詳細重點'] || '';
  const timelinePoints: TimelinePointItem[] = [];
  for (const ln of tlRaw.split('\n')) {
    const m = ln.trim().match(/^-\s+\*\*\[([^\]]+)\]\*\*\s*(.+)$/);
    if (!m) continue;
    const loc = m[1].trim();
    let rest = m[2].trim();
    let quote = '';
    const qm = rest.match(/（金句：`([^`]+)`）$/);
    if (qm) {
      quote = qm[1].trim();
      rest = rest.slice(0, qm.index).trim();
    }
    timelinePoints.push({ location: loc, point: rest, quote });
  }

  const imgRaw = sections['詳細重點畫面'] || sections['原始附件'] || sections['原始截圖'] || '';
  const imageCaptions: Record<string, string> = {};
  for (const ln of imgRaw.split('\n')) {
    const im = ln.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (im) {
      imageCaptions[resolveAssetRepoPath(im[2].trim())] = im[1].trim();
    }
  }

  return {
    summaryBullets,
    summaryParagraph: paraLines.join('\n'),
    timelinePoints,
    imageCaptions,
    transcript: sections['逐字稿'] || '',
    ocrText: sections['隨附截圖 OCR 原文'] || sections['全圖 OCR 原文'] || '',
    rawBody: body,
  };
}

export function buildYouTubeTimestampUrl(sourceUrl: string, location: string): string | null {
  if (!sourceUrl || (!sourceUrl.includes('youtube.com') && !sourceUrl.includes('youtu.be'))) {
    return null;
  }
  const parts = location.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  let seconds = 0;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;
  const sep = sourceUrl.includes('?') ? '&' : '?';
  return `${sourceUrl}${sep}t=${seconds}s`;
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
