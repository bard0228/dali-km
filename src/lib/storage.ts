export interface ByokSettings {
  openrouterApiKey: string;
  githubPat: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
}

const STORAGE_KEY = 'kb_pwa_byok_settings_v1';

export const DEFAULT_SETTINGS: ByokSettings = {
  openrouterApiKey: '',
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
