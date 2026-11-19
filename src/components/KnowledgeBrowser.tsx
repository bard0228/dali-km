import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { factCheckNoteWithGemini, injectFactCheckIntoNoteMarkdown } from '../lib/geminiWebApi';
import {
  deleteVaultNoteAndAssets,
  getVaultAssetBlobUrl,
  getVaultFileText,
  putVaultFile,
} from '../lib/githubApi';
import {
  buildYouTubeTimestampUrl,
  extractStructuredJson,
  formatDurationMs,
  formatNoteForLineShare,
  isImageAsset,
  parseNoteSections,
  resolveAssetRepoPath,
  stripFrontmatter,
  type SearchIndexEntry,
  type SearchIndexPayload,
} from '../lib/kbTypes';
import { isGithubConfigured, type ByokSettings } from '../lib/storage';
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconFrame,
  IconLink,
  IconNote,
  IconSearch,
  IconText,
  IconTrash,
  IconWarn,
} from './LineIcons';

interface KnowledgeBrowserProps {
  settings: ByokSettings;
  selectedNoteId?: string | null;
  onClearSelectedNote?: () => void;
  onGoSettings: () => void;
  onRegisterBackHandler?: (handler: () => boolean) => void;
  isActive?: boolean;
  refreshSignal?: number;
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

const DETAIL_TAB_ORDER = ['summary', 'keyframes', 'transcript', 'factcheck'] as const;
type DetailTabId = (typeof DETAIL_TAB_ORDER)[number];

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

interface ZoomableLightboxProps {
  url: string;
  caption: string;
  onClose: () => void;
}

const ZoomableLightbox: React.FC<ZoomableLightboxProps> = ({ url, caption, onClose }) => {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartScaleRef = useRef(1);
  const panStartRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTapRef = useRef<number>(0);

  const clampScale = (s: number) => Math.min(4, Math.max(1, s));

  const getTouchDistance = (t1: React.Touch, t2: React.Touch) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchStartDistRef.current = getTouchDistance(e.touches[0], e.touches[1]);
      pinchStartScaleRef.current = scale;
      panStartRef.current = null;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 280) {
        if (scale > 1.05) {
          setScale(1);
          setTranslate({ x: 0, y: 0 });
        } else {
          setScale(2.2);
        }
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;
      if (scale > 1) {
        panStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          tx: translate.x,
          ty: translate.y,
        };
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchStartDistRef.current) {
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      const next = clampScale(pinchStartScaleRef.current * (dist / pinchStartDistRef.current));
      setScale(next);
      if (next <= 1.02) {
        setTranslate({ x: 0, y: 0 });
      }
    } else if (e.touches.length === 1 && panStartRef.current && scale > 1) {
      const dx = e.touches[0].clientX - panStartRef.current.x;
      const dy = e.touches[0].clientY - panStartRef.current.y;
      setTranslate({
        x: panStartRef.current.tx + dx,
        y: panStartRef.current.ty + dy,
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      pinchStartDistRef.current = null;
    }
    if (e.touches.length === 0) {
      panStartRef.current = null;
      if (scale <= 1.02) {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.22 : -0.22;
    const next = clampScale(scale + delta);
    setScale(next);
    if (next <= 1.02) setTranslate({ x: 0, y: 0 });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/95 flex flex-col select-none touch-none"
      onClick={(e) => {
        if (e.target === e.currentTarget && scale <= 1.02) onClose();
      }}
      onWheel={handleWheel}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#252A2C] bg-[#0B0D0F]/90">
        <div className="text-xs text-[#E2E4E2] truncate flex-1">{caption}</div>
        <div className="flex items-center gap-2 shrink-0">
          {scale > 1.02 && (
            <button
              type="button"
              onClick={() => {
                setScale(1);
                setTranslate({ x: 0, y: 0 });
              }}
              className="px-2 py-1 text-[10px] border border-[#252A2C] text-[#6FA88B]"
            >
              {Math.round(scale * 100)}% 重置
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 border border-[#252A2C] text-[#F4F4F0] hover:border-[#6FA88B]"
            aria-label="關閉圖片預覽"
          >
            <IconClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 flex items-center justify-center overflow-hidden p-3"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={(e) => {
          if (e.target === e.currentTarget && scale <= 1.02) onClose();
        }}
      >
        <img
          src={url}
          alt={caption}
          draggable={false}
          style={{
            transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${scale})`,
            transition: pinchStartDistRef.current || panStartRef.current ? 'none' : 'transform 140ms ease-out',
          }}
          className="max-w-full max-h-[82vh] object-contain border border-[#252A2C]"
        />
      </div>

      <div className="px-4 py-2 text-center text-[10px] text-[#9A9E9C] bg-[#0B0D0F]/90 border-t border-[#252A2C]">
        雙指縮放或雙擊放大 · 單指拖曳平移 · 點擊空白處或右上角關閉
      </div>
    </div>,
    document.body
  );
};

export const KnowledgeBrowser: React.FC<KnowledgeBrowserProps> = ({
  settings,
  selectedNoteId,
  onClearSelectedNote,
  onGoSettings,
  onRegisterBackHandler,
  isActive = true,
  refreshSignal = 0,
}) => {
  const [indexData, setIndexData] = useState<SearchIndexPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [typeFilterDir, setTypeFilterDir] = useState<'right' | 'left'>('right');
  const [tagFilter, setTagFilter] = useState('');

  const [activeNote, setActiveNote] = useState<SearchIndexEntry | null>(null);
  const [viewAnimDir, setViewAnimDir] = useState<'right' | 'left'>('right');
  const [detailTab, setDetailTab] = useState<DetailTabId>('summary');
  const [detailTabDir, setDetailTabDir] = useState<'right' | 'left'>('right');
  const [detailMode, setDetailMode] = useState<'detailed' | 'concise'>(
    settings.defaultDetailLevel || 'detailed'
  );
  const [detailModeDir, setDetailModeDir] = useState<'right' | 'left'>('right');
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const [copyToast, setCopyToast] = useState<string | null>(null);

  const [noteRawMd, setNoteRawMd] = useState<string>('');
  const [noteBody, setNoteBody] = useState<string>('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [assetUrls, setAssetUrls] = useState<{ path: string; url: string }[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<{ path: string; url: string } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<SearchIndexEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [factChecking, setFactChecking] = useState(false);
  const [factCheckError, setFactCheckError] = useState<string | null>(null);
  const lastFetchedAtRef = useRef<number>(0);

  const configured = isGithubConfigured(settings);

  const showToast = useCallback((msg: string) => {
    setCopyToast(msg);
    setTimeout(() => setCopyToast(null), 2400);
  }, []);

  const fetchIndex = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await getVaultFileText(settings, 'index/search-index.json');
      const parsed = JSON.parse(raw) as SearchIndexPayload;
      setIndexData(parsed);
      lastFetchedAtRef.current = Date.now();
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
    if (refreshSignal > 0 && configured) {
      fetchIndex();
    }
  }, [refreshSignal, configured, fetchIndex]);

  useEffect(() => {
    if (isActive && configured && Date.now() - lastFetchedAtRef.current > 8000) {
      fetchIndex();
    }
  }, [isActive, configured, fetchIndex]);

  useEffect(() => {
    onRegisterBackHandler?.(() => {
      if (deleteTarget && !deleting) {
        setDeleteTarget(null);
        return true;
      }
      if (lightboxUrl) {
        setLightboxUrl(null);
        return true;
      }
      if (activeNote) {
        setViewAnimDir('left');
        setActiveNote(null);
        return true;
      }
      return false;
    });
  }, [onRegisterBackHandler, lightboxUrl, activeNote, deleteTarget, deleting]);

  useEffect(() => {
    return () => {
      assetUrls.forEach((a) => URL.revokeObjectURL(a.url));
    };
  }, [assetUrls]);

  const openNote = useCallback(
    async (entry: SearchIndexEntry) => {
      setViewAnimDir('right');
      setActiveNote(entry);
      setDetailTab('summary');
      setFactCheckError(null);
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
      showToast('已複製 LINE 精華格式');
    } catch {
      showToast('複製失敗，請手動選取');
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

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await deleteVaultNoteAndAssets(
        settings,
        deleteTarget.path,
        deleteTarget.id,
        deleteTarget.raw_assets,
        indexData
      );
      setIndexData((prev) => {
        if (!prev) return prev;
        const nextNotes = prev.notes.filter((n) => n.id !== deleteTarget.id);
        return { ...prev, total: nextNotes.length, notes: nextNotes };
      });
      if (activeNote?.id === deleteTarget.id) {
        setViewAnimDir('left');
        setActiveNote(null);
      }
      setDeleteTarget(null);
      showToast('已刪除分析紀錄與關聯圖片');
    } catch (err) {
      setError(err instanceof Error ? err.message : '刪除筆記失敗');
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const handleRunFactCheck = async () => {
    if (!activeNote || factChecking) return;
    setFactChecking(true);
    setFactCheckError(null);
    try {
      const kps =
        structured?.key_points && structured.key_points.length > 0
          ? structured.key_points
          : parsedSections.summaryBullets.map((b) => ({
              section: '重點',
              point: b,
              detail: '',
              timestamp: '',
            }));
      const fcResult = await factCheckNoteWithGemini(
        settings.geminiApiKey,
        settings.geminiModel || 'gemini-3.8-flash',
        activeNote.title,
        kps
      );
      const updatedMd = injectFactCheckIntoNoteMarkdown(noteRawMd, fcResult);
      await putVaultFile(
        settings,
        activeNote.path,
        utf8ToBase64(updatedMd),
        `feat(factcheck): ${activeNote.id}`
      );
      setNoteRawMd(updatedMd);
      setNoteBody(stripFrontmatter(updatedMd));

      if (indexData) {
        const nextNotes = indexData.notes.map((n) =>
          n.id === activeNote.id
            ? { ...n, has_fact_check: fcResult.items.length > 0 }
            : n
        );
        const updatedIndex = { ...indexData, notes: nextNotes };
        await putVaultFile(
          settings,
          'index/search-index.json',
          utf8ToBase64(JSON.stringify(updatedIndex, null, 2) + '\n'),
          `chore(index): mark fact_check for ${activeNote.id}`
        );
        setIndexData(updatedIndex);
        setActiveNote((prev) =>
          prev ? { ...prev, has_fact_check: fcResult.items.length > 0 } : prev
        );
      }
      showToast('Google Search 事實查核完成並已寫入知識庫');
    } catch (err) {
      setFactCheckError(err instanceof Error ? err.message : '事實查核失敗');
    } finally {
      setFactChecking(false);
    }
  };

  const handleSwitchDetailTab = (next: DetailTabId) => {
    if (next === detailTab) return;
    const prevIdx = DETAIL_TAB_ORDER.indexOf(detailTab);
    const nextIdx = DETAIL_TAB_ORDER.indexOf(next);
    setDetailTabDir(nextIdx >= prevIdx ? 'right' : 'left');
    setDetailTab(next);
  };

  const handleSwitchDetailMode = (next: 'detailed' | 'concise') => {
    if (next === detailMode) return;
    setDetailModeDir(next === 'concise' ? 'right' : 'left');
    setDetailMode(next);
  };

  const handleSwitchTypeFilter = (next: string) => {
    if (next === typeFilter) return;
    const prevIdx = TYPE_FILTERS.indexOf(typeFilter);
    const nextIdx = TYPE_FILTERS.indexOf(next);
    setTypeFilterDir(nextIdx >= prevIdx ? 'right' : 'left');
    setTypeFilter(next);
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

    const stats = structured?.execution_stats;
    const providerLabel =
      stats?.provider === 'openrouter'
        ? 'OpenRouter'
        : stats?.provider === 'gemini'
        ? 'Gemini'
        : stats?.provider || 'AI';

    const heroImageUrl = (() => {
      if (keyFrames.length > 0) {
        const kfUrl = assetUrls.find((a) => a.path === keyFrames[0].image_path)?.url;
        if (kfUrl) return kfUrl;
      }
      if (assetUrls.length > 0 && assetUrls[0]?.url) {
        return assetUrls[0].url;
      }
      if (activeNote.source_url) {
        const ytMatch = activeNote.source_url.match(
          /(?:youtube\.com\/watch\?.*?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/live\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
        );
        if (ytMatch?.[1]) {
          return `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
        }
      }
      const coverMatch = noteRawMd.match(/^cover_image:\s*["']?(https?:\/\/[^\s"']+)["']?/m);
      if (coverMatch?.[1]) return coverMatch[1];
      return '';
    })();

    return (
      <section
        key={`detail-${activeNote.id}`}
        className={`space-y-4 ${viewAnimDir === 'right' ? 'dj-enter-right' : 'dj-enter-left'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => {
              setViewAnimDir('left');
              setActiveNote(null);
            }}
            className="text-xs tracking-[0.14em] text-[#9A9E9C] hover:text-[#F4F4F0] uppercase"
          >
            ← 返回知識列表
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopyLine}
              className="h-7 flex items-center justify-center gap-1 text-[11px] px-2 border border-[#252A2C] text-[#9A9E9C] hover:border-[#6FA88B] hover:text-[#F4F4F0]"
            >
              <IconCopy className="w-3 h-3" />
              <span>複製 LINE</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadMd}
              className="h-7 flex items-center justify-center gap-1 text-[11px] px-2 border border-[#252A2C] text-[#9A9E9C] hover:border-[#6FA88B] hover:text-[#F4F4F0]"
            >
              <IconDownload className="w-3 h-3" />
              <span>.md</span>
            </button>
            <button
              type="button"
              onClick={() => setDeleteTarget(activeNote)}
              className="h-7 flex items-center justify-center gap-1 text-[11px] px-2 border border-[#252A2C] text-[#D47A7A] hover:border-[#D47A7A]"
              aria-label="刪除此分析紀錄"
            >
              <IconTrash className="w-3 h-3" />
            </button>
          </div>
        </div>

        {copyToast && (
          <div className="dj-card p-2 text-center text-xs text-[#6FA88B] border-l-2 border-l-[#6FA88B]">
            {copyToast}
          </div>
        )}

        <div
          className="dj-card dj-deal-card p-4 space-y-3"
          style={{ '--deal-idx': 0 } as React.CSSProperties}
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#9A9E9C]">
            <span className="px-2 py-0.5 border border-[#252A2C] uppercase">
              {TYPE_LABEL_MAP[activeNote.source_type] || activeNote.source_type}
            </span>
            <span className="px-2 py-0.5 border border-[#252A2C] text-[#6FA88B]">
              {activeNote.category}
            </span>
            <span>{activeNote.created_at.slice(0, 10)}</span>
          </div>

          {heroImageUrl && (
            <button
              key={`hero-${activeNote.id}-${heroImageUrl}`}
              type="button"
              onClick={() => setLightboxUrl({ path: activeNote.title, url: heroImageUrl })}
              className="w-full text-left dj-curtain-wrap block h-48 border border-[#252A2C]"
            >
              <img
                src={heroImageUrl}
                alt={activeNote.title}
                className="dj-curtain-media is-revealed w-full h-48 object-cover"
              />
            </button>
          )}

          <h2 className="text-base font-medium text-[#F4F4F0] leading-snug">
            {activeNote.title}
          </h2>

          {structured?.one_line_summary && (
            <div className="flex items-start gap-2 p-2.5 bg-[#6FA88B]/10 border-l-2 border-l-[#6FA88B] text-xs text-[#E8ECEA] leading-relaxed">
              <IconNote className="w-3.5 h-3.5 text-[#6FA88B] shrink-0 mt-0.5" />
              <span>{structured.one_line_summary}</span>
            </div>
          )}

          {stats && (
            <div className="px-2.5 py-2 bg-[#0B0D0F] border border-[#252A2C] text-[11px] text-[#9A9E9C] dj-tnum leading-relaxed">
              本次分析由 <span className="text-[#F4F4F0]">{providerLabel}</span> API 執行，模型為{' '}
              <span className="text-[#6FA88B]">{stats.model}</span>，耗時{' '}
              <span className="text-[#F4F4F0]">{formatDurationMs(stats.duration_ms)}</span>，
              {stats.token_estimated ? '預估' : ''}消耗{' '}
              <span className="text-[#F4F4F0]">{stats.total_tokens.toLocaleString()}</span> tokens
            </div>
          )}

          {structured?.limited_note && (
            <div className="flex items-start gap-2 p-2.5 bg-[#D4A67A]/10 border-l-2 border-l-[#D4A67A] text-xs text-[#E8D5C4] leading-relaxed">
              <IconWarn className="w-3.5 h-3.5 text-[#D4A67A] shrink-0 mt-0.5" />
              <span>{structured.limited_note}</span>
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
                onClick={() => handleSwitchDetailTab(t.id)}
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
          ) : (
            <div
              key={detailTab}
              className={detailTabDir === 'right' ? 'dj-enter-right' : 'dj-enter-left'}
            >
              {detailTab === 'summary' ? (
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
                            onClick={() => handleSwitchDetailMode('detailed')}
                            className={`px-2 py-0.5 transition-colors ${
                              detailMode === 'detailed'
                                ? 'bg-[#6FA88B]/20 text-[#F4F4F0]'
                                : 'text-[#9A9E9C]'
                            }`}
                          >
                            詳細
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSwitchDetailMode('concise')}
                            className={`px-2 py-0.5 transition-colors ${
                              detailMode === 'concise'
                                ? 'bg-[#6FA88B]/20 text-[#F4F4F0]'
                                : 'text-[#9A9E9C]'
                            }`}
                          >
                            精簡
                          </button>
                        </div>
                      </div>

                      <div
                        key={detailMode}
                        className={`space-y-3 ${
                          detailModeDir === 'right' ? 'dj-enter-right' : 'dj-enter-left'
                        }`}
                      >
                        {groupedKeyPoints.map((grp, gIdx) => (
                          <div
                            key={gIdx}
                            className="space-y-1.5 dj-deal-card"
                            style={{ '--deal-idx': gIdx + 1 } as React.CSSProperties}
                          >
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
                  </div>

                  {structured.key_info && structured.key_info.length > 0 && (
                    <div
                      className="space-y-1.5 pt-1 dj-deal-card"
                      style={{ '--deal-idx': groupedKeyPoints.length + 1 } as React.CSSProperties}
                    >
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
                        className="border border-[#252A2C] bg-[#0B0D0F] overflow-hidden dj-deal-card"
                        style={{ '--deal-idx': idx } as React.CSSProperties}
                      >
                        {blobUrl ? (
                          <button
                            type="button"
                            onClick={() => setLightboxUrl({ path: repoPath, url: blobUrl })}
                            className="w-full text-left dj-curtain-wrap block h-44"
                          >
                            <img
                              src={blobUrl}
                              alt={kf.caption || kf.timestamp}
                              className="dj-curtain-media is-revealed w-full h-44 object-cover"
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
                  {assetUrls.map((a, idx) => (
                    <button
                      key={a.path}
                      type="button"
                      onClick={() => setLightboxUrl(a)}
                      className="text-left border border-[#252A2C] bg-[#0B0D0F] overflow-hidden hover:border-[#6FA88B] dj-deal-card"
                      style={{ '--deal-idx': idx } as React.CSSProperties}
                    >
                      <div className="dj-curtain-wrap h-28 w-full">
                        <img
                          src={a.url}
                          alt={parsedSections.imageCaptions[a.path] || a.path}
                          className="dj-curtain-media is-revealed w-full h-28 object-cover"
                        />
                      </div>
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
                                className="inline-flex items-center gap-1 text-[10px] text-[#6FA88B] underline truncate max-w-[200px]"
                              >
                                <IconLink className="w-2.5 h-2.5 shrink-0" />
                                <span className="truncate">{src.title || src.url}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-3 py-2">
                  <div className="text-xs text-[#9A9E9C] text-center">
                    此筆記尚未進行 Google Search 事實查核。
                  </div>
                  {factCheckError && (
                    <div className="p-2.5 bg-[#0B0D0F] border-l-2 border-l-[#D47A7A] text-xs text-[#D47A7A]">
                      {factCheckError}
                    </div>
                  )}
                  <div className="flex flex-col items-center gap-2">
                    {settings.geminiApiKey?.trim() ? (
                      <button
                        type="button"
                        onClick={handleRunFactCheck}
                        disabled={factChecking}
                        className="dj-btn dj-btn-primary text-xs px-4"
                      >
                        <IconSearch className="w-3.5 h-3.5" />
                        <span>{factChecking ? 'Google Search 查核中...' : '立即執行 Google Search 事實查核'}</span>
                      </button>
                    ) : (
                      <>
                        <div className="text-[11px] text-[#6E7371]">
                          需先於「04 設定」填入 Gemini API Key 才能啟用即時網路查核
                        </div>
                        <button
                          type="button"
                          onClick={onGoSettings}
                          className="dj-btn text-xs px-4"
                        >
                          前往 04 設定
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {factItems.length > 0 && (
                <div className="pt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleRunFactCheck}
                    disabled={factChecking || !settings.geminiApiKey?.trim()}
                    className="dj-btn text-[11px] px-3 min-h-[36px]"
                  >
                    <IconSearch className="w-3 h-3" />
                    <span>{factChecking ? '重新查核中...' : '重新執行事實查核'}</span>
                  </button>
                </div>
              )}
            </div>
          )}
            </div>
          )}
        </div>

        {lightboxUrl && (
          <ZoomableLightbox
            url={lightboxUrl.url}
            caption={lightboxUrl.path}
            onClose={() => setLightboxUrl(null)}
          />
        )}

        {deleteTarget &&
          createPortal(
            <div
              className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
              onClick={(e) => {
                if (e.target === e.currentTarget && !deleting) setDeleteTarget(null);
              }}
            >
              <div className="dj-card w-full max-w-sm p-5 space-y-4">
                <div className="text-xs tracking-[0.14em] text-[#D47A7A] uppercase">
                  確認刪除分析紀錄
                </div>
                <div className="text-xs text-[#E2E4E2] leading-relaxed">
                  確定要永久刪除「<span className="text-[#F4F4F0] font-medium">{deleteTarget.title}</span>」嗎？此操作會同步移除 Vault 筆記與關聯截圖，無法復原。
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => setDeleteTarget(null)}
                    className="dj-btn text-xs"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={handleConfirmDelete}
                    className="dj-btn text-xs border-[#D47A7A]/70 text-[#D47A7A] hover:bg-[#D47A7A]/15"
                  >
                    {deleting ? '刪除中...' : '確認刪除'}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}
      </section>
    );
  }

  return (
    <section
      key="list-view"
      className={`space-y-4 ${viewAnimDir === 'left' ? 'dj-enter-left' : 'dj-enter-right'}`}
    >
      {copyToast && (
        <div className="dj-card p-2 text-center text-xs text-[#6FA88B] border-l-2 border-l-[#6FA88B]">
          {copyToast}
        </div>
      )}

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
            onClick={() => handleSwitchTypeFilter(tp)}
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
        <div
          key={`${typeFilter}-${tagFilter}`}
          className={`space-y-2.5 ${
            typeFilterDir === 'right' ? 'dj-enter-right' : 'dj-enter-left'
          }`}
        >
          {filteredNotes.map((n, idx) => (
            <div
              key={n.id}
              onClick={() => openNote(n)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openNote(n);
                }
              }}
              className="dj-card dj-deal-card w-full text-left p-3.5 hover:border-[#6FA88B] transition-colors space-y-1.5 cursor-pointer"
              style={{ '--deal-idx': idx } as React.CSSProperties}
            >
              <div className="flex items-center justify-between gap-2 text-[10px] text-[#9A9E9C]">
                <span className="uppercase tracking-wider">
                  {TYPE_LABEL_MAP[n.source_type] || n.source_type} · {n.category}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <span>{n.created_at.slice(0, 10)}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(n);
                    }}
                    className="p-1 text-[#9A9E9C] hover:text-[#D47A7A] transition-colors"
                    aria-label={`刪除 ${n.title}`}
                  >
                    <IconTrash className="w-3.5 h-3.5" />
                  </button>
                </div>
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
                  {n.has_keyframes && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[#252A2C]">
                      <IconFrame className="w-2.5 h-2.5" />
                      <span>重點畫面</span>
                    </span>
                  )}
                  {n.has_transcript && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[#252A2C]">
                      <IconText className="w-2.5 h-2.5" />
                      <span>逐字稿</span>
                    </span>
                  )}
                  {n.has_fact_check && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[#252A2C]">
                      <IconCheck className="w-2.5 h-2.5" />
                      <span>事實查核</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {deleteTarget &&
        createPortal(
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget && !deleting) setDeleteTarget(null);
            }}
          >
            <div className="dj-card w-full max-w-sm p-5 space-y-4">
              <div className="text-xs tracking-[0.14em] text-[#D47A7A] uppercase">
                確認刪除分析紀錄
              </div>
              <div className="text-xs text-[#E2E4E2] leading-relaxed">
                確定要永久刪除「<span className="text-[#F4F4F0] font-medium">{deleteTarget.title}</span>」嗎？此操作會同步移除 Vault 筆記與關聯截圖，無法復原。
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                  className="dj-btn text-xs"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={handleConfirmDelete}
                  className="dj-btn text-xs border-[#D47A7A]/70 text-[#D47A7A] hover:bg-[#D47A7A]/15"
                >
                  {deleting ? '刪除中...' : '確認刪除'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
};
