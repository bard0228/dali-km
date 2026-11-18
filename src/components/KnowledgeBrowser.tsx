import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getVaultAssetBlobUrl, getVaultFileText } from '../lib/githubApi';
import {
  buildYouTubeTimestampUrl,
  extractStructuredJson,
  formatNoteForLineShare,
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

const TYPE_FILTERS = [
  'all',
  'youtube',
  'ig_video',
  'article',
  'podcast',
  'screenshot',
  'document_ocr',
  'book_recon',
  'book',
];

const TYPE_LABEL_MAP: Record<string, string> = {
  all: '全部',
  youtube: 'YouTube',
  ig_video: 'IG/短片',
  article: '文章',
  podcast: 'Podcast',
  screenshot: '截圖',
  document_ocr: '文件OCR',
  book_recon: '搜書',
  book: '電子書',
};

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
  const [detailTab, setDetailTab] = useState<'summary' | 'keyframes' | 'transcript' | 'factcheck'>('summary');
  const [detailMode, setDetailMode] = useState<'detailed' | 'concise'>(
    settings.defaultDetailLevel || 'detailed'
  );
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [copyToast, setCopyToast] = useState<string | null>(null);

  const [noteRawMd, setNoteRawMd] = useState<string>('');
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

  useEffect(() => {
    return () => {
      assetUrls.forEach((a) => URL.revokeObjectURL(a.url));
    };
  }, [assetUrls]);

  const openNote = useCallback(
    async (entry: SearchIndexEntry) => {
      setActiveNote(entry);
      setDetailTab('summary');
      setTranscriptQuery('');
      setNoteLoading(true);
      setNoteRawMd('');
      setNoteBody('');
      setAssetUrls((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.url));
        return [];
      });

      try {
        const md = await getVaultFileText(settings, entry.path);
        setNoteRawMd(md);
        setNoteBody(stripFrontmatter(md));

        const imagePaths = entry.raw_assets
          .map(resolveAssetRepoPath)
          .filter(isImageAsset);

        const loaded: { path: string; url: string }[] = [];
        for (const p of imagePaths) {
          try {
            const url = await getVaultAssetBlobUrl(settings, p);
            loaded.push({ path: p, url });
          } catch {
            // Skip missing/unavailable assets gracefully
          }
        }
        setAssetUrls(loaded);
      } catch (err) {
        setNoteBody(
          `讀取筆記失敗：${err instanceof Error ? err.message : '未知錯誤'}`
        );
      } finally {
        setNoteLoading(false);
      }
    },
    [settings]
  );

  useEffect(() => {
    if (!selectedNoteId || !indexData) return;
    const found = indexData.notes.find((n) => n.id === selectedNoteId);
    if (found) {
      openNote(found);
      onClearSelectedNote?.();
    }
  }, [selectedNoteId, indexData, openNote, onClearSelectedNote]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    indexData?.notes.forEach((n) => n.tags.forEach((t) => set.add(t)));
    return Array.from(set).slice(0, 16);
  }, [indexData]);

  const filteredNotes = useMemo(() => {
    if (!indexData) return [];
    const q = query.trim().toLowerCase();
    return indexData.notes.filter((n) => {
      if (typeFilter !== 'all' && n.source_type !== typeFilter) return false;
      if (tagFilter && !n.tags.includes(tagFilter)) return false;
      if (!q) return true;
      return (
        n.title.toLowerCase().includes(q) ||
        n.user_summary.toLowerCase().includes(q) ||
        (n.one_line_summary || '').toLowerCase().includes(q) ||
        n.excerpt.toLowerCase().includes(q) ||
        n.category.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [indexData, query, typeFilter, tagFilter]);

  const parsedSections = useMemo(() => parseNoteSections(noteBody), [noteBody]);
  const structured = useMemo(() => extractStructuredJson(noteBody), [noteBody]);

  const assetUrlMap = useMemo(() => {
    const map = new Map<string, string>();
    assetUrls.forEach((a) => map.set(a.path, a.url));
    return map;
  }, [assetUrls]);

  const handleCopyLine = async () => {
    if (!activeNote) return;
    const text = formatNoteForLineShare(
      activeNote.title,
      activeNote.source_url,
      structured,
      parsedSections.summaryBullets
    );
    try {
      await navigator.clipboard.writeText(text);
      setCopyToast('已複製 LINE 精華格式');
      setTimeout(() => setCopyToast(null), 2000);
    } catch {
      setCopyToast('複製失敗，請手動選取');
      setTimeout(() => setCopyToast(null), 2000);
    }
  };

  const handleDownloadMd = () => {
    if (!activeNote || !noteRawMd) return;
    const blob = new Blob([noteRawMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeNote.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!configured) {
    return (
      <div className="dj-card p-5 space-y-3 text-center">
        <p className="text-sm text-[#9A9E9C]">尚未設定 GitHub Vault 連線憑證。</p>
        <button onClick={onGoSettings} className="dj-btn dj-btn-primary text-xs">
          前往 04 設定填入憑證
        </button>
      </div>
    );
  }

  if (activeNote) {
    const groupedKeyPoints = (() => {
      const kps = structured?.key_points || [];
      const slice = detailMode === 'concise' ? kps.slice(0, 8) : kps;
      const groups: { section: string; items: typeof kps }[] = [];
      for (const kp of slice) {
        const sec = kp.section || '核心重點';
        const last = groups[groups.length - 1];
        if (last && last.section === sec) {
          last.items.push(kp);
        } else {
          groups.push({ section: sec, items: [kp] });
        }
      }
      return groups;
    })();

    const keyFrames = structured?.key_frames || [];
    const transcriptRows = structured?.transcript || [];
    const filteredTranscript = transcriptQuery.trim()
      ? transcriptRows.filter(
          (r) =>
            r.x.toLowerCase().includes(transcriptQuery.trim().toLowerCase()) ||
            r.s.toLowerCase().includes(transcriptQuery.trim().toLowerCase())
        )
      : transcriptRows;
    const factItems = structured?.fact_check?.items || [];

    return (
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => setActiveNote(null)}
            className="text-xs tracking-[0.14em] text-[#9A9E9C] hover:text-[#F4F4F0] uppercase"
          >
            ← 返回知識列表
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopyLine}
              className="text-[11px] px-2 py-1 border border-[#252A2C] text-[#9A9E9C] hover:border-[#6FA88B] hover:text-[#F4F4F0]"
            >
              📋 複製 LINE
            </button>
            <button
              type="button"
              onClick={handleDownloadMd}
              className="text-[11px] px-2 py-1 border border-[#252A2C] text-[#9A9E9C] hover:border-[#6FA88B] hover:text-[#F4F4F0]"
            >
              ⬇ .md
            </button>
          </div>
        </div>

        {copyToast && (
          <div className="dj-card p-2 text-center text-xs text-[#6FA88B] border-l-2 border-l-[#6FA88B]">
            {copyToast}
          </div>
        )}

        <div className="dj-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#9A9E9C]">
            <span className="px-2 py-0.5 border border-[#252A2C] uppercase">
              {TYPE_LABEL_MAP[activeNote.source_type] || activeNote.source_type}
            </span>
            <span className="px-2 py-0.5 border border-[#252A2C] text-[#6FA88B]">
              {activeNote.category}
            </span>
            <span>{activeNote.created_at.slice(0, 10)}</span>
          </div>

          <h2 className="text-base font-medium text-[#F4F4F0] leading-snug">
            {activeNote.title}
          </h2>

          {structured?.one_line_summary && (
            <div className="p-2.5 bg-[#6FA88B]/10 border-l-2 border-l-[#6FA88B] text-xs text-[#E8ECEA] leading-relaxed">
              💡 {structured.one_line_summary}
            </div>
          )}

          {structured?.limited_note && (
            <div className="p-2.5 bg-[#D4A67A]/10 border-l-2 border-l-[#D4A67A] text-xs text-[#E8D5C4] leading-relaxed">
              ⚠️ {structured.limited_note}
            </div>
          )}

          {activeNote.source_url && (
            <a
              href={activeNote.source_url}
              target="_blank"
              rel="noreferrer"
              className="block text-xs text-[#6FA88B] underline truncate"
            >
              {activeNote.source_url}
            </a>
          )}

          {activeNote.user_summary && (
            <div className="p-3 bg-[#0B0D0F] border-l-2 border-l-[#6FA88B]">
              <div className="text-[10px] tracking-[0.14em] text-[#6FA88B] uppercase mb-1">
                使用者初步重點（置頂保留）
              </div>
              <p className="text-xs text-[#F4F4F0] whitespace-pre-wrap leading-relaxed">
                {activeNote.user_summary}
              </p>
            </div>
          )}

          {/* 四分頁切換 */}
          <div className="grid grid-cols-4 border-b border-[#252A2C] pt-1 text-[11px]">
            {[
              { id: 'summary' as const, label: '重點整理' },
              {
                id: 'keyframes' as const,
                label: `重點畫面${keyFrames.length || assetUrls.length ? ` (${keyFrames.length || assetUrls.length})` : ''}`,
              },
              { id: 'transcript' as const, label: '逐字稿' },
              {
                id: 'factcheck' as const,
                label: `事實查核${factItems.length ? ` (${factItems.length})` : ''}`,
              },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setDetailTab(t.id)}
                className={`py-2 text-center border-b-2 transition-colors truncate px-1 ${
                  detailTab === t.id
                    ? 'border-[#6FA88B] text-[#F4F4F0]'
                    : 'border-transparent text-[#9A9E9C]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {noteLoading ? (
            <div className="text-xs text-[#9A9E9C] py-6 text-center">載入筆記中...</div>
          ) : detailTab === 'summary' ? (
            <div className="space-y-4">
              {structured?.key_points && structured.key_points.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] tracking-[0.14em] text-[#9A9E9C] uppercase">
                      AI 結構化重點（共 {structured.key_points.length} 條）
                    </div>
                    <div className="flex border border-[#252A2C] text-[10px]">
                      <button
                        type="button"
                        onClick={() => setDetailMode('detailed')}
                        className={`px-2 py-0.5 ${
                          detailMode === 'detailed'
                            ? 'bg-[#6FA88B]/20 text-[#F4F4F0]'
                            : 'text-[#9A9E9C]'
                        }`}
                      >
                        詳細
                      </button>
                      <button
                        type="button"
                        onClick={() => setDetailMode('concise')}
                        className={`px-2 py-0.5 ${
                          detailMode === 'concise'
                            ? 'bg-[#6FA88B]/20 text-[#F4F4F0]'
                            : 'text-[#9A9E9C]'
                        }`}
                      >
                        精簡
                      </button>
                    </div>
                  </div>

                  {groupedKeyPoints.map((grp, gIdx) => (
                    <div key={gIdx} className="space-y-1.5">
                      <div className="text-[11px] font-medium text-[#6FA88B] tracking-wide border-b border-[#252A2C] pb-1">
                        {grp.section}
                      </div>
                      <ul className="space-y-2">
                        {grp.items.map((kp, idx) => {
                          const jumpUrl = kp.timestamp
                            ? buildYouTubeTimestampUrl(activeNote.source_url, kp.timestamp)
                            : null;
                          return (
                            <li key={idx} className="p-2.5 bg-[#0B0D0F] border border-[#1E2224] space-y-1">
                              <div className="flex items-start gap-2">
                                {kp.timestamp &&
                                  (jumpUrl ? (
                                    <a
                                      href={jumpUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="shrink-0 px-1.5 py-0.5 text-[10px] bg-[#16261E] border border-[#253B30] text-[#6FA88B] hover:underline"
                                    >
                                      {kp.timestamp}
                                    </a>
                                  ) : (
                                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] bg-[#16261E] border border-[#253B30] text-[#6FA88B]">
                                      {kp.timestamp}
                                    </span>
                                  ))}
                                <span className="text-xs font-medium text-[#F4F4F0] leading-snug">
                                  {kp.point}
                                </span>
                              </div>
                              {detailMode === 'detailed' && kp.detail && (
                                <p className="text-[11px] text-[#9A9E9C] leading-relaxed pl-1">
                                  {kp.detail}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}

                  {structured.key_info && structured.key_info.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[10px] tracking-[0.14em] text-[#9A9E9C] uppercase">
                        關鍵資訊與數據
                      </div>
                      <div className="grid grid-cols-1 gap-1.5">
                        {structured.key_info.map((ki, idx) => (
                          <div
                            key={idx}
                            className="flex items-baseline justify-between gap-2 p-2 bg-[#0B0D0F] border border-[#1E2224] text-xs"
                          >
                            <span className="text-[#6FA88B] shrink-0">{ki.label}</span>
                            <span className="text-[#D4D6D4] text-right">{ki.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* 舊版筆記相容渲染 */}
                  {parsedSections.summaryBullets.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] tracking-[0.14em] text-[#9A9E9C] uppercase">
                        AI 結構化重點
                      </div>
                      <ul className="space-y-1.5 text-xs text-[#E2E4E2] leading-relaxed">
                        {parsedSections.summaryBullets.map((b, idx) => (
                          <li key={idx} className="flex gap-2">
                            <span className="text-[#6FA88B]">—</span>
                            <span>{b}</span>
                          </li>
                        ))}
                      </ul>
                      {parsedSections.summaryParagraph && (
                        <p className="text-xs text-[#B8BCB9] leading-relaxed pt-1">
                          {parsedSections.summaryParagraph}
                        </p>
                      )}
                    </div>
                  )}

                  {parsedSections.timelinePoints.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[10px] tracking-[0.14em] text-[#9A9E9C] uppercase">
                        時間點／段落詳細重點
                      </div>
                      <div className="space-y-2">
                        {parsedSections.timelinePoints.map((tp, idx) => {
                          const jumpUrl = buildYouTubeTimestampUrl(
                            activeNote.source_url,
                            tp.location
                          );
                          return (
                            <div
                              key={idx}
                              className="p-2.5 bg-[#0B0D0F] border border-[#1E2224] space-y-1"
                            >
                              <div className="flex items-center gap-2">
                                {jumpUrl ? (
                                  <a
                                    href={jumpUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="px-1.5 py-0.5 text-[10px] bg-[#16261E] border border-[#253B30] text-[#6FA88B] hover:underline"
                                  >
                                    {tp.location} ↗
                                  </a>
                                ) : (
                                  <span className="px-1.5 py-0.5 text-[10px] bg-[#16261E] border border-[#253B30] text-[#6FA88B]">
                                    {tp.location}
                                  </span>
                                )}
                                <span className="text-xs text-[#F4F4F0]">{tp.point}</span>
                              </div>
                              {tp.quote && (
                                <p className="text-[11px] text-[#9A9E9C] italic pl-1">
                                  「{tp.quote}」
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : detailTab === 'keyframes' ? (
            <div className="space-y-3">
              {keyFrames.length > 0 ? (
                <div className="grid grid-cols-1 gap-3">
                  {keyFrames.map((kf, idx) => {
                    const repoPath = resolveAssetRepoPath(kf.image_path);
                    const blobUrl = assetUrlMap.get(repoPath);
                    return (
                      <div
                        key={idx}
                        className="border border-[#252A2C] bg-[#0B0D0F] overflow-hidden"
                      >
                        {blobUrl ? (
                          <button
                            type="button"
                            onClick={() => setLightboxUrl({ path: repoPath, url: blobUrl })}
                            className="w-full text-left"
                          >
                            <img
                              src={blobUrl}
                              alt={kf.caption || kf.timestamp}
                              className="w-full h-44 object-cover"
                            />
                          </button>
                        ) : (
                          <div className="h-24 flex items-center justify-center text-[11px] text-[#6A6E6C]">
                            圖片載入中或路徑未同步（{repoPath}）
                          </div>
                        )}
                        <div className="p-2.5 flex items-start gap-2">
                          <span className="shrink-0 px-1.5 py-0.5 text-[10px] bg-[#16261E] border border-[#253B30] text-[#6FA88B]">
                            {kf.timestamp}
                          </span>
                          <span className="text-xs text-[#E2E4E2] leading-snug">
                            {kf.caption}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : assetUrls.length > 0 ? (
                <div className="grid grid-cols-2 gap-2">
                  {assetUrls.map((a) => (
                    <button
                      key={a.path}
                      type="button"
                      onClick={() => setLightboxUrl(a)}
                      className="text-left border border-[#252A2C] bg-[#0B0D0F] overflow-hidden hover:border-[#6FA88B]"
                    >
                      <img
                        src={a.url}
                        alt={parsedSections.imageCaptions[a.path] || a.path}
                        className="w-full h-28 object-cover"
                      />
                      <div className="p-1.5 text-[10px] text-[#9A9E9C] truncate">
                        {parsedSections.imageCaptions[a.path] || a.path.split('/').pop()}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-[#9A9E9C] py-6 text-center">
                  此筆記尚無擷取重點畫面。
                </div>
              )}
            </div>
          ) : detailTab === 'transcript' ? (
            <div className="space-y-3">
              {transcriptRows.length > 0 ? (
                <>
                  <input
                    type="text"
                    value={transcriptQuery}
                    onChange={(e) => setTranscriptQuery(e.target.value)}
                    placeholder="搜尋逐字稿關鍵字..."
                    className="dj-input text-xs"
                  />
                  <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
                    {filteredTranscript.map((row, idx) => (
                      <div key={idx} className="text-xs leading-relaxed text-[#D4D6D4] flex gap-2">
                        {row.t && (
                          <span className="shrink-0 text-[10px] text-[#6FA88B] font-mono pt-0.5">
                            {row.t}
                          </span>
                        )}
                        <div>
                          {row.s && <span className="text-[#F4F4F0] font-medium">{row.s}：</span>}
                          <span>{row.x}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <pre className="text-xs text-[#D4D6D4] whitespace-pre-wrap font-sans leading-relaxed max-h-[55vh] overflow-y-auto">
                  {parsedSections.transcript ||
                    parsedSections.ocrText ||
                    '此筆記無逐字稿或 OCR 原文。'}
                </pre>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {structured?.fact_check?.summary && (
                <div className="p-2.5 bg-[#0B0D0F] border-l-2 border-l-[#6FA88B] text-xs text-[#E2E4E2]">
                  {structured.fact_check.summary}
                </div>
              )}
              {factItems.length > 0 ? (
                <div className="space-y-2.5">
                  {factItems.map((fc, idx) => {
                    const badgeCls =
                      fc.verdict === '正確'
                        ? 'border-[#6FA88B] text-[#6FA88B] bg-[#6FA88B]/10'
                        : fc.verdict === '錯誤'
                        ? 'border-[#D47A7A] text-[#D47A7A] bg-[#D47A7A]/10'
                        : fc.verdict === '有爭議'
                        ? 'border-[#D4A67A] text-[#D4A67A] bg-[#D4A67A]/10'
                        : 'border-[#555B59] text-[#9A9E9C]';
                    return (
                      <div key={idx} className="p-3 bg-[#0B0D0F] border border-[#1E2224] space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs font-medium text-[#F4F4F0] leading-snug">
                            {fc.claim}
                          </span>
                          <span className={`shrink-0 px-1.5 py-0.5 text-[10px] border ${badgeCls}`}>
                            {fc.verdict}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#9A9E9C] leading-relaxed">{fc.reason}</p>
                        {fc.sources && fc.sources.length > 0 && (
                          <div className="flex flex-wrap gap-2 pt-0.5">
                            {fc.sources.map((src, sIdx) => (
                              <a
                                key={sIdx}
                                href={src.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-[#6FA88B] underline truncate max-w-[200px]"
                              >
                                🔗 {src.title || src.url}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-[#9A9E9C] py-6 text-center">
                  此筆記尚未進行 Google Search 事實查核（需設定 Gemini API Key）。
                </div>
              )}
            </div>
          )}
        </div>

        {lightboxUrl && (
          <div
            onClick={() => setLightboxUrl(null)}
            className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4"
          >
            <img
              src={lightboxUrl.url}
              alt={lightboxUrl.path}
              className="max-w-full max-h-[82vh] object-contain border border-[#252A2C]"
            />
            <p className="mt-2 text-[11px] text-[#9A9E9C]">點擊任意處關閉預覽</p>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋標題、備忘、標籤或內文..."
          className="dj-input flex-1"
        />
        <button
          onClick={fetchIndex}
          disabled={loading}
          className="dj-btn px-3 text-xs shrink-0"
        >
          {loading ? '...' : '重整'}
        </button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TYPE_FILTERS.map((tp) => (
          <button
            key={tp}
            type="button"
            onClick={() => setTypeFilter(tp)}
            className={`px-2.5 py-1 text-[11px] border shrink-0 transition-colors ${
              typeFilter === tp
                ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
            }`}
          >
            {TYPE_LABEL_MAP[tp] || tp}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tagFilter && (
            <button
              type="button"
              onClick={() => setTagFilter('')}
              className="px-2 py-0.5 text-[10px] border border-[#D47A7A] text-[#D47A7A]"
            >
              清除 #{tagFilter} ×
            </button>
          )}
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter(tag === tagFilter ? '' : tag)}
              className={`px-2 py-0.5 text-[10px] border transition-colors ${
                tagFilter === tag
                  ? 'border-[#6FA88B] text-[#6FA88B]'
                  : 'border-[#252A2C] text-[#9A9E9C]'
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="dj-card p-3 border-l-2 border-l-[#D47A7A] text-xs text-[#D47A7A]">
          {error}
        </div>
      )}

      {!loading && filteredNotes.length === 0 ? (
        <div className="dj-card p-6 text-center text-xs text-[#9A9E9C]">
          目前沒有符合條件的知識筆記。
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredNotes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => openNote(n)}
              className="dj-card w-full text-left p-3.5 hover:border-[#6FA88B] transition-colors space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2 text-[10px] text-[#9A9E9C]">
                <span className="uppercase tracking-wider">
                  {TYPE_LABEL_MAP[n.source_type] || n.source_type} · {n.category}
                </span>
                <span>{n.created_at.slice(0, 10)}</span>
              </div>
              <div className="text-sm font-medium text-[#F4F4F0] leading-snug">
                {n.title}
              </div>
              {(n.one_line_summary || n.user_summary) && (
                <p className="text-xs text-[#6FA88B] line-clamp-2">
                  {n.one_line_summary || `「${n.user_summary}」`}
                </p>
              )}
              <p className="text-xs text-[#9A9E9C] line-clamp-2">{n.excerpt}</p>
              {(n.has_keyframes || n.has_transcript || n.has_fact_check) && (
                <div className="flex flex-wrap gap-1.5 pt-0.5 text-[10px] text-[#9A9E9C]">
                  {n.has_keyframes && <span className="px-1.5 py-0.5 border border-[#252A2C]">🖼 重點畫面</span>}
                  {n.has_transcript && <span className="px-1.5 py-0.5 border border-[#252A2C]">📝 逐字稿</span>}
                  {n.has_fact_check && <span className="px-1.5 py-0.5 border border-[#252A2C]">✅ 事實查核</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
};
