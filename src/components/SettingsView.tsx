import React, { useState } from 'react';
import { testVaultConnection } from '../lib/githubApi';
import { clearSettings, saveSettings, type ByokSettings } from '../lib/storage';

interface SettingsViewProps {
  settings: ByokSettings;
  onChange: (next: ByokSettings) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ settings, onChange }) => {
  const [draft, setDraft] = useState<ByokSettings>(settings);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveSettings(draft);
    onChange(draft);
    setFeedback({ ok: true, text: '已儲存至本機瀏覽器 localStorage（不會上傳至任何伺服器）。' });
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
    const empty: ByokSettings = {
      openrouterApiKey: '',
      githubPat: '',
      githubOwner: '',
      githubRepo: 'kb-vault',
      githubBranch: 'main',
    };
    setDraft(empty);
    onChange(empty);
    setFeedback({ ok: true, text: '已清除本機憑證。' });
  };

  return (
    <section className="space-y-4">
      <div className="dj-card p-3 text-xs text-[#9A9E9C] leading-relaxed">
        BYOK 零後端模式：所有金鑰僅存放於本機 <span className="text-[#F4F4F0]">localStorage</span>，直接透過 HTTPS 與 GitHub REST API 及 OpenRouter 通訊。
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
              placeholder="kb-vault"
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
            OPENROUTER API KEY（:free 問答用）
          </label>
          <input
            type="password"
            value={draft.openrouterApiKey}
            onChange={(e) => setDraft({ ...draft, openrouterApiKey: e.target.value })}
            placeholder="sk-or-v1-..."
            className="dj-input"
          />
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
