(() => {
  if (window.__aiAutoTranslateLoaded) return;
  window.__aiAutoTranslateLoaded = true;

  const BATCH_SIZE = 40;
  const BATCH_CHAR_LIMIT = 4000;
  const TEXT_CONCURRENCY = 5;
  const IMAGE_CONCURRENCY = 3;
  const MIN_IMG_SIZE = 80;
  const OVERLAY_CLASS = 'ai-translate-img-overlay';

  const originalTexts = new Map();
  const textCache = new Map();
  const imageCache = new Map();
  const overlays = [];
  let translated = false;
  let running = false;
  let cancelled = false;

  function collectTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'code', 'pre', 'textarea', 'svg'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(`.${OVERLAY_CLASS}`)) return NodeFilter.FILTER_REJECT;
        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
        if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) return NodeFilter.FILTER_REJECT;
        if (parent.checkVisibility && !parent.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function sendBg(message) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'No response' });
        }
      });
    });
  }

  function reportProgress(done, total, phase) {
    chrome.runtime.sendMessage({ action: 'translateProgress', done, total, phase }).catch?.(() => {});
  }

  function isInViewport(node) {
    const rect = node.parentElement?.getBoundingClientRect();
    return rect && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  async function runPool(tasks, concurrency) {
    let idx = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (idx < tasks.length && !cancelled) {
        const task = tasks[idx++];
        await task();
      }
    });
    await Promise.all(workers);
  }

  function applyTranslation(text, translation, nodeList) {
    for (const node of nodeList) {
      if (!node.isConnected) continue;
      const original = node.textContent;
      if (!originalTexts.has(node)) originalTexts.set(node, original);
      node.textContent = original.replace(text, translation);
    }
  }

  async function translateAllText(engine, sourceLang, targetLang) {
    const nodes = collectTextNodes();
    const cacheKey = text => `${engine}|${sourceLang}|${targetLang}|${text}`;

    const uniqueTexts = new Map();
    for (const node of nodes) {
      const text = node.textContent.trim();
      if (!uniqueTexts.has(text)) uniqueTexts.set(text, []);
      uniqueTexts.get(text).push(node);
    }

    const cached = [];
    for (const [text, nodeList] of uniqueTexts) {
      const hit = textCache.get(cacheKey(text));
      if (hit !== undefined) {
        applyTranslation(text, hit, nodeList);
        cached.push(text);
      }
    }
    cached.forEach(text => uniqueTexts.delete(text));
    if (uniqueTexts.size === 0) return;

    const entries = [...uniqueTexts.entries()].sort((a, b) => {
      const aVis = a[1].some(isInViewport) ? 0 : 1;
      const bVis = b[1].some(isInViewport) ? 0 : 1;
      return aVis - bVis;
    });

    const batches = [];
    let current = [];
    let currentChars = 0;
    for (const entry of entries) {
      current.push(entry);
      currentChars += entry[0].length;
      if (current.length >= BATCH_SIZE || currentChars >= BATCH_CHAR_LIMIT) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
    }
    if (current.length) batches.push(current);

    const total = entries.length;
    let done = 0;
    let fatalError = null;

    const tasks = batches.map(batch => async () => {
      if (fatalError) return;
      const texts = batch.map(([text]) => text);
      const res = await sendBg({ action: 'aiTranslateTexts', texts, sourceLang, targetLang });

      if (res.ok) {
        batch.forEach(([text], j) => {
          textCache.set(cacheKey(text), res.translations[j]);
        });
        if (cancelled) return;
        batch.forEach(([text, nodeList], j) => {
          applyTranslation(text, res.translations[j], nodeList);
        });
      } else if (res.error === 'NO_API_KEY') {
        fatalError = new Error('NO_API_KEY');
        return;
      }

      done += batch.length;
      reportProgress(done, total, 'text');
    });

    await runPool(tasks, TEXT_CONCURRENCY);
    if (fatalError) throw fatalError;
  }

  function positionOverlay(overlay, img) {
    const rect = img.getBoundingClientRect();
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function createOverlay(img, text) {
    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.textContent = text;
    Object.assign(overlay.style, {
      position: 'absolute',
      zIndex: '2147483646',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: '6px',
      boxSizing: 'border-box',
      background: 'rgba(0, 0, 0, 0.65)',
      color: '#fff',
      fontSize: '14px',
      lineHeight: '1.4',
      whiteSpace: 'pre-wrap',
      overflow: 'hidden',
      pointerEvents: 'none',
      borderRadius: '4px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    });
    positionOverlay(overlay, img);
    document.body.appendChild(overlay);
    overlays.push({ overlay, img });
  }

  function repositionAll() {
    overlays.forEach(({ overlay, img }) => {
      if (img.isConnected) positionOverlay(overlay, img);
    });
  }
  window.addEventListener('resize', repositionAll);

  async function translateImages(targetLang) {
    const imgs = [...document.querySelectorAll('img')].filter(img => {
      const r = img.getBoundingClientRect();
      return r.width >= MIN_IMG_SIZE && r.height >= MIN_IMG_SIZE && img.currentSrc;
    }).slice(0, 10);

    const total = imgs.length;
    let done = 0;

    const tasks = imgs.map(img => async () => {
      const key = `${targetLang}|${img.currentSrc}`;
      let result = imageCache.get(key);
      if (result === undefined) {
        const res = await sendBg({
          action: 'aiTranslateImage',
          imageUrl: img.currentSrc,
          targetLang
        });
        if (res.ok) {
          result = { hasText: res.hasText, translation: res.translation };
          imageCache.set(key, result);
        }
      }
      if (cancelled) return;
      if (result?.hasText && result.translation) {
        createOverlay(img, result.translation);
      }
      done++;
      reportProgress(done, total, 'image');
    });

    await runPool(tasks, IMAGE_CONCURRENCY);
  }

  function restore() {
    cancelled = true;
    originalTexts.forEach((original, node) => {
      if (node.isConnected) node.textContent = original;
    });
    originalTexts.clear();
    overlays.forEach(({ overlay }) => overlay.remove());
    overlays.length = 0;
    translated = false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'startTranslate') {
      if (running) {
        sendResponse({ ok: false, error: 'ALREADY_RUNNING' });
        return;
      }
      running = true;
      cancelled = false;
      (async () => {
        try {
          await translateAllText(message.engine || 'ai', message.sourceLang, message.targetLang);
          if (!cancelled) await translateImages(message.targetLang);
          translated = !cancelled;
          chrome.runtime.sendMessage({
            action: 'translateDone',
            ok: true
          }).catch?.(() => {});
        } catch (err) {
          chrome.runtime.sendMessage({
            action: 'translateDone',
            ok: false,
            error: err.message
          }).catch?.(() => {});
        } finally {
          running = false;
        }
      })();
      sendResponse({ ok: true, started: true });
      return;
    }

    if (message.action === 'restoreOriginal') {
      restore();
      sendResponse({ ok: true });
      return;
    }

    if (message.action === 'getPageStatus') {
      sendResponse({ ok: true, translated, running });
      return;
    }
  });

  const SECRET_PATTERN = /(sk-|pk-|api[_-]?key|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|ya29\.|Bearer\s)/i;

  function looksSensitive(text) {
    if (SECRET_PATTERN.test(text)) return true;
    if (!/\s/.test(text) && text.length > 20) return true;
    return false;
  }

  let lastSelection = '';
  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
      const text = (window.getSelection()?.toString() || '').trim();
      if (!text || text === lastSelection || text.length > 3000) return;
      if (looksSensitive(text)) return;
      lastSelection = text;
      chrome.runtime.sendMessage({ action: 'selectionChanged', text }).catch?.(() => {});
    }, 10);
  });
})();
