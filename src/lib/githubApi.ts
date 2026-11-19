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

  const fetchLatestSha = async (): Promise<string | undefined> => {
    const checkRes = await fetch(
      `${url}?ref=${encodeURIComponent(branch)}&_t=${Date.now()}`,
      {
        headers: ghHeaders(settings.githubPat),
        cache: 'no-store',
        signal,
      }
    );
    if (!checkRes.ok) return undefined;
    const existing = (await checkRes.json()) as { sha?: string };
    return existing.sha;
  };

  let lastStatus = 0;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const existingSha = await fetchLatestSha();
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
      cache: 'no-store',
      signal,
    });

    if (res.ok) return;
    lastStatus = res.status;
    lastErr = await res.text();
    if (res.status !== 409) break;
  }

  throw new Error(`寫入 ${cleanPath} 失敗 (HTTP ${lastStatus}): ${lastErr.slice(0, 180)}`);
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
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}?ref=${encodeURIComponent(branch)}&_t=${Date.now()}`;

  const res = await fetch(url, {
    headers: ghHeaders(settings.githubPat),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`讀取 ${cleanPath} 失敗 (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { content?: string; download_url?: string };
  if (data.content) {
    return base64ToUtf8(data.content);
  }
  if (data.download_url) {
    const rawRes = await fetch(data.download_url, { cache: 'no-store' });
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

export async function deleteVaultFile(
  settings: ByokSettings,
  repoPath: string,
  commitMessage: string
): Promise<void> {
  const owner = settings.githubOwner.trim();
  const repo = settings.githubRepo.trim();
  const branch = settings.githubBranch.trim() || 'main';
  const cleanPath = repoPath.replace(/^\/+/, '');
  const url = `${GH_API_BASE}/repos/${owner}/${repo}/contents/${cleanPath}`;

  const checkRes = await fetch(
    `${url}?ref=${encodeURIComponent(branch)}&_t=${Date.now()}`,
    {
      headers: ghHeaders(settings.githubPat),
      cache: 'no-store',
    }
  );
  if (checkRes.status === 404) return;
  if (!checkRes.ok) {
    throw new Error(`查詢 ${cleanPath} SHA 失敗 (HTTP ${checkRes.status})`);
  }
  const existing = (await checkRes.json()) as { sha?: string };
  if (!existing.sha) return;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...ghHeaders(settings.githubPat),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: commitMessage,
      sha: existing.sha,
      branch,
    }),
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 404) {
    const errText = await res.text();
    throw new Error(`刪除 ${cleanPath} 失敗 (HTTP ${res.status}): ${errText.slice(0, 160)}`);
  }
}

export function extractYoutubeVideoId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(
    /(?:youtube\.com\/watch\?.*?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/live\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
  );
  return m?.[1] || null;
}

export interface PendingEdgeVideo {
  video_id: string;
  url: string;
  title: string;
  channel_name: string;
  channel_id?: string;
  tags?: string[];
  detail_level?: 'concise' | 'detailed';
  queued_at?: string;
  reason?: string;
}

export async function getPendingEdgeVideos(settings: ByokSettings): Promise<PendingEdgeVideo[]> {
  try {
    const raw = await getVaultFileText(settings, 'state/pending_edge_videos.json');
    const parsed = JSON.parse(raw) as { videos?: PendingEdgeVideo[] };
    return Array.isArray(parsed.videos) ? parsed.videos.filter((v) => Boolean(v?.video_id && v?.url)) : [];
  } catch {
    return [];
  }
}

export async function markPendingEdgeVideoCompleted(
  settings: ByokSettings,
  videoId: string,
  channelId?: string
): Promise<void> {
  // 1. Remove from state/pending_edge_videos.json
  try {
    const raw = await getVaultFileText(settings, 'state/pending_edge_videos.json');
    const parsed = JSON.parse(raw) as { videos?: PendingEdgeVideo[] };
    const existing = Array.isArray(parsed.videos) ? parsed.videos : [];
    const filtered = existing.filter((v) => v.video_id !== videoId);
    if (filtered.length !== existing.length) {
      await putVaultFile(
        settings,
        'state/pending_edge_videos.json',
        utf8ToBase64(JSON.stringify({ videos: filtered }, null, 2) + '\n'),
        `chore(follow): complete edge harvest for ${videoId}`
      );
    }
  } catch {
    // ignore if file missing
  }

  // 2. Mark videoId in state/followed_channels.json seen_video_ids
  try {
    const rawCh = await getVaultFileText(settings, 'state/followed_channels.json');
    const parsedCh = JSON.parse(rawCh) as {
      channels?: Array<{ channel_id?: string; seen_video_ids?: string[]; [k: string]: unknown }>;
    };
    const channels = Array.isArray(parsedCh.channels) ? parsedCh.channels : [];
    let modified = false;
    const nextChannels = channels.map((ch) => {
      if (channelId && ch.channel_id && ch.channel_id !== channelId) return ch;
      if (!channelId && channels.length > 1) return ch;
      const seen = new Set(Array.isArray(ch.seen_video_ids) ? ch.seen_video_ids : []);
      if (!seen.has(videoId)) {
        seen.add(videoId);
        modified = true;
        return { ...ch, seen_video_ids: Array.from(seen).slice(-50) };
      }
      return ch;
    });
    if (modified) {
      await putVaultFile(
        settings,
        'state/followed_channels.json',
        utf8ToBase64(JSON.stringify({ channels: nextChannels }, null, 2) + '\n'),
        `chore(follow): mark ${videoId} as seen after edge harvest`
      );
    }
  } catch {
    // ignore if followed_channels.json missing
  }
}

export async function deleteVaultNoteAndAssets(
  settings: ByokSettings,
  notePath: string,
  noteId: string,
  rawAssets: string[],
  currentIndexPayload: import('./kbTypes').SearchIndexPayload | null,
  sourceUrl?: string
): Promise<void> {
  // 1. Delete the note markdown file
  await deleteVaultFile(settings, notePath, `chore(kb): delete note ${noteId}`);

  // 2. Delete associated assets (best-effort)
  for (const raw of rawAssets) {
    const clean = raw.replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
    if (!clean || !clean.startsWith('assets/')) continue;
    try {
      await deleteVaultFile(settings, clean, `chore(kb): delete asset for ${noteId}`);
    } catch {
      // ignore missing asset
    }
  }

  // 3. Re-fetch latest search-index.json (to avoid overwriting recent updates) and remove noteId
  let latestPayload = currentIndexPayload;
  try {
    const freshRaw = await getVaultFileText(settings, 'index/search-index.json');
    latestPayload = JSON.parse(freshRaw) as import('./kbTypes').SearchIndexPayload;
  } catch {
    // fallback to currentIndexPayload
  }

  if (latestPayload) {
    const nextNotes = latestPayload.notes.filter((n) => n.id !== noteId);
    const updatedIndex = {
      ...latestPayload,
      total: nextNotes.length,
      notes: nextNotes,
    };
    await putVaultFile(
      settings,
      'index/search-index.json',
      utf8ToBase64(JSON.stringify(updatedIndex, null, 2) + '\n'),
      `chore(index): remove ${noteId} from search-index.json`
    );
  }

  // 4. If deleted note is a YouTube video, unmark it from followed_channels.json & pending_edge_videos.json
  // so deleting a note from 02 檢索 allows re-analyzing it on the next follow sync.
  const ytId = extractYoutubeVideoId(sourceUrl);
  if (ytId) {
    try {
      const rawCh = await getVaultFileText(settings, 'state/followed_channels.json');
      const parsedCh = JSON.parse(rawCh) as {
        channels?: Array<{ seen_video_ids?: string[]; [k: string]: unknown }>;
      };
      const channels = Array.isArray(parsedCh.channels) ? parsedCh.channels : [];
      let changed = false;
      const nextChannels = channels.map((ch) => {
        const seen = Array.isArray(ch.seen_video_ids) ? ch.seen_video_ids : [];
        if (!seen.includes(ytId)) return ch;
        changed = true;
        return { ...ch, seen_video_ids: seen.filter((id) => id !== ytId) };
      });
      if (changed) {
        await putVaultFile(
          settings,
          'state/followed_channels.json',
          utf8ToBase64(JSON.stringify({ channels: nextChannels }, null, 2) + '\n'),
          `chore(follow): unmark deleted video ${ytId} from seen_video_ids`
        );
      }
    } catch {
      // ignore if followed_channels.json missing
    }

    try {
      const rawEdge = await getVaultFileText(settings, 'state/pending_edge_videos.json');
      const parsedEdge = JSON.parse(rawEdge) as { videos?: PendingEdgeVideo[] };
      const existing = Array.isArray(parsedEdge.videos) ? parsedEdge.videos : [];
      const filtered = existing.filter((v) => v.video_id !== ytId);
      if (filtered.length !== existing.length) {
        await putVaultFile(
          settings,
          'state/pending_edge_videos.json',
          utf8ToBase64(JSON.stringify({ videos: filtered }, null, 2) + '\n'),
          `chore(follow): remove deleted video ${ytId} from pending_edge_videos`
        );
      }
    } catch {
      // ignore if pending_edge_videos.json missing
    }
  }
}
