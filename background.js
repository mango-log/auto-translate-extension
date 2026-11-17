chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const LANG_NAMES = {
  auto: 'the source language (auto-detect)',
  ko: 'Korean', en: 'English', ja: 'Japanese', zh: 'Chinese',
  es: 'Spanish', fr: 'French', de: 'German', vi: 'Vietnamese', th: 'Thai'
};

function langName(code) {
  return LANG_NAMES[code] || code;
}

async function getSettings() {
  return chrome.storage.local.get({
    engine: 'google',
    provider: 'anthropic',
    apiKey: '',
    model: '',
    sourceLang: 'auto',
    targetLang: 'ko',
    enabled: false
  });
}

function defaultModel(provider) {
  if (provider === 'anthropic') return 'claude-opus-5';
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'gemini') return 'gemini-2.0-flash';
  return '';
}

function buildTextPrompt(texts, sourceLang, targetLang) {
  const src = sourceLang === 'auto' ? 'auto-detected language' : langName(sourceLang);
  return [
    `Translate the following texts from ${src} to ${langName(targetLang)}.`,
    'Rules:',
    '- Translate naturally and fluently, preserving tone and meaning.',
    '- Keep numbers, proper nouns, brand names, and code as-is when appropriate.',
    '- Input is a JSON array of strings. Respond with ONLY a JSON array of translated strings, same length, same order.',
    '- Do not add explanations, markdown, or code fences.',
    '',
    JSON.stringify(texts)
  ].join('\n');
}

function extractJson(raw) {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);
  return JSON.parse(s);
}

async function callAnthropic(apiKey, model, userContent, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API error (${res.status})`);
  }
  if (data.stop_reason === 'refusal') {
    throw new Error('Model refused the request');
  }
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callOpenAI(apiKey, model, userContent, maxTokens) {
  const content = typeof userContent === 'string'
    ? userContent
    : userContent.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        return {
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
        };
      });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `OpenAI API error (${res.status})`);
  }
  return data.choices[0].message.content;
}

async function callGemini(apiKey, model, userContent, maxTokens) {
  const parts = typeof userContent === 'string'
    ? [{ text: userContent }]
    : userContent.map(block => {
        if (block.type === 'text') return { text: block.text };
        return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
      });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini API error (${res.status})`);
  }
  return data.candidates[0].content.parts.map(p => p.text || '').join('');
}

async function callAI(userContent, maxTokens) {
  const { provider, apiKey, model } = await getSettings();
  if (!apiKey) throw new Error('NO_API_KEY');
  const m = model || defaultModel(provider);

  if (provider === 'anthropic') return callAnthropic(apiKey, m, userContent, maxTokens);
  if (provider === 'openai') return callOpenAI(apiKey, m, userContent, maxTokens);
  if (provider === 'gemini') return callGemini(apiKey, m, userContent, maxTokens);
  throw new Error(`Unknown provider: ${provider}`);
}

const GOOGLE_CHUNK_CHARS = 1000;

async function callGoogleChunk(texts, sourceLang, targetLang) {
  const sl = sourceLang === 'auto' ? 'auto' : sourceLang;
  const params = new URLSearchParams({ client: 'dict-chrome-ex', sl, tl: targetLang });
  texts.forEach(t => params.append('q', t));
  const res = await fetch(`https://translate.googleapis.com/translate_a/t?${params}`);
  if (!res.ok) throw new Error(`Google Translate error (${res.status})`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return texts.map((t, i) => {
    const item = list[i];
    if (typeof item === 'string') return item;
    if (Array.isArray(item) && typeof item[0] === 'string') return item[0];
    return t;
  });
}

async function callGoogleTranslate(texts, sourceLang, targetLang) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const t of texts) {
    if (current.length && chars + t.length > GOOGLE_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(t);
    chars += t.length;
  }
  if (current.length) chunks.push(current);

  const results = await Promise.all(
    chunks.map(chunk => callGoogleChunk(chunk, sourceLang, targetLang))
  );
  return results.flat();
}

async function translateTexts(texts, sourceLang, targetLang) {
  const { engine } = await getSettings();
  if (engine === 'google') {
    return callGoogleTranslate(texts, sourceLang, targetLang);
  }
  const raw = await callAI(buildTextPrompt(texts, sourceLang, targetLang), 8192);
  const arr = extractJson(raw);
  if (!Array.isArray(arr)) throw new Error('Unexpected response shape');
  return texts.map((t, i) => (typeof arr[i] === 'string' ? arr[i] : t));
}

async function fetchImageAsBase64(url) {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)[^,]*,(.*)$/);
    if (!match) throw new Error('Invalid data URL');
    return { mediaType: match[1], data: match[2] };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const blob = await res.blob();
  const mediaType = blob.type || 'image/png';
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { mediaType, data: btoa(binary) };
}

const OCR_LANGS = {
  en: 'eng', ko: 'kor', ja: 'jpn', zh: 'chi_sim',
  es: 'spa', fr: 'fra', de: 'deu', vi: 'vie', th: 'tha'
};

function ocrLangs(sourceLang) {
  if (sourceLang !== 'auto' && OCR_LANGS[sourceLang]) return OCR_LANGS[sourceLang];
  return 'eng+jpn+kor';
}

let offscreenReady = null;
async function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'Run Tesseract OCR to extract text positions from images'
        });
      }
    })();
  }
  return offscreenReady;
}

async function translateImage(imageUrl, sourceLang, targetLang) {
  const { mediaType, data } = await fetchImageAsBase64(imageUrl);
  if (data.length > 6_000_000) throw new Error('Image too large');
  const dataUrl = `data:${mediaType};base64,${data}`;

  await ensureOffscreen();
  const ocr = await chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'ocr',
    dataUrl,
    langs: ocrLangs(sourceLang)
  });
  if (!ocr?.ok) throw new Error(ocr?.error || 'OCR failed');
  if (ocr.lines.length === 0) return { lines: [] };

  const texts = ocr.lines.map(l => l.text);
  const translations = await translateTexts(texts, sourceLang, targetLang);

  return {
    lines: ocr.lines.map((l, i) => ({ bbox: l.bbox, translation: translations[i] }))
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === 'offscreen') return;

  if (message.action === 'aiTranslateTexts') {
    translateTexts(message.texts, message.sourceLang, message.targetLang)
      .then(translations => sendResponse({ ok: true, translations }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'aiTranslateImage') {
    translateImage(message.imageUrl, message.sourceLang || 'auto', message.targetLang)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
