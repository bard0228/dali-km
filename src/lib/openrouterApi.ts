import type { SearchIndexEntry } from './kbTypes';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FREE_MODEL = 'openrouter/free';

export interface ContextNote {
  entry: SearchIndexEntry;
  content: string;
}

export async function askOpenRouterWithCitations(
  apiKey: string,
  question: string,
  contexts: ContextNote[]
): Promise<string> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('請先於設定頁填寫 OPENROUTER_API_KEY。');
  }
  if (contexts.length === 0) {
    throw new Error('知識庫目前沒有可供檢索的筆記。');
  }

  const contextBlock = contexts
    .map(
      (ctx, idx) =>
        `[${idx + 1}] 標題：${ctx.entry.title}\n分類：${ctx.entry.category} | 類型：${ctx.entry.source_type} | 時間：${ctx.entry.created_at}\n內容：\n${ctx.content.slice(0, 3500)}`
    )
    .join('\n\n---\n\n');

  const systemPrompt =
    '你是「大里智慧王」個人知識庫的問答助手。請嚴格根據下方提供的筆記內容回答使用者問題（繁體中文）。\n' +
    '規則：\n' +
    '1. 必須在句末或段落清楚標註引用來源編號，例如 [1]、[2]。\n' +
    '2. 若筆記中沒有足夠資訊，請誠實說明，切勿憑空捏造。\n' +
    '3. 優先參考每則筆記最上方的「使用者初步重點」。';

  const userPrompt = `問題：${question.trim()}\n\n=== 檢索到的知識筆記 ===\n\n${contextBlock}`;

  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin,
        'X-Title': 'kb-pwa',
      },
      body: JSON.stringify({
        model: FREE_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error('OpenRouter 回傳空白內容。');
      return answer;
    }

    lastErr = `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      const waitMs = 1500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const errText = await res.text();
    throw new Error(`OpenRouter 錯誤 (${res.status}): ${errText.slice(0, 160)}`);
  }

  throw new Error(`OpenRouter 達到重試上限 (${lastErr})，請稍後再試。`);
}
