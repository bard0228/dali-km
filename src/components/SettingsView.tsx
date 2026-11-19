import React, { useState } from 'react';
import { testVaultConnection } from '../lib/githubApi';
import { isNativeApkEnv } from '../lib/nativeBridge';
import {
  clearSettings,
  DEFAULT_SETTINGS,
  GEMINI_MODEL_OPTIONS,
  saveSettings,
  type ByokSettings,
} from '../lib/storage';
import { IconPhone } from './LineIcons';

interface SettingsViewProps {
  settings: ByokSettings;
  onChange: (next: ByokSettings) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ settings, onChange }) => {
  const [draft, setDraft] = useState<ByokSettings>(settings);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const isNative = isNativeApkEnv();

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveSettings(draft);
    onChange(draft);
    setFeedback({
      ok: true,
      text: isNative
        ? '已儲存至本機並同步給 Android 原生擷取引擎。'
        : '已儲存至本機瀏覽器 localStorage（不會上傳至任何伺服器）。',
    });
  };

  const handleTest = async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const res = await testVaultConnection(draft);
      setFeedback({ ok: res.ok, text: res.message });
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : '連線測試失敗',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleClear = () => {
    clearSettings();
    const empty: ByokSettings = { ...DEFAULT_SETTINGS };
    setDraft(empty);
    onChange(empty);
    setFeedback({ ok: true, text: '已清除本機憑證。' });
  };

  return (
    <section className="space-y-4">
      <div className="dj-card p-3 text-xs text-[#9A9E9C] leading-relaxed space-y-1.5">
        <div>
          BYOK 零後端模式：所有金鑰僅存放於本機 <span className="text-[#F4F4F0]">localStorage</span>，直接透過 HTTPS 與 GitHub、Gemini 及 OpenRouter 通訊。
        </div>
        {isNative && (
          <div className="flex items-center gap-1.5 text-[#6FA88B] font-medium">
            <IconPhone className="w-3.5 h-3.5 shrink-0" />
            <span>已啟動「大里智慧王 Android 原生擷取外殼」（系統分享／無字幕直讀／抖音攔截）。</span>
          </div>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-3.5">
        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            GITHUB OWNER（帳號名稱）
          </label>
          <input
            type="text"
            value={draft.githubOwner}
            onChange={(e) => setDraft({ ...draft, githubOwner: e.target.value })}
            placeholder="例如：bard0228"
            className="dj-input"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
              VAULT REPO
            </label>
            <input
              type="text"
              value={draft.githubRepo}
              onChange={(e) => setDraft({ ...draft, githubRepo: e.target.value })}
              placeholder="dali-km-vault"
              className="dj-input"
            />
          </div>
          <div>
            <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
              BRANCH
            </label>
            <input
              type="text"
              value={draft.githubBranch}
              onChange={(e) => setDraft({ ...draft, githubBranch: e.target.value })}
              placeholder="main"
              className="dj-input"
            />
          </div>
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            GITHUB PAT（需 repo + workflow 權限）
          </label>
          <input
            type="password"
            value={draft.githubPat}
            onChange={(e) => setDraft({ ...draft, githubPat: e.target.value })}
            placeholder="ghp_... 或 github_pat_..."
            className="dj-input"
          />
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            預設分析引擎
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDraft({ ...draft, aiProvider: 'gemini' })}
              className={`py-2 px-3 border text-xs transition-colors ${
                draft.aiProvider === 'gemini'
                  ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                  : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
              }`}
            >
              Gemini API（推薦）
            </button>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, aiProvider: 'openrouter' })}
              className={`py-2 px-3 border text-xs transition-colors ${
                draft.aiProvider === 'openrouter'
                  ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                  : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
              }`}
            >
              OpenRouter (openrouter/free)
            </button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            GEMINI API KEY（免費額度：影音直讀、事實查核、多頁 OCR）
          </label>
          <input
            type="password"
            value={draft.geminiApiKey}
            onChange={(e) => setDraft({ ...draft, geminiApiKey: e.target.value })}
            placeholder="AIzaSy...（至 aistudio.google.com/apikey 免費取得）"
            className="dj-input"
          />
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            GEMINI 預設模型
          </label>
          <select
            value={draft.geminiModel}
            onChange={(e) => setDraft({ ...draft, geminiModel: e.target.value })}
            className="dj-input text-xs"
          >
            {GEMINI_MODEL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            OPENROUTER API KEY（固定使用 openrouter/free）
          </label>
          <input
            type="password"
            value={draft.openrouterApiKey}
            onChange={(e) => setDraft({ ...draft, openrouterApiKey: e.target.value })}
            placeholder="sk-or-v1-..."
            className="dj-input"
          />
        </div>

        <div>
          <label className="block text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mb-1.5">
            預設重點整理詳細程度
          </label>
          <div className="grid grid-cols-2 gap-2">
            {(['detailed', 'concise'] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setDraft({ ...draft, defaultDetailLevel: lvl })}
                className={`py-2 px-3 border text-xs transition-colors ${
                  draft.defaultDetailLevel === lvl
                    ? 'border-[#6FA88B] bg-[#6FA88B]/15 text-[#F4F4F0]'
                    : 'border-[#252A2C] bg-[#0B0D0F] text-[#9A9E9C]'
                }`}
              >
                {lvl === 'detailed' ? '詳細模式 (10~20條)' : '精簡模式 (5~8條)'}
              </button>
            ))}
          </div>
        </div>

        {feedback && (
          <div
            className={`dj-card p-3 text-xs ${
              feedback.ok ? 'border-l-2 border-l-[#6FA88B]' : 'border-l-2 border-l-[#D47A7A]'
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="dj-btn text-xs"
          >
            {testing ? '測試中...' : '測試倉庫連線'}
          </button>
          <button type="submit" className="dj-btn dj-btn-primary text-xs">
            儲存設定
          </button>
        </div>

        <button
          type="button"
          onClick={handleClear}
          className="dj-btn w-full text-xs text-[#9A9E9C]"
        >
          清除本機憑證
        </button>
      </form>
    </section>
  );
};
