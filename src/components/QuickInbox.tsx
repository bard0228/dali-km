import React, { useEffect, useRef, useState } from 'react';
import {
  arrayBufferToBase64,
  putVaultFile,
  triggerIngestWorkflow,
  utf8ToBase64,
} from '../lib/githubApi';
import { isGithubConfigured, nowTaipeiIso, nowTaipeiStamp, type ByokSettings } from '../lib/storage';

export type SourceType =
  | 'screenshot'
  | 'article'
  | 'youtube'
  | 'ig_video'
  | 'podcast'
  | 'book';

const SOURCE_OPTIONS: { value: SourceType; label: string; code: string }[] = [
  { value: 'screenshot', label: '截圖', code: '01' },
  { value: 'article', label: '文章', code: '02' },
  { value: 'youtube', label: 'YouTube', code: '03' },
  { value: 'ig_video', label: 'IG 影片', code: '04' },
  { value: 'podcast', label: 'Podcast', code: '05' },
  { value: 'book', label: '書籍', code: '06' },
];

interface QuickInboxProps {
  settings: ByokSettings;
  onGoSettings: () => void;
}

function detectSourceTypeFromUrl(rawUrl: string): SourceType {
  const lower = rawUrl.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('instagram.com')) return 'ig_video';
  if (lower.endsWith('.xml') || lower.includes('rss') || lower.includes('podcast')) {
    return 'podcast';
  }
  return 'article';
}

export const QuickInbox: React.FC<QuickInboxProps> = ({ settings, onGoSettings }) => {
  const [sourceType, setSourceType] = useState<SourceType>('screenshot');
  const [typeSlideDir, setTypeSlideDir] = useState<'right' | 'left'>('right');
  const prevTypeIdxRef = useRef(0);
  const [sourceUrl, setSourceUrl] = useState('');
  const [title, setTitle] = useState('');
  const [userSummary, setUserSummary] = useState('');
  const [category, setCategory] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Parse Web Share Target query params (?title=...&text=...&url=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedTitle = params.get('title') || '';
    const sharedText = params.get('text') || '';
    const sharedUrl = params.get('url') || '';

    let detectedUrl = sharedUrl.trim();
    if (!detectedUrl && sharedText) {
      const urlMatch = sharedText.match(/https?:\/\/\S+/);
      if (urlMatch) detectedUrl = urlMatch[0];
    }

    if (detectedUrl) {
      setSourceUrl(detectedUrl);
      setSourceType(detectSourceTypeFromUrl(detectedUrl));
    }
    if (sharedTitle.trim()) {
      setTitle(sharedTitle.trim());
    }
    if (sharedText.trim() && sharedText.trim() !== detectedUrl) {
      setUserSummary(sharedText.trim());
    }
  }, []);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreviewUrl('');
      return;
    }
    const objUrl = URL.createObjectURL(file);
    setPreviewUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [file]);

  const configured = isGithubConfigured(settings);
  const needsFile = sourceType === 'screenshot' || sourceType === 'book';
  const acceptsFile = sourceType === 'screenshot' || sourceType === 'book' || sourceType === 'ig_video';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);

    if (!configured) {
      setStatusMsg({ type: 'err', text: '尚未設定 GitHub PAT 與倉庫資訊，請先前往設定頁。' });
      return;
    }
    if (sourceType === 'screenshot' && !file) {
      setStatusMsg({ type: 'err', text: '請選擇要上傳的截圖檔案。' });
      return;
    }
    if (sourceType === 'book' && !file) {
      setStatusMsg({ type: 'err', text: '請選擇 PDF 或 EPUB 電子書檔案。' });
      return;
    }
    if (!needsFile && !sourceUrl.trim()) {
      setStatusMsg({ type: 'err', text: '請輸入來源網址 URL。' });
      return;
    }

    setSubmitting(true);
    try {
      const stamp = nowTaipeiStamp();
      let assetFilename = '';

      if (file) {
        const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        assetFilename = `${stamp}-${cleanName}`;
        const buf = await file.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        await putVaultFile(
          settings,
          `inbox/pending/${assetFilename}`,
          b64,
          `feat(inbox): upload ${sourceType} asset ${assetFilename}`
        );
      }

      const tags = tagsInput
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);

      const taskPayload = {
        source_type: sourceType,
        source_url: sourceUrl.trim(),
        title: title.trim(),
        user_summary: userSummary.trim(),
        category: category.trim(),
        tags,
        asset_filename: assetFilename,
        created_at: nowTaipeiIso(),
      };

      const taskFilename = `${stamp}-${sourceType}.json`;
      await putVaultFile(
        settings,
        `inbox/pending/${taskFilename}`,
        utf8ToBase64(JSON.stringify(taskPayload, null, 2) + '\n'),
        `feat(inbox): queue ${sourceType} task ${taskFilename}`
      );

      await triggerIngestWorkflow(settings, title.trim() || sourceUrl.trim() || assetFilename);

      setStatusMsg({
        type: 'ok',
        text: `已寫入 inbox/pending/${taskFilename} 並觸發雲端解析管線。`,
      });
      setSourceUrl('');
      setTitle('');
      setUserSummary('');
      setTagsInput('');
      setFile(null);
    } catch (err) {
      setStatusMsg({
        type: 'err',
        text: err instanceof Error ? err.message : '投遞失敗，請檢查網路或 PAT 權限。',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-5">
      {!configured && (
        <div className="dj-card p-4 border-l-2 border-l-[#D47A7A] flex items-center justify-between gap-3">
          <div className="text-xs text-[#9A9E9C]">
            尚未設定私有倉 `kb-vault` 連線憑證
          </div>
          <button
            type="button"
            onClick={onGoSettings}
            className="dj-btn text-xs px-3 shrink-0"
          >
            前往設定
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] tracking-[0.16em] text-[#9A9E9C] uppercase">
              [ 01 ] SOURCE TYPE / 素材類型
            </span>
            <span className="text-[11px] dj-tnum text-[#6E7371]">
              {SOURCE_OPTIONS.find((o) => o.value === sourceType)?.code || '01'} / 06
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {SOURCE_OPTIONS.map((opt, idx) => {
              const active = sourceType === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-source-type={opt.value}
                  onClick={() => {
                    setTypeSlideDir(idx >= prevTypeIdxRef.current ? 'right' : 'left');
                    prevTypeIdxRef.current = idx;
                    setSourceType(opt.value);
                    setFile(null);
                  }}
                  className={`dj-btn px-2 text-xs justify-start transition-all duration-200 ${
                    active
                      ? 'dj-btn-primary text-[#F4F4F0] border-l-2 border-l-[#6FA88B]'
                      : 'text-[#9A9E9C]'
                  }`}
                >
                  <span
                    className={`dj-tnum text-[10px] transition-colors ${
                      active ? 'text-[#6FA88B]' : 'text-[#6E7371]'
                    }`}
                  >
                    {opt.code}
                  </span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          key={sourceType}
          className={`space-y-4 ${
            typeSlideDir === 'right' ? 'dj-enter-right' : 'dj-enter-left'
          }`}
        >
          <div>
            <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
              個人初步備忘 / USER NOTE（選填，留空由 AI 自動判斷重點）
            </label>
            <textarea
              rows={3}
              value={userSummary}
              onChange={(e) => setUserSummary(e.target.value)}
              placeholder="選填：輸入你當下的靈感或想強調的角度；若留空，AI 會自動產生完整摘要..."
              className="dj-input resize-y min-h-[88px]"
            />
          </div>

          {!needsFile && (
            <div>
              <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
                來源網址 / SOURCE URL
              </label>
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://..."
                className="dj-input"
              />
            </div>
          )}

          {acceptsFile && (
            <div>
              <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
                {sourceType === 'book'
                  ? '電子書檔案 / PDF 或 EPUB'
                  : sourceType === 'ig_video'
                  ? '隨附截圖（選填，防反爬蟲降級保護）'
                  : '手機截圖 / IMAGE ASSET'}
              </label>
              <label className="dj-card flex flex-col items-center justify-center p-4 min-h-[72px] cursor-pointer hover:border-[rgba(255,255,255,0.36)] transition-colors">
                <span className="text-xs text-[#F4F4F0] tracking-wider">
                  {file ? file.name : '點擊選擇檔案'}
                </span>
                <span className="text-[11px] text-[#6E7371] dj-tnum mt-1">
                  {file
                    ? `${(file.size / 1024).toFixed(1)} KB`
                    : sourceType === 'book'
                    ? '支援 .pdf / .epub'
                    : '支援 .png / .jpg / .webp'}
                </span>
                <input
                  type="file"
                  accept={sourceType === 'book' ? '.pdf,.epub' : 'image/png,image/jpeg,image/webp'}
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>

              {previewUrl && (
                <div className="dj-curtain-wrap mt-3 border border-[rgba(255,255,255,0.14)] max-h-[220px]">
                  <img
                    src={previewUrl}
                    alt="截圖預覽"
                    className="dj-curtain-media is-revealed max-h-[220px] object-contain mx-auto"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
              自訂標題（選填）
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="留空由 AI 命名"
              className="dj-input"
            />
          </div>
          <div>
            <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
              分類（選填）
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="如：AI技術"
              className="dj-input"
            />
          </div>
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            標籤 / TAGS（逗號分隔，選填）
          </label>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="BYOK, 系統架構"
            className="dj-input"
          />
        </div>

        {statusMsg && (
          <div
            className={`dj-card p-3 text-xs ${
              statusMsg.type === 'ok'
                ? 'border-l-2 border-l-[#6FA88B] text-[#F4F4F0]'
                : 'border-l-2 border-l-[#D47A7A] text-[#F4F4F0]'
            }`}
          >
            {statusMsg.text}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="dj-btn dj-btn-primary w-full text-xs tracking-[0.18em]"
        >
          {submitting ? '寫入 KB-VAULT 並觸發 ACTION 中...' : '投遞至 KB-VAULT 並執行'}
        </button>
      </form>
    </section>
  );
};
