import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getVaultAssetBlobUrl, getVaultFileText } from '../lib/githubApi';
import {
  buildYouTubeTimestampUrl,
  isImageAsset,
  parseNoteSections,
  resolveAssetRepoPath,
  stripFrontmatter,
  type SearchIndexEntry,
  type SearchIndexPayload,
} from '../lib/kbTypes';
import { isGithubConfigured, type ByokSettings } from '../lib/storage';

interface KnowledgeBrowserProps {
  settings: ByokSettings;
  selectedNoteId?: string | null;
  onClearSelectedNote?: () => void;
  onGoSettings: () => void;
}

const TYPE_FILTERS = ['all', 'screenshot', 'article', 'youtube', 'ig_video', 'podcast', 'book'];

export const KnowledgeBrowser: React.FC<KnowledgeBrowserProps> = ({
  settings,
  selectedNoteId,
  onClearSelectedNote,
  onGoSettings,
}) => {
  const [indexData, setIndexData] = useState<SearchIndexPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('');

  const [activeNote, setActiveNote] = useState<SearchIndexEntry | null>(null);
  const [detailTab, setDetailTab] = useState<'summary' | 'transcript'>('summary');
  const [noteBody, setNoteBody] = useState<string>('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [assetUrls, setAssetUrls] = useState<{ path: string; url: string }[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<{ path: string; url: string } | null>(null);

  const configured = isGithubConfigured(settings);

  const fetchIndex = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await getVaultFileText(settings, 'index/search-index.json');
      const parsed = JSON.parse(raw) as SearchIndexPayload;
      setIndexData(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取 search-index.json');
    } finally {
      setLoading(false);
    }
  }, [configured, settings]);

  useEffect(() => {
    fetchIndex();
  }, [fetchIndex]);

  const openNoteDetail = useCallback(
    async (entry: SearchIndexEntry) => {
      setActiveNote(entry);
      setNoteBody('');
      setNoteLoading(true);
      // Revoke old blob URLs
      setAssetUrls((prev) => {
        prev.forEach((a) => URL.revokeObjectURL(a.url));
        return [];
      });

      try {
        const md = await getVaultFileText(settings, entry.path);
        setNoteBody(stripFrontmatter(md));

        const imgAssets = (entry.raw_assets || []).filter(isImageAsset);
        const loaded: { path: string; url: string }[] = [];
        for (const rawRel of imgAssets) {
          const repoPath = resolveAssetRepoPath(rawRel);
          try {
            const blobUrl = await getVaultAssetBlobUrl(settings, repoPath);
            loaded.push({ path: repoPath, url: blobUrl });
          } catch {
            // Skip unreadable asset without crashing note view
          }
        }
        setAssetUrls(loaded);
      } catch (err) {
        setNoteBody(err instanceof Error ? `讀取失敗：${err.message}` : '讀取筆記失敗');
      } finally {
        setNoteLoading(false);
      }
    },
    [settings]
  );

  // Support jumping directly from AskView citation cards
  useEffect(() => {
    if (!selectedNoteId || !indexData?.notes) return;
    const found = indexData.notes.find((n) => n.id === selectedNoteId);
    if (found) {
      openNoteDetail(found);
      onClearSelectedNote?.();
    }
  }, [selectedNoteId, indexData, openNoteDetail, onClearSelectedNote]);

  useEffect(() => {
    return () => {
      assetUrls.forEach((a) => URL.revokeObjectURL(a.url));
    };
  }, [assetUrls]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    (indexData?.notes || []).forEach((n) => (n.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).slice(0, 12);
  }, [indexData]);

  const filteredNotes = useMemo(() => {
    const notes = indexData?.notes || [];
    const q = query.trim().toLowerCase();
    return notes.filter((n) => {
      if (typeFilter !== 'all' && n.source_type !== typeFilter) return false;
      if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
      if (!q) return true;
      return (
        n.title.toLowerCase().includes(q) ||
        n.user_summary.toLowerCase().includes(q) ||
        n.excerpt.toLowerCase().includes(q) ||
        n.category.toLowerCase().includes(q) ||
        (n.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [indexData, query, typeFilter, tagFilter]);

  if (!configured) {
    return (
      <section className="dj-card p-5 space-y-3">
        <div className="text-[11px] tracking-[0.16em] text-[#6E7371] dj-tnum">
          [ 02 ] SEARCH INDEX
        </div>
        <div className="text-xs text-[#9A9E9C]">
          尚未設定私有倉 `kb-vault` 憑證，無法讀取知識索引。
        </div>
        <button type="button" onClick={onGoSettings} className="dj-btn text-xs">
          前往設定頁
        </button>
      </section>
    );
  }

  // Note Detail View
  if (activeNote) {
    const parsed = parseNoteSections(noteBody);
    const hasTranscript = Boolean(parsed.transcript || parsed.ocrText);

    return (
      <section className="space-y-4 dj-enter-right">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveNote(null);
              setDetailTab('summary');
            }}
            className="dj-btn px-3 text-xs"
          >
            ← 返回列表
          </button>
          <span className="text-[11px] dj-tnum text-[#6E7371]">
            {activeNote.source_type.toUpperCase()} / {activeNote.status}
          </span>
        </div>

        <article className="dj-card p-4 space-y-4">
          <header className="border-b border-[rgba(255,255,255,0.12)] pb-3 space-y-1.5">
            <div className="text-[11px] dj-tnum text-[#6E7371]">
              {activeNote.created_at} · {activeNote.category}
            </div>
            <h2 className="dj-font-serif text-lg font-semibold text-[#F4F4F0] leading-snug">
              {activeNote.title}
            </h2>
            {activeNote.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {activeNote.tags.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 border border-[rgba(255,255,255,0.14)] text-[#9A9E9C]"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* 摘要 | 逐字稿 Sub-tabs */}
          {hasTranscript && (
            <div className="grid grid-cols-2 border-b border-[rgba(255,255,255,0.12)]">
              <button
                type="button"
                onClick={() => setDetailTab('summary')}
                className={`min-h-[48px] text-xs tracking-[0.14em] border-b-2 transition-colors ${
                  detailTab === 'summary'
                    ? 'border-[#6FA88B] text-[#F4F4F0]'
                    : 'border-transparent text-[#6E7371]'
                }`}
              >
                摘要
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('transcript')}
                className={`min-h-[48px] text-xs tracking-[0.14em] border-b-2 transition-colors ${
                  detailTab === 'transcript'
                    ? 'border-[#6FA88B] text-[#F4F4F0]'
                    : 'border-transparent text-[#6E7371]'
                }`}
              >
                {parsed.ocrText && !parsed.transcript ? 'OCR 原文' : '逐字稿'}
              </button>
            </div>
          )}

          {noteLoading ? (
            <div className="text-xs text-[#9A9E9C] py-4">讀取私有筆記全文中...</div>
          ) : detailTab === 'transcript' && hasTranscript ? (
            <pre className="text-xs text-[#D4D6D4] whitespace-pre-wrap font-sans leading-relaxed break-words dj-enter-right">
              {parsed.transcript || parsed.ocrText}
            </pre>
          ) : (
            <div className="space-y-5 dj-enter-left">
              {activeNote.user_summary && (
                <div className="border-l-2 border-l-[#6FA88B] pl-3 py-1 bg-[rgba(111,168,139,0.06)]">
                  <div className="text-[10px] tracking-[0.14em] text-[#6FA88B] uppercase mb-1">
                    USER NOTE
                  </div>
                  <p className="text-xs text-[#F4F4F0] whitespace-pre-wrap">
                    {activeNote.user_summary}
                  </p>
                </div>
              )}

              {/* KEY POINTS / 重點整理 (時間點／行號卡片) */}
              {parsed.timelinePoints.length > 0 && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] tracking-[0.16em] text-[#9A9E9C] uppercase">
                      KEY POINTS / 重點整理
                    </span>
                    <span className="text-[10px] dj-tnum text-[#6E7371]">
                      {parsed.timelinePoints.length} 項
                    </span>
                  </div>
                  <div className="space-y-2">
                    {parsed.timelinePoints.map((tp, idx) => {
                      const jumpUrl = buildYouTubeTimestampUrl(activeNote.source_url, tp.location);
                      return (
                        <div
                          key={`${tp.location}-${idx}`}
                          className="p-3 bg-[#1E2025] border border-[rgba(255,255,255,0.1)] space-y-1.5"
                        >
                          <div className="flex items-center gap-2">
                            {jumpUrl ? (
                              <a
                                href={jumpUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] dj-tnum px-2 py-0.5 bg-[rgba(111,168,139,0.18)] border border-[rgba(111,168,139,0.45)] text-[#F4F4F0]"
                              >
                                ▶ {tp.location}
                              </a>
                            ) : (
                              <span className="text-[11px] dj-tnum px-2 py-0.5 bg-[rgba(255,255,255,0.06)] border border-[rgba(255,255,255,0.14)] text-[#6FA88B]">
                                {tp.location}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-[#F4F4F0] leading-relaxed">{tp.point}</div>
                          {tp.quote && (
                            <div className="text-[11px] text-[#9A9E9C] border-l border-[rgba(255,255,255,0.2)] pl-2">
                              {tp.quote}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 重要畫面 (2 欄網格 + 點擊放大燈箱) */}
              {assetUrls.length > 0 && (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] tracking-[0.16em] text-[#9A9E9C] uppercase">
                      重要畫面
                    </span>
                    <span className="text-[10px] dj-tnum text-[#6E7371]">
                      {assetUrls.length} 張 · 點圖片放大
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {assetUrls.map((asset) => {
                      const caption = parsed.imageCaptions[asset.path] || '';
                      const [badge, desc] = caption.includes(' | ')
                        ? caption.split(' | ', 2)
                        : ['', caption];
                      return (
                        <button
                          key={asset.path}
                          type="button"
                          onClick={() => setLightboxUrl(asset)}
                          className="dj-card p-0 text-left overflow-hidden cursor-zoom-in hover:border-[rgba(255,255,255,0.36)] transition-colors flex flex-col"
                        >
                          <div className="dj-curtain-wrap w-full aspect-video bg-[#0E0F12]">
                            <img
                              src={asset.url}
                              alt={caption || asset.path}
                              className="dj-curtain-media is-revealed w-full h-full object-cover"
                            />
                          </div>
                          {(badge || desc) && (
                            <div className="p-2 space-y-1">
                              {badge && (
                                <span className="inline-block text-[10px] dj-tnum px-1.5 py-0.5 bg-[rgba(111,168,139,0.16)] border border-[rgba(111,168,139,0.4)] text-[#F4F4F0]">
                                  ▶ {badge}
                                </span>
                              )}
                              {desc && (
                                <div className="text-[11px] text-[#D4D6D4] line-clamp-2 leading-snug">
                                  {desc}
                                </div>
                              )}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* AI 結構化摘要總覽 */}
              {(parsed.summaryBullets.length > 0 || parsed.summaryParagraph) && (
                <div className="space-y-2">
                  <div className="text-[10px] tracking-[0.16em] text-[#9A9E9C] uppercase">
                    AI 結構化摘要
                  </div>
                  {parsed.summaryBullets.length > 0 && (
                    <ul className="space-y-1.5 text-xs text-[#D4D6D4]">
                      {parsed.summaryBullets.map((b, i) => (
                        <li key={i} className="leading-relaxed">
                          · {b}
                        </li>
                      ))}
                    </ul>
                  )}
                  {parsed.summaryParagraph && (
                    <p className="text-xs text-[#9A9E9C] leading-relaxed">
                      {parsed.summaryParagraph}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {activeNote.source_url && (
            <div className="pt-2 border-t border-[rgba(255,255,255,0.12)]">
              <a
                href={activeNote.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[#6FA88B] underline break-all"
              >
                {activeNote.source_url}
              </a>
            </div>
          )}
        </article>

        {/* Fullscreen Lightbox */}
        {lightboxUrl && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 bg-[rgba(10,11,14,0.94)] backdrop-blur-md flex flex-col p-4 safe-top safe-bottom"
          >
            <div className="flex items-center justify-between gap-2 pb-3">
              <span className="text-[11px] dj-tnum text-[#9A9E9C] truncate">
                {lightboxUrl.path}
              </span>
              <button
                type="button"
                onClick={() => setLightboxUrl(null)}
                className="dj-btn px-4 text-xs shrink-0"
              >
                關閉 ✕
              </button>
            </div>
            <div
              className="flex-1 flex items-center justify-center overflow-auto"
              onClick={() => setLightboxUrl(null)}
            >
              <img
                src={lightboxUrl.url}
                alt={lightboxUrl.path}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          </div>
        )}
      </section>
    );
  }

  // List & Search View
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] tracking-[0.16em] text-[#9A9E9C] uppercase">
          [ 02 ] SEARCH INDEX
        </span>
        <button
          type="button"
          onClick={fetchIndex}
          disabled={loading}
          className="dj-btn px-3 text-xs min-h-[48px]"
        >
          {loading ? '同步中...' : `重新整理 (${indexData?.total ?? 0})`}
        </button>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜尋標題、初步重點、標籤或內文..."
        className="dj-input"
      />

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TYPE_FILTERS.map((tp) => {
          const active = typeFilter === tp;
          return (
            <button
              key={tp}
              type="button"
              onClick={() => setTypeFilter(tp)}
              className={`dj-btn px-3 text-[11px] shrink-0 ${
                active ? 'dj-btn-primary text-[#F4F4F0]' : 'text-[#9A9E9C]'
              }`}
            >
              {tp === 'all' ? '全部' : tp}
            </button>
          );
        })}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => {
            const active = tagFilter === tag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(active ? '' : tag)}
                className={`text-[11px] px-2.5 py-1.5 border transition-colors ${
                  active
                    ? 'border-[#6FA88B] text-[#F4F4F0] bg-[rgba(111,168,139,0.16)]'
                    : 'border-[rgba(255,255,255,0.14)] text-[#9A9E9C]'
                }`}
              >
                #{tag}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div className="dj-card p-3 border-l-2 border-l-[#D47A7A] text-xs text-[#F4F4F0]">
          {error}
        </div>
      )}

      <div className="space-y-2.5">
        {filteredNotes.length === 0 && !loading && (
          <div className="dj-card p-5 text-xs text-[#9A9E9C]">
            沒有符合條件的知識筆記。
          </div>
        )}

        {filteredNotes.map((note, idx) => (
          <button
            key={note.id}
            type="button"
            onClick={() => openNoteDetail(note)}
            className="dj-card w-full text-left p-4 hover:border-[rgba(255,255,255,0.36)] transition-colors space-y-1.5 block"
          >
            <div className="flex items-center justify-between text-[10px] dj-tnum text-[#6E7371]">
              <span>
                [ {String(idx + 1).padStart(2, '0')} ] {note.source_type.toUpperCase()} · {note.category}
              </span>
              <span>{note.created_at.slice(0, 10)}</span>
            </div>
            <div className="dj-font-serif text-[15px] font-semibold text-[#F4F4F0] leading-snug">
              {note.title}
            </div>
            {note.user_summary && (
              <p className="text-xs text-[#6FA88B] line-clamp-2">{note.user_summary}</p>
            )}
            <p className="text-xs text-[#9A9E9C] line-clamp-2">{note.excerpt}</p>
            <div className="flex items-center justify-between pt-1">
              <div className="flex flex-wrap gap-1">
                {(note.tags || []).slice(0, 4).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-1.5 py-0.5 border border-[rgba(255,255,255,0.12)] text-[#9A9E9C]"
                  >
                    #{t}
                  </span>
                ))}
              </div>
              {note.raw_assets?.length > 0 && (
                <span className="text-[10px] dj-tnum text-[#9A9E9C]">
                  [{note.raw_assets.length} 附件]
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
};
