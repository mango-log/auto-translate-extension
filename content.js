const TRANSLATE_API = 'https://api.mymemory.translated.net/get';
const BATCH_SIZE = 5;
const CHAR_LIMIT = 400;

let isTranslating = false;
let originalTexts = new Map();
let isTranslated = false;
let targetLang = 'ko';
let autoTranslate = false;

function getTextNodes(root) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const tag = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'code', 'pre', 'textarea'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }

        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    nodes.push(node);
  }
  return nodes;
}

function detectLanguage(text) {
  const koreanPattern = /[가-힯]/;
  const japanesePattern = /[぀-ヿ一-鿿]/;
  const chinesePattern = /[一-鿿]/;

  if (koreanPattern.test(text)) return 'ko';
  if (japanesePattern.test(text)) return 'ja';
  if (chinesePattern.test(text)) return 'zh';
  return 'en';
}

async function translateText(text, from, to) {
  if (!text.trim()) return text;

  const chunks = [];
  for (let i = 0; i < text.length; i += CHAR_LIMIT) {
    chunks.push(text.slice(i, i + CHAR_LIMIT));
  }

  const translated = [];
  for (const chunk of chunks) {
    try {
      const url = `${TRANSLATE_API}?q=${encodeURIComponent(chunk)}&langpair=${from}|${to}`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.responseStatus === 200) {
        translated.push(data.responseData.translatedText);
      } else {
        translated.push(chunk);
      }
    } catch {
      translated.push(chunk);
    }
  }

  return translated.join('');
}

async function translatePage(toLang) {
  if (isTranslating) return;
  isTranslating = true;

  const nodes = getTextNodes(document.body);
  if (nodes.length === 0) {
    isTranslating = false;
    return;
  }

  const sampleText = nodes.slice(0, 3).map(n => n.textContent).join(' ');
  const fromLang = detectLanguage(sampleText);

  if (fromLang === toLang) {
    isTranslating = false;
    return;
  }

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (node) => {
      const original = node.textContent;
      if (!originalTexts.has(node)) {
        originalTexts.set(node, original);
      }

      const translated = await translateText(original.trim(), fromLang, toLang);
      if (translated && node.isConnected) {
        node.textContent = original.replace(original.trim(), translated);
      }
    }));

    await new Promise(r => setTimeout(r, 50));
  }

  isTranslated = true;
  isTranslating = false;
}

function restorePage() {
  originalTexts.forEach((original, node) => {
    if (node.isConnected) {
      node.textContent = original;
    }
  });
  originalTexts.clear();
  isTranslated = false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'translate') {
    targetLang = message.lang || 'ko';
    translatePage(targetLang).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === 'restore') {
    restorePage();
    sendResponse({ success: true });
  }

  if (message.action === 'getStatus') {
    sendResponse({ isTranslated, isTranslating });
  }
});

chrome.storage.sync.get(['autoTranslate', 'targetLang'], (settings) => {
  autoTranslate = settings.autoTranslate || false;
  targetLang = settings.targetLang || 'ko';

  if (autoTranslate) {
    window.addEventListener('load', () => {
      translatePage(targetLang);
    });
  }
});
