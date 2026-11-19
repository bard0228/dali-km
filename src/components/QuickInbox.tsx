import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getVaultFileText,
  triggerFollowWorkflow,
  triggerIngestWorkflow,
  putVaultFile,
} from '../lib/githubApi';
import { isNativeApkEnv, type NativeProgressEvent } from '../lib/nativeBridge';
import {
  GEMINI_MODEL_OPTIONS,
  isGithubConfigured,
  nowTaipeiIso,
  nowTaipeiStamp,
  type AiProvider,
  type ByokSettings,
} from '../lib/storage';
import { IconPhone } from './LineIcons';

type SourceKind =
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
}

const SOURCE_OPTIONS: { id: SourceKind; label: string }[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'ig_video', label: 'IG/抖音/短片' },
  { id: 'article', label: '文章/Threads' },
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
    low.includes('tiktok.com') ||
    low.includes('douyin.com') ||
    low.includes('bilibili.com')
  ) {
    return 'ig_video';
  }
  return 'article';
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

export const QuickInbox: React.FC<QuickInboxProps> = ({ settings, onGoSettings }) => {
  const [sourceType, setSourceType] = useState<SourceKind>('youtube');
  const [sourceUrl, setSourceUrl] = useState('');
  const [bookQuery, setBookQuery] = useState('');
  const [batchText, setBatchText] = useState('');
  const [title, setTitle] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [userSummary, setUserSummary] = useState('');
  const [detailLevel, setDetailLevel] = useState<'detailed' | 'concise'>(
    settings.defaultDetailLevel || 'detailed'
  );
  const [aiProvider, setAiProvider] = useState<AiProvider>(settings.aiProvider || 'gemini');
  const [geminiModel, setGeminiModel] = useState<string>(
    settings.geminiModel || 'gemini-3.8-flash'
  );
  const [files, setFiles] = useState<File[]>([]);
  const [useNativeHarvester, setUseNativeHarvester] = useState<boolean>(isNativeApkEnv());
  const [nativeProgress, setNativeProgress] = useState<NativeProgressEvent | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Follow channel state
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelUrl, setNewChannelUrl] = useState('');

  const configured = isGithubConfigured(settings);
  const isNative = isNativeApkEnv();

  // Receive Android ACTION_SEND shared URL or progress callbacks
  useEffect(() => {
    window.onDaliNativeProgress = (ev) => {
      if (ev.stage === 'done') {
        setNativeProgress(null);
        setSubmitting(false);
        setResult({ ok: true, text: ev.message || '手機端解析與知識庫同步完成！' });
      } else if (ev.stage === 'error') {
        setNativeProgress(null);
        setSubmitting(false);
        setResult({ ok: false, text: ev.message || '手機端解析失敗' });
      } else {
        setNativeProgress(ev);
      }
    };
    window.onDaliNativeShared = (payload) => {
      const url = String(payload?.url || payload?.text || '').trim();
      if (url) {
        const detected = detectUrlSourceType(url);
        setSourceType(detected);
        setSourceUrl(url);
      }
    };
    try {
      const shared = window.DaliNativeBridge?.consumeSharedPayload?.();
      if (shared) {
        const parsed = JSON.parse(shared) as { url?: string };
        if (parsed.url) {
          setSourceType(detectUrlSourceType(parsed.url));
          setSourceUrl(parsed.url);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (sourceType !== 'follow' || !configured) return;
    setChannelsLoading(true);
    getVaultFileText(settings, 'state/followed_channels.json')
      .then((raw) => {
        const parsed = JSON.parse(raw) as { channels?: FollowedChannel[] };
        setChannels(parsed.channels || []);
      })
      .catch(() => setChannels([]))
      .finally(() => setChannelsLoading(false));
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!configured) {
      onGoSettings();
      return;
    }

    const tags = tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    // 1. Native Android Edge Harvester path for video links
    if (
      isNative &&
      useNativeHarvester &&
      (sourceType === 'youtube' || sourceType === 'ig_video') &&
      sourceUrl.trim()
    ) {
      setSubmitting(true);
      setResult(null);
      setNativeProgress({ stage: 'fetching', message: '正在喚起手機端原生擷取引擎...' });
      window.DaliNativeBridge?.processUrlInEdgeHarvester?.(
        JSON.stringify({
          source_type: sourceType,
          source_url: sourceUrl.trim(),
          title: title.trim(),
          tags,
          user_summary: userSummary.trim(),
          detail_level: detailLevel,
          ai_provider: aiProvider,
          gemini_model: geminiModel,
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
      setSubmitting(true);
      setResult(null);
      setBatchLogs([]);
      try {
        const stamp = nowTaipeiStamp();
        for (let i = 0; i < parsedUrlsFromBatch.length; i++) {
          const u = parsedUrlsFromBatch[i];
          const detected = detectUrlSourceType(u);
          setBatchLogs((prev) => [...prev, `[${i + 1}/${parsedUrlsFromBatch.length}] 排入 ${detected}: ${u}`]);
          const taskJson = {
            source_type: detected,
            source_url: u,
            tags,
            user_summary: userSummary.trim(),
            detail_level: detailLevel,
            ai_provider: aiProvider,
            gemini_model: geminiModel,
            created_at: nowTaipeiIso(),
          };
          await putVaultFile(
            settings,
            `inbox/pending/${stamp}_batch_${i + 1}.json`,
            stringToBase64(JSON.stringify(taskJson, null, 2)),
            `inbox(batch): queue ${detected} #${i + 1}`
          );
        }
        await triggerIngestWorkflow(settings, `batch:${parsedUrlsFromBatch.length}`);
        setBatchText('');
        setResult({
          ok: true,
          text: `已將 ${parsedUrlsFromBatch.length} 筆連結寫入佇列並觸發雲端管線！`,
        });
      } catch (err) {
        setResult({ ok: false, text: err instanceof Error ? err.message : '批次投遞失敗' });
      } finally {
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

    setSubmitting(true);
    setResult(null);

    try {
      const stamp = nowTaipeiStamp();

      if (sourceType === 'book' && files[0]) {
        const file = files[0];
        const safeName = `${stamp}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const assetPath = `inbox/pending/${safeName}`;
        const b64 = await fileToBase64(file);
        await putVaultFile(settings, assetPath, b64, `inbox(book): upload ${safeName}`);
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
            `inbox(book): sidecar meta for ${safeName}`
          );
        }
        await triggerIngestWorkflow(settings, `book:${safeName}`);
        setResult({ ok: true, text: `已上傳電子書 ${safeName} 並觸發雲端解析管線。` });
      } else if (sourceType === 'document_ocr') {
        const uploadedNames: string[] = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const ext = f.name.split('.').pop()?.toLowerCase() || 'jpg';
          const fname = `${stamp}_p${i + 1}.${ext}`;
          const b64 = await fileToBase64(f);
          await putVaultFile(settings, `inbox/pending/${fname}`, b64, `inbox(ocr): page ${i + 1}`);
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
          `inbox(document_ocr): ${uploadedNames.length} pages`
        );
        await triggerIngestWorkflow(settings, `document_ocr:${uploadedNames.length}p`);
        setResult({
          ok: true,
          text: `已上傳 ${uploadedNames.length} 頁文件並觸發多頁 OCR 合併整理！`,
        });
      } else {
        let assetFilename = '';
        if (files[0]) {
          const file = files[0];
          const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
          assetFilename = `${stamp}_${sourceType}.${ext}`;
          const b64 = await fileToBase64(file);
          await putVaultFile(
            settings,
            `inbox/pending/${assetFilename}`,
            b64,
            `inbox(${sourceType}): upload ${assetFilename}`
          );
        }

        const taskJson: Record<string, unknown> = {
          source_type: sourceType,
          source_url: sourceUrl.trim(),
          query: bookQuery.trim() || undefined,
          title: title.trim() || undefined,
          tags,
          user_summary: userSummary.trim(),
          detail_level: detailLevel,
          ai_provider: aiProvider,
          gemini_model: geminiModel,
          asset_filename: assetFilename || undefined,
          created_at: nowTaipeiIso(),
        };
        const taskPath = `inbox/pending/${stamp}_${sourceType}.json`;
        await putVaultFile(
          settings,
          taskPath,
          stringToBase64(JSON.stringify(taskJson, null, 2)),
          `inbox(${sourceType}): queue task ${stamp}`
        );
        await triggerIngestWorkflow(settings, `${sourceType}:${bookQuery.trim() || sourceUrl.trim()}`);
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
      setResult({
        ok: false,
        text: err instanceof Error ? err.message : '投遞失敗',
      });
    } finally {
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
          {isNative && (sourceType === 'youtube' || sourceType === 'ig_video') && (
            <label className="dj-card p-3 flex items-center justify-between gap-2 text-xs cursor-pointer">
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 text-[#F4F4F0] font-medium">
                  <IconPhone className="w-3.5 h-3.5 text-[#6FA88B] shrink-0" />
                  <span>手機端原生擷取（防封鎖＋即時截圖）</span>
                </div>
                <div className="text-[10px] text-[#9A9E9C]">
                  使用手機行動網路直接抓片與字幕，繞過雲端機房封鎖
                </div>
              </div>
              <input
                type="checkbox"
                checked={useNativeHarvester}
                onChange={(e) => setUseNativeHarvester(e.target.checked)}
                className="accent-[#6FA88B] w-4 h-4"
              />
            </label>
          )}

          {/* 分析引擎與模型選擇 */}
          <div className="dj-card p-3 space-y-2">
            <div className="text-[10px] tracking-[0.14em] text-[#9A9E9C] uppercase">
              分析引擎與模型
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAiProvider('gemini')}
                className={`py-1.5 px-2 border text-[11px] transition-colors ${
                  aiProvider === 'gemini'
                    ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                    : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
                }`}
              >
                Gemini API
              </button>
              <button
                type="button"
                onClick={() => setAiProvider('openrouter')}
                className={`py-1.5 px-2 border text-[11px] transition-colors ${
                  aiProvider === 'openrouter'
                    ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                    : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
                }`}
              >
                OpenRouter (openrouter/free)
              </button>
            </div>
            {aiProvider === 'gemini' ? (
              <select
                value={geminiModel}
                onChange={(e) => setGeminiModel(e.target.value)}
                className="dj-input text-xs"
              >
                {GEMINI_MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-[10px] text-[#9A9E9C]">
                將使用 OpenRouter 免費路由模型：<span className="text-[#6FA88B]">openrouter/free</span>
              </div>
            )}
          </div>

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
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://..."
                className="dj-input"
              />
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

          {(sourceType === 'youtube' || sourceType === 'ig_video' || sourceType === 'article') && (
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

          {nativeProgress && (
            <div className="dj-card p-3 border-l-2 border-l-[#6FA88B] text-xs space-y-1">
              <div className="text-[#6FA88B] font-medium uppercase text-[10px]">
                手機端進度 · {nativeProgress.stage}
              </div>
              <div className="text-[#F4F4F0]">{nativeProgress.message}</div>
            </div>
          )}

          {batchLogs.length > 0 && (
            <div className="dj-card p-3 text-[11px] text-[#9A9E9C] space-y-1 max-h-28 overflow-y-auto">
              {batchLogs.map((lg, i) => (
                <div key={i} className="truncate">{lg}</div>
              ))}
            </div>
          )}

          {result && (
            <div
              className={`dj-card p-3 text-xs leading-relaxed ${
                result.ok ? 'border-l-2 border-l-[#6FA88B]' : 'border-l-2 border-l-[#D47A7A]'
              }`}
            >
              {result.text}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="dj-btn dj-btn-primary w-full"
          >
            {submitting
              ? '處理中...'
              : sourceType === 'batch'
              ? `批次投遞 ${parsedUrlsFromBatch.length} 筆連結`
              : '送出並開始分析'}
          </button>
        </form>
      )}
    </section>
  );
};
