export const GEMINI_MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash（預設）' },
  { id: 'gemini-3.6-flash', label: 'gemini-3.6-flash' },
  { id: 'hydrogen', label: 'hydrogen' },
  { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite' },
  { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite' },
] as const;

export type AiProvider = 'gemini' | 'openrouter';

export interface ByokSettings {
  openrouterApiKey: string;
  geminiApiKey: string;
  aiProvider: AiProvider;
  geminiModel: string;
  defaultDetailLevel: 'detailed' | 'concise';
  githubPat: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
}

const STORAGE_KEY = 'kb_pwa_byok_settings_v1';

export const DEFAULT_SETTINGS: ByokSettings = {
  openrouterApiKey: '',
  geminiApiKey: '',
  aiProvider: 'gemini',
  geminiModel: 'gemini-3.8-flash',
  defaultDetailLevel: 'detailed',
  githubPat: '',
  githubOwner: '',
  githubRepo: 'dali-km-vault',
  githubBranch: 'main',
};

export function loadSettings(): ByokSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ByokSettings>;
    return {
      openrouterApiKey: String(parsed.openrouterApiKey ?? ''),
      geminiApiKey: String(parsed.geminiApiKey ?? ''),
      aiProvider: parsed.aiProvider === 'openrouter' ? 'openrouter' : 'gemini',
      geminiModel: String(parsed.geminiModel || 'gemini-3.8-flash'),
      defaultDetailLevel: parsed.defaultDetailLevel === 'concise' ? 'concise' : 'detailed',
      githubPat: String(parsed.githubPat ?? ''),
      githubOwner: String(parsed.githubOwner ?? ''),
      githubRepo: String(parsed.githubRepo || 'dali-km-vault'),
      githubBranch: String(parsed.githubBranch || 'main'),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: ByokSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  try {
    const bridge = (window as unknown as { DaliNativeBridge?: { syncSettings?: (s: string) => void } })
      .DaliNativeBridge;
    bridge?.syncSettings?.(JSON.stringify(settings));
  } catch {
    // ignore when running in regular browser
  }
}

export function clearSettings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function isGithubConfigured(s: ByokSettings): boolean {
  return Boolean(s.githubPat.trim() && s.githubOwner.trim() && s.githubRepo.trim());
}

/** Format current time in Asia/Taipei (UTC+8) ISO 8601 */
export function nowTaipeiIso(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.format(now).replace(' ', 'T');
  return `${parts}+08:00`;
}

export function nowTaipeiStamp(): string {
  return nowTaipeiIso()
    .slice(0, 19)
    .replace(/[-:T]/g, '');
}
