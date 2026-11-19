import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FloatingProgressPayload } from '../App';
import {
  getPendingEdgeVideos,
  getVaultFileText,
  markPendingEdgeVideoCompleted,
  triggerFollowWorkflow,
  triggerIngestWorkflow,
  putVaultFile,
  type PendingEdgeVideo,
} from '../lib/githubApi';
import { isNativeApkEnv, type NativeProgressEvent } from '../lib/nativeBridge';
import {
  isGithubConfigured,
  nowTaipeiIso,
  nowTaipeiStamp,
  type ByokSettings,
} from '../lib/storage';

type SourceKind =
  | 'smart_url'
  | 'screenshot'
  | 'youtube'
  | 'ig_video'
  | 'article'
  | 'podcast'
  | 'book'
  | 'book_recon'
  | 'document_ocr'
  | 'batch'
  | 'follow';

interface FollowedChannel {
  channel_id?: string;
  name: string;
  url: string;
  enabled: boolean;
  seen_video_ids?: string[];
}

interface QuickInboxProps {
  settings: ByokSettings;
  onGoSettings: () => void;
  onAnalysisComplete?: () => void;
  onFloatingStatus?: (payload: FloatingProgressPayload | null) => void;
}

const SOURCE_OPTIONS: { id: SourceKind; label: string }[] = [
  { id: 'smart_url', label: '智慧網址 (自動辨識)' },
  { id: 'screenshot', label: '截圖/圖片' },
  { id: 'document_ocr', label: '多頁文件OCR' },
  { id: 'book_recon', label: '搜書/ISBN' },
  { id: 'book', label: '電子書檔案' },
  { id: 'podcast', label: 'Podcast' },
  { id: 'batch', label: '批次連結' },
  { id: 'follow', label: '追蹤頻道' },
];

function detectUrlSourceType(url: string): 'youtube' | 'ig_video' | 'article' {
  const low = url.toLowerCase();
  if (low.includes('youtube.com') || low.includes('youtu.be')) return 'youtube';
  if (
    low.includes('instagram.com') ||
    low.includes('facebook.com') ||
    low.includes('fb.watch') ||
    low.includes('tiktok.com') ||
    low.includes('douyin.com') ||
    low.includes('bilibili.com')
  ) {
    return 'ig_video';
  }
  return 'article';
}

function getSmartUrlPlatformLabel(url: string): string {
  const low = url.trim().toLowerCase();
  if (!low) return '支援 YouTube / IG / FB / 抖音 / X / Threads / 網頁文章';
  if (low.includes('youtube.com') || low.includes('youtu.be')) return '已自動辨識：YouTube 影音';
  if (low.includes('instagram.com')) return '已自動辨識：Instagram Reels / 貼文';
  if (low.includes('facebook.com') || low.includes('fb.watch')) return '已自動辨識：Facebook 影片 / 貼文';
  if (low.includes('tiktok.com') || low.includes('douyin.com')) return '已自動辨識：抖音 / TikTok 短片';
  if (low.includes('bilibili.com')) return '已自動辨識：Bilibili 影音';
  if (low.includes('x.com/') || low.includes('twitter.com/')) return '已自動辨識：X (Twitter) 貼文／影片';
  if (low.includes('threads.com/') || low.includes('threads.net/')) return '已自動辨識：Threads 貼文';
  return '已自動辨識：網頁文章';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
    reader.readAsDataURL(file);
  });
}

function stringToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const QuickInbox: React.FC<QuickInboxProps> = ({
  settings,
  onGoSettings,
  onAnalysisComplete,
  onFloatingStatus,
}) => {
  const [sourceType, setSourceType] = useState<SourceKind>('smart_url');
  const [sourceUrl, setSourceUrl] = useState('');
  const [bookQuery, setBookQuery] = useState('');
  const [batchText, setBatchText] = useState('');
  const [title, setTitle] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [userSummary, setUserSummary] = useState('');
  const [detailLevel, setDetailLevel] = useState<'detailed' | 'concise'>(
    settings.defaultDetailLevel || 'detailed'
  );
  const [files, setFiles] = useState<File[]>([]);
  const [, setNativeProgress] = useState<NativeProgressEvent | null>(null);
  const [nativeFailedUrl, setNativeFailedUrl] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeNativeRef = useRef(false);
  const activeNativeUrlRef = useRef<string>('');
  const onAnalysisCompleteRef = useRef(onAnalysisComplete);
  onAnalysisCompleteRef.current = onAnalysisComplete;
  const onFloatingStatusRef = useRef(onFloatingStatus);
  onFloatingStatusRef.current = onFloatingStatus;
  const handleCancelRef = useRef<() => void>(() => {});

  // Follow channel state
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelUrl, setNewChannelUrl] = useState('');

  const configured = isGithubConfigured(settings);
  const isNative = isNativeApkEnv();

  const [pendingEdgeVideos, setPendingEdgeVideos] = useState<PendingEdgeVideo[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pendingQueueRef = useRef<PendingEdgeVideo[]>([]);
  const activeQueueItemRef = useRef<PendingEdgeVideo | null>(null);
  const queueCompletedCountRef = useRef(0);
  const edgeQueueCheckedRef = useRef(false);

  const launchEdgeQueueItem = (item: PendingEdgeVideo, remainingCount: number) => {
    const s = settingsRef.current;
    activeQueueItemRef.current = item;
    activeNativeRef.current = true;
    activeNativeUrlRef.current = item.url;
    setNativeFailedUrl(null);
    setSubmitting(true);
    const prefix = remainingCount > 0 ? `[排程補抓 · 尚餘 ${remainingCount + 1} 部] ` : '[排程補抓] ';
    setNativeProgress({ stage: 'fetching', message: `${prefix}${item.title || item.url}` });
    onFloatingStatusRef.current?.({
      kind: 'progress',
      stage: 'fetching',
      message: `${prefix}${item.title || item.url}`,
      onCancel: () => handleCancelRef.current(),
    });
    try {
      window.DaliNativeBridge?.syncSettings?.(JSON.stringify(s));
    } catch {
      // ignore
    }
    window.DaliNativeBridge?.processUrlInEdgeHarvester?.(
      JSON.stringify({
        source_type: 'youtube',
        source_url: item.url,
        title: item.title || '',
        tags: item.tags || ['頻道追蹤', item.channel_name],
        user_summary: `來自追蹤頻道「${item.channel_name}」手機端補抓。`,
        detail_level: item.detail_level || s.defaultDetailLevel || 'detailed',
        ai_provider: s.aiProvider || 'gemini',
        gemini_model: s.geminiModel || 'gemini-2.5-flash',
      })
    );
  };

  const startPendingEdgeQueue = (items: PendingEdgeVideo[]) => {
    if (!isNativeApkEnv() || items.length === 0 || submitting || activeNativeRef.current) return;
    const [first, ...rest] = items;
    pendingQueueRef.current = rest;
    queueCompletedCountRef.current = 0;
    launchEdgeQueueItem(first, rest.length);
  };

  // Keep local detailLevel default aligned with 04 設定 when not actively running a job
  useEffect(() => {
    if (submitting) return;
    setDetailLevel(settings.defaultDetailLevel || 'detailed');
  }, [settings.defaultDetailLevel, submitting]);

  // Receive Android ACTION_SEND shared URL or progress callbacks
  useEffect(() => {
    window.onDaliNativeProgress = (ev) => {
      if (ev.stage === 'done') {
        const doneQueueItem = activeQueueItemRef.current;
        if (doneQueueItem) {
          activeQueueItemRef.current = null;
          queueCompletedCountRef.current += 1;
          setPendingEdgeVideos((prev) => prev.filter((v) => v.video_id !== doneQueueItem.video_id));
          void markPendingEdgeVideoCompleted(
            settingsRef.current,
            doneQueueItem.video_id,
            doneQueueItem.channel_id
          );

          if (pendingQueueRef.current.length > 0) {
            const [nextItem, ...rest] = pendingQueueRef.current;
            pendingQueueRef.current = rest;
            launchEdgeQueueItem(nextItem, rest.length);
            return;
          }

          activeNativeRef.current = false;
          activeNativeUrlRef.current = '';
          setNativeFailedUrl(null);
          setNativeProgress(null);
          setSubmitting(false);
          const msg = `已完成追蹤頻道手機端補抓（共 ${queueCompletedCountRef.current} 部）！`;
          setResult({ ok: true, text: msg });
          onFloatingStatusRef.current?.({ kind: 'success', message: msg });
          onAnalysisCompleteRef.current?.();
          return;
        }

        activeNativeRef.current = false;
        activeNativeUrlRef.current = '';
        setNativeFailedUrl(null);
        setNativeProgress(null);
        setSubmitting(false);
        const msg = ev.message || '手機端解析與知識庫同步完成！';
        setResult({ ok: true, text: msg });
        onFloatingStatusRef.current?.({ kind: 'success', message: msg });
        onAnalysisCompleteRef.current?.();
      } else if (ev.stage === 'cancelled') {
        pendingQueueRef.current = [];
        activeQueueItemRef.current = null;
        activeNativeRef.current = false;
        activeNativeUrlRef.current = '';
        setNativeFailedUrl(null);
        setNativeProgress(null);
        setSubmitting(false);
        const msg = ev.message || '已手動停止分析。';
        setResult({ ok: false, text: msg });
        onFloatingStatusRef.current?.({ kind: 'error', message: msg });
      } else if (ev.stage === 'error') {
        pendingQueueRef.current = [];
        activeQueueItemRef.current = null;
        activeNativeRef.current = false;
        setNativeFailedUrl(activeNativeUrlRef.current || null);
        setNativeProgress(null);
        setSubmitting(false);
        const msg = ev.message || '手機端解析失敗';
        setResult({ ok: false, text: msg });
        onFloatingStatusRef.current?.({ kind: 'error', message: msg });
      } else {
        setNativeProgress(ev);
        onFloatingStatusRef.current?.({
          kind: 'progress',
          stage: ev.stage,
          message: ev.message,
          onCancel: () => handleCancelRef.current(),
        });
      }
    };
    window.onDaliNativeShared = (payload) => {
      const url = String(payload?.url || payload?.text || '').trim();
      if (url) {
        setSourceType('smart_url');
        setSourceUrl(url);
      }
    };
    try {
      const shared = window.DaliNativeBridge?.consumeSharedPayload?.();
      if (shared) {
        const parsed = JSON.parse(shared) as { url?: string };
        if (parsed.url) {
          setSourceType('smart_url');
          setSourceUrl(parsed.url);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Auto-check state/pending_edge_videos.json once on APK launch and harvest via phone IP
  useEffect(() => {
    if (!configured || !isNativeApkEnv() || edgeQueueCheckedRef.current) return;
    edgeQueueCheckedRef.current = true;
    getPendingEdgeVideos(settings)
      .then((videos) => {
        setPendingEdgeVideos(videos);
        if (videos.length > 0 && !activeNativeRef.current) {
          startPendingEdgeQueue(videos);
        }
      })
      .catch(() => {
        // ignore
      });
  }, [configured, settings]);

  useEffect(() => {
    if (sourceType !== 'follow' || !configured) return;
    setChannelsLoading(true);
    Promise.all([
      getVaultFileText(settings, 'state/followed_channels.json')
        .then((raw) => {
          const parsed = JSON.parse(raw) as { channels?: FollowedChannel[] };
          setChannels(parsed.channels || []);
        })
        .catch(() => setChannels([])),
      getPendingEdgeVideos(settings)
        .then((videos) => setPendingEdgeVideos(videos))
        .catch(() => setPendingEdgeVideos([])),
    ]).finally(() => setChannelsLoading(false));
  }, [sourceType, configured, settings]);

  const parsedUrlsFromBatch = useMemo(() => {
    const matches = batchText.match(/https?:\/\/[^\s"'<>]+/g) || [];
    return Array.from(new Set(matches.map((u) => u.trim())));
  }, [batchText]);

  const needsSingleFile = sourceType === 'screenshot' || sourceType === 'book';
  const needsMultiFiles = sourceType === 'document_ocr';
  const optionalCoverFile = sourceType === 'ig_video' || sourceType === 'book_recon';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setFiles(needsMultiFiles ? selected.slice(0, 8) : selected.slice(0, 1));
  };

  const handleSaveChannels = async (nextList: FollowedChannel[], triggerNow = false) => {
    setSubmitting(true);
    setResult(null);
    try {
      const contentB64 = stringToBase64(JSON.stringify({ channels: nextList }, null, 2) + '\n');
      await putVaultFile(
        settings,
        'state/followed_channels.json',
        contentB64,
        'chore(follow): update followed YouTube channels from kb-pwa'
      );
      setChannels(nextList);
      if (triggerNow) {
        await triggerFollowWorkflow(settings);
        setResult({ ok: true, text: '已儲存頻道清單並觸發雲端追蹤同步！' });
      } else {
        setResult({ ok: true, text: '已更新追蹤頻道清單（每日定時自動檢查新片）。' });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : '儲存頻道失敗' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelUrl.trim()) return;
    const next: FollowedChannel[] = [
      ...channels,
      {
        name: newChannelName.trim() || newChannelUrl.trim(),
        url: newChannelUrl.trim(),
        enabled: true,
        seen_video_ids: [],
      },
    ];
    setNewChannelName('');
    setNewChannelUrl('');
    await handleSaveChannels(next, false);
  };

  const handleCancelAnalysis = () => {
    if (!submitting) return;
    if (activeNativeRef.current) {
      setNativeProgress({ stage: 'fetching', message: '正在停止手機端分析...' });
      try {
        window.DaliNativeBridge?.cancelEdgeHarvester?.();
      } catch {
        activeNativeRef.current = false;
        setNativeProgress(null);
        setSubmitting(false);
        setResult({ ok: false, text: '已手動停止分析。' });
      }
      return;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setSubmitting(false);
    setResult({ ok: false, text: '已手動停止分析。' });
  };
  handleCancelRef.current = handleCancelAnalysis;

  const handlePasteUrl = async () => {
    try {
      const nativeClip = window.DaliNativeBridge?.readClipboardText?.();
      if (nativeClip && nativeClip.trim()) {
        const trimmed = nativeClip.trim();
        setSourceUrl(trimmed);
        setNativeFailedUrl(null);
        return;
      }
      const clip = await navigator.clipboard.readText();
      const trimmed = clip.trim();
      if (trimmed) {
        setSourceUrl(trimmed);
        setNativeFailedUrl(null);
      } else {
        setResult({ ok: false, text: '剪貼簿目前沒有文字內容。' });
      }
    } catch {
      setResult({ ok: false, text: '無法自動讀取剪貼簿，請長按輸入框手動貼上。' });
    }
  };

  const handleFallbackToCloud = async () => {
    const urlToQueue = (nativeFailedUrl || sourceUrl).trim();
    if (!urlToQueue || submitting) return;
    const resolvedType = sourceType === 'smart_url' ? detectUrlSourceType(urlToQueue) : sourceType;
    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSubmitting(true);
    setResult(null);
    setNativeFailedUrl(null);
    try {
      const stamp = nowTaipeiStamp();
      const taskJson: Record<string, unknown> = {
        source_type: resolvedType,
        source_url: urlToQueue,
        title: title.trim() || undefined,
        tags,
        user_summary: userSummary.trim(),
        detail_level: detailLevel,
        ai_provider: settings.aiProvider || 'gemini',
        gemini_model: settings.geminiModel || 'gemini-3.8-flash',
        created_at: nowTaipeiIso(),
      };
      const taskPath = `inbox/pending/${stamp}_${resolvedType}.json`;
      await putVaultFile(
        settings,
        taskPath,
        stringToBase64(JSON.stringify(taskJson, null, 2)),
        `inbox(${resolvedType}): cloud fallback ${stamp}`,
        controller.signal
      );
      await triggerIngestWorkflow(settings, `${resolvedType}:${urlToQueue}`, controller.signal);
      setSourceUrl('');
      setTitle('');
      setTagsText('');
      setUserSummary('');
      setResult({
        ok: true,
        text: `已改由雲端寫入 ${taskPath} 並觸發 GitHub Actions 解析管線（約 1~2 分鐘後至「02 檢索」查看）。`,
      });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : '雲端改派失敗' });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured) {
      onGoSettings();
      return;
    }
    if (submitting) return;

    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const activeProvider = settings.aiProvider || 'gemini';
    const activeGeminiModel = settings.geminiModel || 'gemini-3.8-flash';
    const effectiveType =
      sourceType === 'smart_url' ? detectUrlSourceType(sourceUrl.trim()) : sourceType;

    // 1. Native Android Edge Harvester path for video & X/Threads links (always on in APK)
    const lowUrl = sourceUrl.trim().toLowerCase();
    const isNativeSocialUrl =
      lowUrl.includes('x.com/') ||
      lowUrl.includes('twitter.com/') ||
      lowUrl.includes('threads.com/') ||
      lowUrl.includes('threads.net/');
    if (
      isNative &&
      (effectiveType === 'youtube' ||
        effectiveType === 'ig_video' ||
        (effectiveType === 'article' && isNativeSocialUrl)) &&
      sourceUrl.trim()
    ) {
      const targetUrl = sourceUrl.trim();
      activeNativeRef.current = true;
      activeNativeUrlRef.current = targetUrl;
      setNativeFailedUrl(null);
      setSubmitting(true);
      setResult(null);
      setNativeProgress({ stage: 'fetching', message: '正在喚起手機端原生擷取引擎...' });
      onFloatingStatusRef.current?.({
        kind: 'progress',
        stage: 'fetching',
        message: '正在喚起手機端原生擷取引擎...',
        onCancel: () => handleCancelRef.current(),
      });
      try {
        window.DaliNativeBridge?.syncSettings?.(JSON.stringify(settings));
      } catch {
        // ignore
      }
      window.DaliNativeBridge?.processUrlInEdgeHarvester?.(
        JSON.stringify({
          source_type: effectiveType,
          source_url: targetUrl,
          title: title.trim(),
          tags,
          user_summary: userSummary.trim(),
          detail_level: detailLevel,
          ai_provider: activeProvider,
          gemini_model: activeGeminiModel,
        })
      );
      return;
    }

    // 2. Batch links queue
    if (sourceType === 'batch') {
      if (parsedUrlsFromBatch.length === 0) {
        setResult({ ok: false, text: '請在下方貼上至少一個有效的 http(s):// 連結。' });
        return;
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setSubmitting(true);
      setResult(null);
      setBatchLogs([]);
      try {
        const stamp = nowTaipeiStamp();
        for (let i = 0; i < parsedUrlsFromBatch.length; i++) {
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const u = parsedUrlsFromBatch[i];
          const detected = detectUrlSourceType(u);
          setBatchLogs((prev) => [...prev, `[${i + 1}/${parsedUrlsFromBatch.length}] 排入 ${detected}: ${u}`]);
          const taskJson = {
            source_type: detected,
            source_url: u,
            tags,
            user_summary: userSummary.trim(),
            detail_level: detailLevel,
            ai_provider: activeProvider,
            gemini_model: activeGeminiModel,
            created_at: nowTaipeiIso(),
          };
          await putVaultFile(
            settings,
            `inbox/pending/${stamp}_batch_${i + 1}.json`,
            stringToBase64(JSON.stringify(taskJson, null, 2)),
            `inbox(batch): queue ${detected} #${i + 1}`,
            controller.signal
          );
        }
        await triggerIngestWorkflow(settings, `batch:${parsedUrlsFromBatch.length}`, controller.signal);
        setBatchText('');
        setResult({
          ok: true,
          text: `已將 ${parsedUrlsFromBatch.length} 筆連結寫入佇列並觸發雲端管線！`,
        });
      } catch (err) {
        if ((err instanceof DOMException && err.name === 'AbortError') || controller.signal.aborted) {
          setResult({ ok: false, text: '已手動停止分析。' });
        } else {
          setResult({ ok: false, text: err instanceof Error ? err.message : '批次投遞失敗' });
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setSubmitting(false);
      }
      return;
    }

    if ((needsSingleFile || needsMultiFiles) && files.length === 0) {
      setResult({ ok: false, text: '請先選擇要上傳的檔案或照片。' });
      return;
    }
    if (sourceType === 'book_recon' && !bookQuery.trim()) {
      setResult({ ok: false, text: '請輸入書名或 ISBN。' });
      return;
    }
    if (
      !needsSingleFile &&
      !needsMultiFiles &&
      sourceType !== 'book_recon' &&
      !sourceUrl.trim()
    ) {
      setResult({ ok: false, text: '請填入來源網址。' });
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSubmitting(true);
    setResult(null);

    try {
      const stamp = nowTaipeiStamp();

      if (sourceType === 'book' && files[0]) {
        const file = files[0];
        const safeName = `${stamp}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const assetPath = `inbox/pending/${safeName}`;
        const b64 = await fileToBase64(file);
        await putVaultFile(settings, assetPath, b64, `inbox(book): upload ${safeName}`, controller.signal);
        if (userSummary.trim() || title.trim() || tags.length > 0) {
          const meta = {
            title: title.trim() || undefined,
            tags,
            user_summary: userSummary.trim(),
            created_at: nowTaipeiIso(),
          };
          await putVaultFile(
            settings,
            `${assetPath}.meta.json`,
            stringToBase64(JSON.stringify(meta, null, 2)),
            `inbox(book): sidecar meta for ${safeName}`,
            controller.signal
          );
        }
        await triggerIngestWorkflow(settings, `book:${safeName}`, controller.signal);
        setResult({ ok: true, text: `已上傳電子書 ${safeName} 並觸發雲端解析管線。` });
      } else if (sourceType === 'document_ocr') {
        const uploadedNames: string[] = [];
        for (let i = 0; i < files.length; i++) {
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const f = files[i];
          const ext = f.name.split('.').pop()?.toLowerCase() || 'jpg';
          const fname = `${stamp}_p${i + 1}.${ext}`;
          const b64 = await fileToBase64(f);
          await putVaultFile(settings, `inbox/pending/${fname}`, b64, `inbox(ocr): page ${i + 1}`, controller.signal);
          uploadedNames.push(fname);
        }
        const taskJson = {
          source_type: 'document_ocr',
          title: title.trim() || undefined,
          tags,
          user_summary: userSummary.trim(),
          asset_filenames: uploadedNames,
          created_at: nowTaipeiIso(),
        };
        await putVaultFile(
          settings,
          `inbox/pending/${stamp}_doc_ocr.json`,
          stringToBase64(JSON.stringify(taskJson, null, 2)),
          `inbox(document_ocr): ${uploadedNames.length} pages`,
          controller.signal
        );
        await triggerIngestWorkflow(settings, `document_ocr:${uploadedNames.length}p`, controller.signal);
        setResult({
          ok: true,
          text: `已上傳 ${uploadedNames.length} 頁文件並觸發多頁 OCR 合併整理！`,
        });
      } else {
        let assetFilename = '';
        if (files[0]) {
          const file = files[0];
          const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
          assetFilename = `${stamp}_${effectiveType}.${ext}`;
          const b64 = await fileToBase64(file);
          await putVaultFile(
            settings,
            `inbox/pending/${assetFilename}`,
            b64,
            `inbox(${effectiveType}): upload ${assetFilename}`,
            controller.signal
          );
        }

        const taskJson: Record<string, unknown> = {
          source_type: effectiveType,
          source_url: sourceUrl.trim(),
          query: bookQuery.trim() || undefined,
          title: title.trim() || undefined,
          tags,
          user_summary: userSummary.trim(),
          detail_level: detailLevel,
          ai_provider: activeProvider,
          gemini_model: activeGeminiModel,
          asset_filename: assetFilename || undefined,
          created_at: nowTaipeiIso(),
        };
        const taskPath = `inbox/pending/${stamp}_${effectiveType}.json`;
        await putVaultFile(
          settings,
          taskPath,
          stringToBase64(JSON.stringify(taskJson, null, 2)),
          `inbox(${effectiveType}): queue task ${stamp}`,
          controller.signal
        );
        await triggerIngestWorkflow(
          settings,
          `${effectiveType}:${bookQuery.trim() || sourceUrl.trim()}`,
          controller.signal
        );
        setResult({
          ok: true,
          text: `已寫入 ${taskPath} 並觸發雲端解析管線（約 1~2 分鐘後至「02 檢索」查看）。`,
        });
      }

      setSourceUrl('');
      setBookQuery('');
      setTitle('');
      setTagsText('');
      setUserSummary('');
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      if ((err instanceof DOMException && err.name === 'AbortError') || controller.signal.aborted) {
        setResult({ ok: false, text: '已手動停止分析。' });
      } else {
        setResult({
          ok: false,
          text: err instanceof Error ? err.message : '投遞失敗',
        });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setSubmitting(false);
    }
  };

  if (!configured) {
    return (
      <div className="dj-card p-5 space-y-3 text-center">
        <p className="text-sm text-[#9A9E9C]">
          請先設定 GitHub PAT 與倉庫名稱（dali-km-vault）才能投遞素材。
        </p>
        <button onClick={onGoSettings} className="dj-btn dj-btn-primary text-xs">
          前往 04 設定
        </button>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-2">
          素材類型
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setSourceType(opt.id);
                setFiles([]);
                setResult(null);
              }}
              className={`py-2 px-2 text-xs border transition-colors ${
                sourceType === opt.id
                  ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                  : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {sourceType === 'follow' ? (
        <div className="space-y-3">
          <form onSubmit={handleAddChannel} className="dj-card p-3.5 space-y-2.5">
            <div className="text-xs font-medium text-[#F4F4F0]">新增追蹤 YouTube 頻道</div>
            <input
              type="text"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="頻道名稱（例如：股癌 Gooaye）"
              className="dj-input text-xs"
            />
            <input
              type="url"
              value={newChannelUrl}
              onChange={(e) => setNewChannelUrl(e.target.value)}
              placeholder="https://www.youtube.com/@Gooaye"
              className="dj-input text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <button type="submit" disabled={submitting} className="dj-btn dj-btn-primary text-xs">
                加入訂閱清單
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleSaveChannels(channels, true)}
                className="dj-btn text-xs"
              >
                立即檢查新片
              </button>
            </div>
          </form>

          {result && (
            <div
              className={`dj-card p-3 text-xs ${
                result.ok ? 'border-l-2 border-l-[#6FA88B]' : 'border-l-2 border-l-[#D47A7A]'
              }`}
            >
              {result.text}
            </div>
          )}

          {pendingEdgeVideos.length > 0 && (
            <div className="dj-card p-3 border-l-2 border-l-[#6FA88B] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-[#F4F4F0]">
                  待手機端補抓（{pendingEdgeVideos.length} 部，雲端被 YouTube 擋 IP）
                </div>
                {isNativeApkEnv() && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => startPendingEdgeQueue(pendingEdgeVideos)}
                    className="dj-btn dj-btn-primary text-[11px] px-2.5 py-1 shrink-0"
                  >
                    立即補抓
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {pendingEdgeVideos.slice(0, 5).map((v) => (
                  <div key={v.video_id} className="text-[11px] text-[#9A9E9C] truncate">
                    · [{v.channel_name}] {v.title || v.url}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase">
              已追蹤頻道（{channels.length}）
            </div>
            {channelsLoading ? (
              <div className="text-xs text-[#9A9E9C]">讀取中...</div>
            ) : channels.length === 0 ? (
              <div className="dj-card p-4 text-xs text-[#9A9E9C] text-center">
                尚未追蹤任何頻道，新增後每日將自動巡檢 RSS 並整理新片！
              </div>
            ) : (
              channels.map((ch, idx) => (
                <div
                  key={idx}
                  className="dj-card p-3 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="text-[#F4F4F0] font-medium truncate">{ch.name}</div>
                    <div className="text-[10px] text-[#9A9E9C] truncate">{ch.url}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSaveChannels(channels.filter((_, i) => i !== idx))}
                    className="shrink-0 px-2 py-1 border border-[#252A2C] text-[10px] text-[#D47A7A]"
                  >
                    移除
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {sourceType === 'batch' ? (
            <div>
              <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
                貼上多個網址（每行一個或混雜文字，自動辨識 YT/IG/抖音/文章）
              </label>
              <textarea
                rows={5}
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder={'https://www.youtube.com/watch?v=...\nhttps://www.instagram.com/reel/...'}
                className="dj-input resize-y text-xs"
              />
              <div className="text-[11px] text-[#6FA88B] mt-1">
                已偵測到 {parsedUrlsFromBatch.length} 個有效連結
              </div>
            </div>
          ) : sourceType === 'book_recon' ? (
            <div>
              <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
                書名或 ISBN（10/13 碼）
              </label>
              <input
                type="text"
                value={bookQuery}
                onChange={(e) => setBookQuery(e.target.value)}
                placeholder="例如：原子習慣 或 9789861755267"
                className="dj-input"
              />
            </div>
          ) : !needsSingleFile && !needsMultiFiles ? (
            <div>
              <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
                來源網址
              </label>
              <div className="flex gap-2">
                <input
                  type="url"
                  value={sourceUrl}
                  onChange={(e) => {
                    setSourceUrl(e.target.value);
                    if (nativeFailedUrl) setNativeFailedUrl(null);
                  }}
                  placeholder="https://..."
                  className="dj-input flex-1"
                />
                <button
                  type="button"
                  onClick={handlePasteUrl}
                  className="dj-btn px-3 text-xs shrink-0"
                >
                  貼上
                </button>
              </div>
              {sourceType === 'smart_url' && (
                <div className="text-[11px] text-[#6FA88B] mt-1.5">
                  {getSmartUrlPlatformLabel(sourceUrl)}
                </div>
              )}
            </div>
          ) : null}

          {(needsSingleFile || needsMultiFiles || optionalCoverFile) && (
            <div>
              <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
                {sourceType === 'book'
                  ? '選擇電子書（EPUB / PDF / TXT）'
                  : sourceType === 'document_ocr'
                  ? '選取多張文件 / 講義照片（最多 8 張）'
                  : optionalCoverFile
                  ? '隨附圖片／書封（選填）'
                  : '選擇圖片／截圖'}
              </label>
              <input
                ref={fileInputRef}
                type="file"
                multiple={needsMultiFiles}
                accept={sourceType === 'book' ? '.epub,.pdf,.txt,.md' : 'image/*'}
                onChange={handleFileChange}
                className="block w-full text-xs text-[#9A9E9C] file:mr-3 file:py-2 file:px-3 file:border file:border-[#252A2C] file:bg-[#111417] file:text-[#F4F4F0] file:text-xs"
              />
              {files.length > 0 && (
                <div className="text-[11px] text-[#6FA88B] mt-1">
                  已選取 {files.length} 個檔案：{files.map((f) => f.name).join(', ')}
                </div>
              )}
            </div>
          )}

          {(sourceType === 'smart_url' ||
            sourceType === 'youtube' ||
            sourceType === 'ig_video' ||
            sourceType === 'article') && (
            <div className="grid grid-cols-2 gap-2">
              {(['detailed', 'concise'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setDetailLevel(lvl)}
                  className={`py-1.5 px-2 border text-[11px] ${
                    detailLevel === lvl
                      ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                      : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
                  }`}
                >
                  {lvl === 'detailed' ? '詳細整理 (10~20條)' : '精簡整理 (5~8條)'}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
              使用者初步重點 / 備忘（選填，留空則由 AI 全權摘要）
            </label>
            <textarea
              rows={2}
              value={userSummary}
              onChange={(e) => setUserSummary(e.target.value)}
              placeholder="例如：這段講的是 AI Agent 記憶架構..."
              className="dj-input resize-y"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="自訂標題（選填）"
              className="dj-input text-xs"
            />
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="標籤逗號分隔（選填）"
              className="dj-input text-xs"
            />
          </div>

          {batchLogs.length > 0 && (
            <div className="dj-card p-3 text-[11px] text-[#9A9E9C] space-y-1 max-h-28 overflow-y-auto">
              {batchLogs.map((lg, i) => (
                <div key={i} className="truncate">{lg}</div>
              ))}
            </div>
          )}

          {result && (
            <div
              className={`dj-card p-3 text-xs leading-relaxed space-y-2 ${
                result.ok ? 'border-l-2 border-l-[#6FA88B]' : 'border-l-2 border-l-[#D47A7A]'
              }`}
            >
              <div>{result.text}</div>
              {!result.ok && nativeFailedUrl && (
                <button
                  type="button"
                  onClick={handleFallbackToCloud}
                  className="dj-btn text-[11px] px-3 py-1.5 min-h-[36px] border-[#6FA88B]/60 text-[#6FA88B]"
                >
                  改由雲端嘗試
                </button>
              )}
            </div>
          )}

          {submitting ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled
                className="dj-btn dj-btn-primary w-full opacity-70"
              >
                處理中...
              </button>
              <button
                type="button"
                onClick={handleCancelAnalysis}
                className="dj-btn w-full border border-[#D47A7A]/70 text-[#D47A7A] hover:bg-[#D47A7A]/10"
              >
                停止分析
              </button>
            </div>
          ) : (
            <button
              type="submit"
              className="dj-btn dj-btn-primary w-full"
            >
              {sourceType === 'batch'
                ? `批次投遞 ${parsedUrlsFromBatch.length} 筆連結`
                : '送出並開始分析'}
            </button>
          )}
        </form>
      )}
    </section>
  );
};
