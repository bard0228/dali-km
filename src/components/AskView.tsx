import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getVaultFileText } from '../lib/githubApi';
import {
  rankNotesByQuery,
  stripFrontmatter,
  type SearchIndexEntry,
  type SearchIndexPayload,
} from '../lib/kbTypes';
import { askOpenRouterWithCitations, type ContextNote } from '../lib/openrouterApi';
import { isGithubConfigured, nowTaipeiIso, type ByokSettings } from '../lib/storage';
import { IconTrash } from './LineIcons';

interface AskViewProps {
  settings: ByokSettings;
  onOpenCitation: (noteId: string) => void;
  onGoSettings: () => void;
}

interface AskHistoryItem {
  id: string;
  question: string;
  answer: string;
  citations: SearchIndexEntry[];
  createdAt: string;
}

const ASK_HISTORY_KEY = 'kb_pwa_ask_history_v1';
const MAX_HISTORY_ITEMS = 30;

function loadAskHistory(): AskHistoryItem[] {
  try {
    const raw = localStorage.getItem(ASK_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AskHistoryItem[]) : [];
  } catch {
    return [];
  }
}

export const AskView: React.FC<AskViewProps> = ({
  settings,
  onOpenCitation,
  onGoSettings,
}) => {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [history, setHistory] = useState<AskHistoryItem[]>(() => loadAskHistory());
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<AskHistoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
    } catch {
      // ignore storage quota errors
    }
  }, [history]);

  const configured = isGithubConfigured(settings) && Boolean(settings.openrouterApiKey.trim());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setHistory((prev) => prev.filter((item) => item.id !== deleteTarget.id));
    setExpandedIds((prev) => {
      const next = { ...prev };
      delete next[deleteTarget.id];
      return next;
    });
    setDeleteTarget(null);
  };

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setError(null);

    try {
      const rawIdx = await getVaultFileText(settings, 'index/search-index.json');
      const indexData = JSON.parse(rawIdx) as SearchIndexPayload;
      const topEntries = rankNotesByQuery(indexData.notes || [], q, 4);
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
        q,
        contexts
      );
      const newItem: AskHistoryItem = {
        id: `qa_${Date.now()}`,
        question: q,
        answer: aiAnswer,
        citations: topEntries,
        createdAt: nowTaipeiIso(),
      };
      setHistory((prev) => [newItem, ...prev].slice(0, MAX_HISTORY_ITEMS));
      setExpandedIds((prev) => ({ ...prev, [newItem.id]: true }));
      setQuestion('');
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
          請先設定 GitHub PAT 與 OpenRouter API Key（僅使用 `openrouter/free` 免費模型）。
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
        <span className="text-[10px] dj-tnum text-[#6E7371]">TOP-4 / OPENROUTER FREE</span>
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

      {history.length > 0 && (
        <div className="space-y-2.5 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] tracking-[0.16em] text-[#9A9E9C] uppercase">
              問答紀錄（{history.length}，點擊問題展開解答）
            </span>
          </div>

          <div className="space-y-2">
            {history.map((item, idx) => {
              const isOpen = Boolean(expandedIds[item.id]);
              return (
                <div
                  key={item.id}
                  style={{ '--deal-idx': idx } as React.CSSProperties}
                  className="dj-card dj-deal-card overflow-hidden"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(item.id);
                      }
                    }}
                    className="w-full text-left p-3.5 flex items-start justify-between gap-2 hover:bg-[rgba(255,255,255,0.03)] transition-colors cursor-pointer"
                  >
                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="text-[10px] dj-tnum text-[#6FA88B]">
                        [ Q{String(history.length - idx).padStart(2, '0')} ] · {item.createdAt.slice(0, 16).replace('T', ' ')}
                      </div>
                      <div className="text-xs font-medium text-[#F4F4F0] leading-snug">
                        {item.question}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2 pt-0.5">
                      <span className="text-[10px] dj-tnum text-[#9A9E9C]">
                        {isOpen ? '收合 ▲' : '展開 ▼'}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(item);
                        }}
                        className="p-1 text-[#9A9E9C] hover:text-[#D47A7A] transition-colors"
                        aria-label="刪除此問答紀錄"
                      >
                        <IconTrash className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="px-3.5 pb-3.5 pt-1 border-t border-[rgba(255,255,255,0.08)] space-y-3 dj-enter-right">
                      <div className="space-y-1.5 pt-2">
                        <div className="text-[10px] tracking-[0.16em] text-[#6FA88B] uppercase">
                          AI 溯源回答
                        </div>
                        <div className="text-xs text-[#F4F4F0] whitespace-pre-wrap leading-relaxed">
                          {item.answer}
                        </div>
                      </div>

                      {item.citations.length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-[10px] tracking-[0.16em] text-[#9A9E9C] uppercase">
                            引用來源（點擊開啟筆記）
                          </div>
                          {item.citations.map((cite, cIdx) => (
                            <button
                              key={cite.id}
                              type="button"
                              onClick={() => onOpenCitation(cite.id)}
                              className="w-full text-left p-2.5 bg-[#0B0D0F] border border-[#252A2C] hover:border-[rgba(255,255,255,0.36)] transition-colors space-y-0.5 block"
                            >
                              <div className="flex items-center justify-between text-[10px] dj-tnum text-[#6FA88B]">
                                <span>
                                  [ {String(cIdx + 1).padStart(2, '0')} ] {cite.source_type.toUpperCase()}
                                </span>
                                <span className="text-[#6E7371]">{cite.created_at.slice(0, 10)}</span>
                              </div>
                              <div className="text-xs font-medium text-[#F4F4F0]">{cite.title}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {deleteTarget &&
        createPortal(
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setDeleteTarget(null);
            }}
          >
            <div className="dj-card w-full max-w-sm p-5 space-y-4">
              <div className="text-xs tracking-[0.14em] text-[#D47A7A] uppercase">
                確認刪除問答紀錄
              </div>
              <div className="text-xs text-[#E2E4E2] leading-relaxed">
                確定要刪除這筆提問嗎？
                <div className="mt-2 p-2 bg-[#0B0D0F] border border-[#252A2C] text-[#F4F4F0] line-clamp-2">
                  {deleteTarget.question}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                  className="dj-btn text-xs"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  className="dj-btn text-xs border-[#D47A7A]/70 text-[#D47A7A] hover:bg-[#D47A7A]/15"
                >
                  確認刪除
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
};
