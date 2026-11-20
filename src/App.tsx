import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AskView } from './components/AskView';
import { KnowledgeBrowser } from './components/KnowledgeBrowser';
import { MaskedText } from './components/MaskedText';
import { QuickInbox } from './components/QuickInbox';
import { SettingsView } from './components/SettingsView';
import { attachAndroidEdgeStretch } from './lib/androidOverscroll';
import { loadSettings, type ByokSettings } from './lib/storage';

type TabKey = 'inbox' | 'browse' | 'ask' | 'settings';

export interface FloatingProgressPayload {
  kind: 'progress' | 'success' | 'error';
  stage?: string;
  message: string;
  onCancel?: () => void;
}

const TABS: { key: TabKey; code: string; label: string }[] = [
  { key: 'inbox', code: '01', label: '投遞' },
  { key: 'browse', code: '02', label: '檢索' },
  { key: 'ask', code: '03', label: '問答' },
  { key: 'settings', code: '04', label: '設定' },
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('inbox');
  const [slideDir, setSlideDir] = useState<'right' | 'left'>('right');
  const [settings, setSettings] = useState<ByokSettings>(() => loadSettings());
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [browseRefreshSignal, setBrowseRefreshSignal] = useState(0);
  const [floatingToast, setFloatingToast] = useState<{
    visible: boolean;
    exiting: boolean;
    payload: FloatingProgressPayload | null;
  }>({ visible: false, exiting: false, payload: null });
  const [toastCollapsed, setToastCollapsed] = useState(false);
  const [titleAnimKey, setTitleAnimKey] = useState(0);
  const prevIdxRef = useRef(0);
  const tabHistoryRef = useRef<TabKey[]>([]);
  const browseBackRef = useRef<() => boolean>(() => false);
  const toastTimerRef = useRef<number | null>(null);
  const toastExitTimerRef = useRef<number | null>(null);
  const toastTouchStartYRef = useRef<number | null>(null);

  const dismissFloatingToast = useCallback(() => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setFloatingToast((prev) => (prev.visible ? { ...prev, exiting: true } : prev));
    if (toastExitTimerRef.current) {
      window.clearTimeout(toastExitTimerRef.current);
    }
    toastExitTimerRef.current = window.setTimeout(() => {
      setFloatingToast({ visible: false, exiting: false, payload: null });
      setToastCollapsed(false);
      toastExitTimerRef.current = null;
    }, 300);
  }, []);

  const handleFloatingStatus = useCallback(
    (payload: FloatingProgressPayload | null) => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (toastExitTimerRef.current) {
        window.clearTimeout(toastExitTimerRef.current);
        toastExitTimerRef.current = null;
      }
      if (!payload) {
        dismissFloatingToast();
        return;
      }
      setFloatingToast((prev) => {
        if (!prev.visible || payload.kind === 'success' || payload.kind === 'error') {
          setToastCollapsed(false);
        }
        return { visible: true, exiting: false, payload };
      });
      if (payload.kind === 'success') {
        toastTimerRef.current = window.setTimeout(() => {
          dismissFloatingToast();
        }, 10000);
      } else if (payload.kind === 'error') {
        toastTimerRef.current = window.setTimeout(() => {
          dismissFloatingToast();
        }, 8000);
      }
    },
    [dismissFloatingToast]
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (toastExitTimerRef.current) window.clearTimeout(toastExitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return attachAndroidEdgeStretch();
  }, []);

  // Always keep Android native SharedPreferences synced with PWA localStorage settings
  useEffect(() => {
    try {
      window.DaliNativeBridge?.syncSettings?.(JSON.stringify(settings));
    } catch {
      // ignore outside APK
    }
  }, [settings]);

  const switchTab = useCallback(
    (next: TabKey, recordHistory = true) => {
      if (next === activeTab) return;
      if (recordHistory) {
        tabHistoryRef.current = [...tabHistoryRef.current.slice(-9), activeTab];
      }
      if (next === 'inbox') {
        setTitleAnimKey((k) => k + 1);
      }
      const nextIdx = TABS.findIndex((t) => t.key === next);
      setSlideDir(nextIdx >= prevIdxRef.current ? 'right' : 'left');
      prevIdxRef.current = nextIdx;
      setActiveTab(next);
    },
    [activeTab]
  );

  // Android system back gesture handler
  useEffect(() => {
    window.handleDaliNativeBack = () => {
      if (activeTab === 'browse' && browseBackRef.current()) {
        return true;
      }
      if (tabHistoryRef.current.length > 0) {
        const prev = tabHistoryRef.current[tabHistoryRef.current.length - 1];
        tabHistoryRef.current = tabHistoryRef.current.slice(0, -1);
        switchTab(prev, false);
        return true;
      }
      if (activeTab !== 'inbox') {
        switchTab('inbox', false);
        return true;
      }
      return false;
    };
    return () => {
      delete window.handleDaliNativeBack;
    };
  }, [activeTab, switchTab]);

  const registerBrowseBackHandler = useCallback((handler: () => boolean) => {
    browseBackRef.current = handler;
  }, []);

  const handleOpenCitation = (noteId: string) => {
    setSelectedNoteId(noteId);
    switchTab('browse');
  };

  const activeIndex = TABS.findIndex((t) => t.key === activeTab) + 1;
  const animClass = slideDir === 'right' ? 'dj-enter-right' : 'dj-enter-left';

  return (
    <div id="app-shell" className="min-h-screen flex flex-col max-w-[460px] mx-auto relative">
      {/* Top Floating Progress / Completion Banner */}
      {floatingToast.visible && floatingToast.payload && (
        <div className="fixed top-0 left-0 right-0 z-50 safe-top px-3 pt-2 pointer-events-none">
          {toastCollapsed && floatingToast.payload.kind === 'progress' ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setToastCollapsed(false)}
                onTouchStart={(e) => {
                  toastTouchStartYRef.current = e.touches[0]?.clientY ?? null;
                }}
                onTouchEnd={(e) => {
                  const startY = toastTouchStartYRef.current;
                  const endY = e.changedTouches[0]?.clientY ?? null;
                  toastTouchStartYRef.current = null;
                  if (startY !== null && endY !== null && endY - startY > 18) {
                    setToastCollapsed(false);
                  }
                }}
                className="pointer-events-auto dj-glass-panel px-3 py-1 border border-t-0 border-[rgba(255,255,255,0.18)] flex items-center gap-1.5 text-[11px] text-[#6FA88B] shadow-lg"
                aria-label="展開進度通知"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#6FA88B] animate-pulse" />
                <span className="leading-none">▼</span>
              </button>
            </div>
          ) : (
            <div
              onTouchStart={(e) => {
                toastTouchStartYRef.current = e.touches[0]?.clientY ?? null;
              }}
              onTouchEnd={(e) => {
                const startY = toastTouchStartYRef.current;
                const endY = e.changedTouches[0]?.clientY ?? null;
                toastTouchStartYRef.current = null;
                if (
                  floatingToast.payload?.kind === 'progress' &&
                  startY !== null &&
                  endY !== null &&
                  endY - startY < -20
                ) {
                  setToastCollapsed(true);
                }
              }}
              className={`max-w-[440px] mx-auto pointer-events-auto dj-glass-panel border-l-2 px-3.5 py-2.5 shadow-2xl flex items-start justify-between gap-2.5 ${
                floatingToast.payload.kind === 'error'
                  ? 'border-l-[#D47A7A]'
                  : 'border-l-[#6FA88B]'
              } ${floatingToast.exiting ? 'dj-toast-exit' : 'dj-toast-enter'}`}
            >
              <div
                className="min-w-0 flex-1"
                onClick={() => {
                  if (floatingToast.payload?.kind === 'success') {
                    switchTab('browse');
                    dismissFloatingToast();
                  }
                }}
              >
                <div className="flex items-center gap-2 text-[10px] tracking-[0.14em] uppercase mb-0.5">
                  {floatingToast.payload.kind === 'progress' && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#6FA88B] animate-pulse" />
                  )}
                  <span
                    className={
                      floatingToast.payload.kind === 'error' ? 'text-[#D47A7A]' : 'text-[#6FA88B]'
                    }
                  >
                    {floatingToast.payload.kind === 'progress'
                      ? `手機端進度${floatingToast.payload.stage ? ` · ${floatingToast.payload.stage}` : ''}`
                      : floatingToast.payload.kind === 'success'
                      ? '分析完成 · 點擊前往檢索'
                      : '分析狀態'}
                  </span>
                </div>
                <div className="text-xs text-[#F4F4F0] leading-snug break-words">
                  {floatingToast.payload.message}
                </div>
              </div>
              {floatingToast.payload.kind === 'progress' && floatingToast.payload.onCancel ? (
                <div className="shrink-0 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setToastCollapsed(true)}
                    className="text-[11px] px-1.5 py-1 border border-[#252A2C] text-[#9A9E9C] hover:text-[#F4F4F0]"
                    aria-label="收合進度通知"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={floatingToast.payload.onCancel}
                    className="text-[11px] px-2 py-1 border border-[#D47A7A]/60 text-[#D47A7A] hover:bg-[#D47A7A]/15"
                  >
                    停止
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={dismissFloatingToast}
                  className="shrink-0 text-xs px-1.5 py-0.5 text-[#9A9E9C] hover:text-[#F4F4F0]"
                  aria-label="關閉通知"
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Architectural Header */}
      <header className="safe-top px-5 pt-4 pb-4 border-b border-[rgba(255,255,255,0.14)]">
        <div className="flex items-center justify-between text-[11px] tracking-[0.18em] text-[#6E7371] dj-tnum mb-2">
          <span>[ 0{activeIndex} ] KB VAULT</span>
          <span>0{activeIndex} | 04</span>
        </div>
        <h1 className="dj-font-display text-[28px] leading-[1.15] font-normal tracking-[0.04em] text-[#F4F4F0]">
          <MaskedText key={titleAnimKey} text="大里智慧王" />
        </h1>
        <p className="text-[11px] tracking-[0.14em] text-[#9A9E9C] uppercase mt-1">
          MULTIMODAL PERSONAL KNOWLEDGE / BYOK
        </p>
      </header>

      {/* Main Content — keep QuickInbox & KnowledgeBrowser mounted so background analysis & state never reset across tab switches */}
      <main className="flex-1 px-5 py-5 pb-28">
        <div className={activeTab === 'inbox' ? animClass : 'hidden'}>
          <QuickInbox
            settings={settings}
            onGoSettings={() => switchTab('settings')}
            onAnalysisComplete={() => setBrowseRefreshSignal((n) => n + 1)}
            onFloatingStatus={handleFloatingStatus}
          />
        </div>

        <div className={activeTab === 'browse' ? animClass : 'hidden'}>
          <KnowledgeBrowser
            settings={settings}
            selectedNoteId={selectedNoteId}
            onClearSelectedNote={() => setSelectedNoteId(null)}
            onGoSettings={() => switchTab('settings')}
            onRegisterBackHandler={registerBrowseBackHandler}
            isActive={activeTab === 'browse'}
            refreshSignal={browseRefreshSignal}
          />
        </div>

        <div className={activeTab === 'ask' ? animClass : 'hidden'}>
          <AskView
            settings={settings}
            onOpenCitation={handleOpenCitation}
            onGoSettings={() => switchTab('settings')}
          />
        </div>

        {activeTab === 'settings' && (
          <div key="settings" className={animClass}>
            <SettingsView settings={settings} onChange={setSettings} />
          </div>
        )}
      </main>

      {/* Dark Liquid Glass Bottom Navigation */}
      <nav
        aria-label="主導航"
        className="fixed bottom-0 left-0 right-0 z-40 dj-glass-panel border-x-0 border-b-0 safe-bottom"
      >
        <div className="max-w-[460px] mx-auto grid grid-cols-4">
          {TABS.map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                data-tab={tab.key}
                onClick={() => switchTab(tab.key)}
                className={`min-h-[54px] flex flex-col items-center justify-center gap-0.5 transition-colors active:scale-95 ${
                  active ? 'text-[#F4F4F0] bg-[rgba(255,255,255,0.06)]' : 'text-[#6E7371]'
                }`}
              >
                <span className="text-[10px] dj-tnum tracking-[0.14em]">{tab.code}</span>
                <span className="text-xs tracking-[0.1em]">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};

export default App;
