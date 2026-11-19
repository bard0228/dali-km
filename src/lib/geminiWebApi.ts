import type { StructuredFactCheckItem, StructuredKeyPoint } from './kbTypes';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface FactCheckResult {
  summary: string;
  items: StructuredFactCheckItem[];
}

export async function factCheckNoteWithGemini(
  apiKey: string,
  model: string,
  title: string,
  keyPoints: StructuredKeyPoint[]
): Promise<FactCheckResult> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('請先於「04 設定」填入 Gemini API Key 才能使用 Google Search 事實查核。');
  }

  const claimsText = keyPoints
    .filter((kp) => kp.point?.trim())
    .slice(0, 15)
    .map((kp) => `- ${kp.point}${kp.detail ? `: ${kp.detail}` : ''}`)
    .join('\n');

  if (!claimsText.trim()) {
    return { summary: '此筆記無可查證之客觀陳述。', items: [] };
  }

  const prompt = [
    '你是嚴謹的事實查核員，使用繁體中文（台灣）回答。',
    `主題：${title}`,
    '任務：逐一檢查以下重點中「可查證的事實陳述」（數據、醫療健康、科學、歷史、法規、產品規格等），主觀意見不用查，最多查 6 項。',
    '健康醫療相關優先引用衛福部、國健署、食藥署、WHO 或醫學期刊。',
    '請先用 Google 搜尋查證，最後只輸出一個 JSON 物件（不要其他文字），格式：',
    '{"summary":"一句話總評可信度","items":[{"claim":"陳述","verdict":"正確|有爭議|錯誤|無法查證","reason":"40~80字理由","sources":[{"title":"來源標題","url":"https://..."}]}]}',
    '',
    '待查證內容：',
    claimsText,
  ].join('\n');

  const targetModel = (model || 'gemini-3.8-flash').trim();
  const res = await fetch(`${GEMINI_API_BASE}/models/${targetModel}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini 事實查核失敗 (HTTP ${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('\n')
    .trim();

  if (!rawText) {
    throw new Error('Gemini 事實查核回傳空白內容。');
  }

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  const jsonSlice = s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned;
  const parsed = JSON.parse(jsonSlice) as {
    summary?: string;
    items?: Array<{
      claim?: string;
      verdict?: string;
      reason?: string;
      sources?: Array<{ title?: string; url?: string }>;
    }>;
  };

  const allowed = new Set(['正確', '有爭議', '錯誤', '無法查證']);
  const items: StructuredFactCheckItem[] = (parsed.items || [])
    .filter((it) => it && (it.claim || it.reason))
    .map((it) => {
      const v = String(it.verdict || '無法查證').trim();
      return {
        claim: String(it.claim || '').trim(),
        verdict: allowed.has(v) ? v : '無法查證',
        reason: String(it.reason || '').trim(),
        sources: (it.sources || [])
          .filter((src) => src && src.url)
          .slice(0, 3)
          .map((src) => ({
            title: String(src.title || src.url || '').trim(),
            url: String(src.url || '').trim(),
          })),
      };
    });

  return {
    summary: String(parsed.summary || '').trim(),
    items,
  };
}

export function injectFactCheckIntoNoteMarkdown(
  rawMd: string,
  factCheck: FactCheckResult
): string {
  // 1. Update DALI_STRUCTURED_JSON block if present
  let updated = rawMd.replace(
    /<!--\s*DALI_STRUCTURED_JSON\s*\n([\s\S]*?)\n\s*-->/,
    (full, jsonBody: string) => {
      try {
        const obj = JSON.parse(jsonBody.trim()) as Record<string, unknown>;
        obj.fact_check = factCheck;
        return `<!-- DALI_STRUCTURED_JSON\n${JSON.stringify(obj, null, 2)}\n-->`;
      } catch {
        return full;
      }
    }
  );

  // 2. Build/replace ## 事實查核 section
  const fcLines: string[] = ['## 事實查核', ''];
  if (factCheck.summary) {
    fcLines.push(`**總評**：${factCheck.summary}`, '');
  }
  for (const item of factCheck.items) {
    fcLines.push(`- **[${item.verdict}]** ${item.claim}`);
    if (item.reason) fcLines.push(`  - ${item.reason}`);
  }
  const fcBlock = fcLines.join('\n').trim();

  if (/^##\s+事實查核\b[\s\S]*?(?=^##\s+|<details>|<!--\s*DALI_STRUCTURED_JSON|$)/m.test(updated)) {
    updated = updated.replace(
      /^##\s+事實查核\b[\s\S]*?(?=^##\s+|<details>|<!--\s*DALI_STRUCTURED_JSON|$)/m,
      `${fcBlock}\n\n`
    );
  } else if (updated.includes('<!-- DALI_STRUCTURED_JSON')) {
    updated = updated.replace(
      '<!-- DALI_STRUCTURED_JSON',
      `${fcBlock}\n\n<!-- DALI_STRUCTURED_JSON`
    );
  } else {
    updated = `${updated.trim()}\n\n${fcBlock}\n`;
  }

  return updated;
}
