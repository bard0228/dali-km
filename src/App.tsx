import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AskView } from './components/AskView';
import { KnowledgeBrowser } from './components/KnowledgeBrowser';
import { MaskedText } from './components/MaskedText';
import { QuickInbox } from './components/QuickInbox';
import { SettingsView } from './components/SettingsView';
import { attachAndroidEdgeStretch } from './lib/androidOverscroll';
import { loadSettings, type ByokSettings } from './lib/storage';

type TabKey = 'inbox' | 'browse' | 'ask' | 'settings';

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
  const prevIdxRef = useRef(0);
  const tabHistoryRef = useRef<TabKey[]>([]);
  const browseBackRef = useRef<() => boolean>(() => false);

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
      {/* Architectural Header */}
      <header className="safe-top px-5 pt-4 pb-4 border-b border-[rgba(255,255,255,0.14)]">
        <div className="flex items-center justify-between text-[11px] tracking-[0.18em] text-[#6E7371] dj-tnum mb-2">
          <span>[ 0{activeIndex} ] KB VAULT</span>
          <span>0{activeIndex} | 04</span>
        </div>
        <h1 className="dj-font-display text-[28px] leading-[1.15] font-normal tracking-[0.04em] text-[#F4F4F0]">
          <MaskedText text="大里智慧王" />
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
