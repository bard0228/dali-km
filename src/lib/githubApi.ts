import type { ByokSettings } from './storage';

const GH_API_BASE = 'https://api.github.com';

function ghHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat.trim()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export async function testVaultConnection(
  settings: ByokSettings
): Promise<{ ok: boolean; message: string }> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const pat = settings.githubPat.trim();

  if (!owner || !repo || !pat) {
    return { ok: false, message: '請先填寫 GitHub Owner、Repo 與 PAT。' };
  }

  const res = await fetch(`${GH_API_BASE}/repos/${owner}/${repo}`, {
    headers: ghHeaders(pat),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 140)}` };
  }

  const data = (await res.json()) as { full_name?: string; private?: boolean };
  return {
    ok: true,
    message: `已連線 ${data.full_name}（${data.private ? 'Private' : 'Public'}）`,
  };
}

export async function putVaultFile(
  settings: ByokSettings,
  repoPath: string,
  base64Content: string,
  commitMessage: string,
  signal?: AbortSignal
): Promise<void> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const branch = settings.githubBranch.trim() || 'main';
  const cleanPath = repoPath.replace(/^\/+/, '');
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}`;

  // Check if file exists to grab SHA for updates
  let existingSha: string | undefined;
  const checkRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
    headers: ghHeaders(settings.githubPat),
    signal,
  });
  if (checkRes.ok) {
    const existing = (await checkRes.json()) as { sha?: string };
    existingSha = existing.sha;
  }

  const body: Record<string, string> = {
    message: commitMessage,
    content: base64Content,
    branch,
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...ghHeaders(settings.githubPat),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`寫入 ${cleanPath} 失敗 (HTTP ${res.status}): ${errText.slice(0, 180)}`);
  }
}

export async function triggerIngestWorkflow(
  settings: ByokSettings,
  noteHint = '',
  signal?: AbortSignal
): Promise<void> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const branch = settings.githubBranch.trim() || 'main';
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/actions/workflows/ingest.yml/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...ghHeaders(settings.githubPat),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: branch,
      inputs: {
        trigger_source: 'kb-pwa',
        note_hint: noteHint.slice(0, 120),
      },
    }),
    signal,
  });

  if (!res.ok && res.status !== 204) {
    const errText = await res.text();
    throw new Error(`觸發 GitHub Action 失敗 (HTTP ${res.status}): ${errText.slice(0, 180)}`);
  }
}

export async function triggerFollowWorkflow(
  settings: ByokSettings,
  signal?: AbortSignal
): Promise<void> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const branch = settings.githubBranch.trim() || 'main';
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/actions/workflows/follow.yml/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...ghHeaders(settings.githubPat),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: branch }),
    signal,
  });

  if (!res.ok && res.status !== 204) {
    const errText = await res.text();
    throw new Error(`觸發頻道追蹤失敗 (HTTP ${res.status}): ${errText.slice(0, 180)}`);
  }
}

export async function getVaultFileText(
  settings: ByokSettings,
  repoPath: string
): Promise<string> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const branch = settings.githubBranch.trim() || 'main';
  const cleanPath = repoPath.replace(/^\/+/, '');
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;

  const res = await fetch(url, { headers: ghHeaders(settings.githubPat) });
  if (!res.ok) {
    throw new Error(`讀取 ${cleanPath} 失敗 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { content?: string; download_url?: string };
  if (data.content) {
    return base64ToUtf8(data.content);
  }
  if (data.download_url) {
    const rawRes = await fetch(data.download_url);
    return await rawRes.text();
  }
  throw new Error(`檔案 ${cleanPath} 無內容可讀取`);
}

export async function getVaultAssetBlobUrl(
  settings: ByokSettings,
  repoPath: string
): Promise<string> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const branch = settings.githubBranch.trim() || 'main';
  const cleanPath = repoPath.replace(/^\/+/, '');
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}`;

  const res = await fetch(url, { headers: ghHeaders(settings.githubPat) });
  if (!res.ok) {
    throw new Error(`讀取原圖 ${cleanPath} 失敗 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { content?: string };
  if (!data.content) {
    throw new Error(`原圖 ${cleanPath} 無法取得 base64 內容`);
  }
  const cleanB64 = data.content.replace(/\s/g, '');
  const binary = atob(cleanB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const ext = cleanPath.split('.').pop()?.toLowerCase() || 'png';
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
      ? 'image/webp'
      : 'image/png';
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
