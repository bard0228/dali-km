import React, { useState } from 'react';
import { getVaultFileText } from '../lib/githubApi';
import {
  rankNotesByQuery,
  stripFrontmatter,
  type SearchIndexEntry,
  type SearchIndexPayload,
} from '../lib/kbTypes';
import { askOpenRouterWithCitations, type ContextNote } from '../lib/openrouterApi';
import { isGithubConfigured, type ByokSettings } from '../lib/storage';

interface AskViewProps {
  settings: ByokSettings;
  onOpenCitation: (noteId: string) => void;
  onGoSettings: () => void;
}

export const AskView: React.FC<AskViewProps> = ({
  settings,
  onOpenCitation,
  onGoSettings,
}) => {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<SearchIndexEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const configured = isGithubConfigured(settings) && Boolean(settings.openrouterApiKey.trim());

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    setError(null);
    setAnswer('');
    setCitations([]);

    try {
      const rawIdx = await getVaultFileText(settings, 'index/search-index.json');
      const indexData = JSON.parse(rawIdx) as SearchIndexPayload;
      const topEntries = rankNotesByQuery(indexData.notes || [], question, 4);
      if (topEntries.length === 0) {
        throw new Error('知識庫目前尚無筆記可供問答。');
      }

      const contexts: ContextNote[] = [];
      for (const entry of topEntries) {
        const md = await getVaultFileText(settings, entry.path);
        contexts.push({ entry, content: stripFrontmatter(md) });
      }

      const aiAnswer = await askOpenRouterWithCitations(
        settings.openrouterApiKey,
        question,
        contexts
      );
      setAnswer(aiAnswer);
      setCitations(topEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 問答失敗');
    } finally {
      setAsking(false);
    }
  };

  if (!configured) {
    return (
      <section className="dj-card p-5 space-y-3">
        <div className="text-[11px] tracking-[0.16em] text-[#6E7371] dj-tnum">
          [ 03 ] CITATION Q&amp;A
        </div>
        <div className="text-xs text-[#9A9E9C]">
          請先設定 GitHub PAT 與 OpenRouter API Key（僅使用 `:free` 免費模型）。
        </div>
        <button type="button" onClick={onGoSettings} className="dj-btn text-xs">
          前往設定頁
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] tracking-[0.16em] text-[#9A9E9C] uppercase">
          [ 03 ] CITATION Q&amp;A
        </span>
        <span className="text-[10px] dj-tnum text-[#6E7371]">TOP-4 / :FREE</span>
      </div>

      <form onSubmit={handleAsk} className="space-y-3">
        <textarea
          rows={3}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="針對你的知識庫提問（將自動檢索 Top-4 筆記全文並附帶引用來源）..."
          className="dj-input resize-y min-h-[88px]"
        />
        <button
          type="submit"
          disabled={asking || !question.trim()}
          className="dj-btn dj-btn-primary w-full text-xs tracking-[0.16em]"
        >
          {asking ? '檢索筆記並生成引用回答中...' : '送出知識庫問答'}
        </button>
      </form>

      {error && (
        <div className="dj-card p-3 border-l-2 border-l-[#D47A7A] text-xs text-[#F4F4F0]">
          {error}
        </div>
      )}

      {answer && (
        <div className="space-y-3 dj-enter-right">
          <div className="dj-card p-4 space-y-2">
            <div className="text-[10px] tracking-[0.16em] text-[#6FA88B] uppercase">
              AI 溯源回答
            </div>
            <div className="text-xs text-[#F4F4F0] whitespace-pre-wrap leading-relaxed">
              {answer}
            </div>
          </div>

          {citations.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] tracking-[0.16em] text-[#9A9E9C] uppercase">
                引用來源卡片（點擊開啟筆記與原圖）
              </div>
              {citations.map((cite, idx) => (
                <button
                  key={cite.id}
                  type="button"
                  onClick={() => onOpenCitation(cite.id)}
                  className="dj-card w-full text-left p-3 hover:border-[rgba(255,255,255,0.36)] transition-colors space-y-1 block"
                >
                  <div className="flex items-center justify-between text-[10px] dj-tnum text-[#6FA88B]">
                    <span>[ {String(idx + 1).padStart(2, '0')} ] {cite.source_type.toUpperCase()}</span>
                    <span className="text-[#6E7371]">{cite.created_at.slice(0, 10)}</span>
                  </div>
                  <div className="text-xs font-medium text-[#F4F4F0]">{cite.title}</div>
                  {cite.user_summary && (
                    <div className="text-[11px] text-[#9A9E9C] line-clamp-1">
                      {cite.user_summary}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
