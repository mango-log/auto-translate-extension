(() => {
  if (window.__aiAutoTranslateLoaded) return;
  window.__aiAutoTranslateLoaded = true;

  const BATCH_SIZE = 40;
  const BATCH_CHAR_LIMIT = 4000;
  const TEXT_CONCURRENCY = 5;
  const IMAGE_CONCURRENCY = 3;
  const MIN_IMG_SIZE = 80;
  const OVERLAY_CLASS = 'ai-translate-img-overlay';

  const LOADING_CLASS = 'ai-translate-loading';
  const IMG_BADGE_CLASS = 'ai-translate-img-badge';

  const originalTexts = new Map();
  const textCache = new Map();
  const imageCache = new Map();
  const overlays = [];
  const loadingCounts = new Map();

  function injectStyles() {
    if (document.getElementById('ai-translate-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-translate-styles';
    style.textContent = `
      @keyframes aiTranslatePulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.8; } }
      .${LOADING_CLASS} { animation: aiTranslatePulse 1.2s ease-in-out infinite !important; }
      .${IMG_BADGE_CLASS} {
        position: absolute; z-index: 2147483646; padding: 2px 8px;
        background: rgba(0,0,0,0.75); color: #fff; font-size: 11px;
        border-radius: 10px; pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        animation: aiTranslatePulse 1.2s ease-in-out infinite;
      }
    `;
    document.head.appendChild(style);
  }
  injectStyles();

  function markLoading(els) {
    for (const el of els) {
      const c = loadingCounts.get(el) || 0;
      if (c === 0) el.classList.add(LOADING_CLASS);
      loadingCounts.set(el, c + 1);
    }
  }

  function unmarkLoading(els) {
    for (const el of els) {
      const c = (loadingCounts.get(el) || 1) - 1;
      if (c <= 0) {
        loadingCounts.delete(el);
        el.classList.remove(LOADING_CLASS);
      } else {
        loadingCounts.set(el, c);
      }
    }
  }

  function clearAllLoading() {
    loadingCounts.forEach((_, el) => el.classList.remove(LOADING_CLASS));
    loadingCounts.clear();
    document.querySelectorAll(`.${IMG_BADGE_CLASS}`).forEach(b => b.remove());
  }
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
      const parents = [...new Set(
        batch.flatMap(([, nodeList]) => nodeList.map(n => n.parentElement).filter(Boolean))
      )];
      markLoading(parents);
      let res;
      try {
        res = await sendBg({ action: 'aiTranslateTexts', texts, sourceLang, targetLang });
      } finally {
        unmarkLoading(parents);
      }

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

  function overlayAnchor(img) {
    return img.offsetParent || document.body;
  }

  function positionLineOverlay(overlay, img, frac) {
    const w = img.offsetWidth;
    const h = img.offsetHeight;
    const lineHeight = frac.h * h;
    const fontSize = Math.min(Math.max(lineHeight * 0.75, 9), 16);
    overlay.style.left = `${img.offsetLeft + frac.x * w}px`;
    overlay.style.top = `${img.offsetTop + frac.yBottom * h}px`;
    overlay.style.maxWidth = `${w - frac.x * w}px`;
    overlay.style.fontSize = `${fontSize}px`;
  }

  function createLineOverlay(img, bbox, text) {
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const frac = {
      x: bbox.x0 / nw,
      yBottom: bbox.y1 / nh,
      h: (bbox.y1 - bbox.y0) / nh
    };

    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.textContent = text;
    Object.assign(overlay.style, {
      position: 'absolute',
      zIndex: '2147483646',
      padding: '1px 4px',
      boxSizing: 'border-box',
      background: 'rgba(0, 0, 0, 0.75)',
      color: '#fff',
      lineHeight: '1.3',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      pointerEvents: 'none',
      borderRadius: '3px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    });
    positionLineOverlay(overlay, img, frac);
    overlayAnchor(img).appendChild(overlay);
    overlays.push({ overlay, img, frac });
  }

  function createImgBadge(img) {
    const badge = document.createElement('div');
    badge.className = IMG_BADGE_CLASS;
    badge.textContent = '번역 중…';
    badge.style.left = `${img.offsetLeft + 6}px`;
    badge.style.top = `${img.offsetTop + 6}px`;
    overlayAnchor(img).appendChild(badge);
    return badge;
  }

  function repositionAll() {
    overlays.forEach(({ overlay, img, frac }) => {
      if (img.isConnected) positionLineOverlay(overlay, img, frac);
    });
  }
  window.addEventListener('resize', repositionAll);

  let activeConfig = null;
  const processedImages = new Set();

  function eligibleImage(img) {
    if (processedImages.has(img)) return false;
    const r = img.getBoundingClientRect();
    return r.width >= MIN_IMG_SIZE && r.height >= MIN_IMG_SIZE && img.currentSrc;
  }

  async function translateOneImage(img) {
    if (!activeConfig || processedImages.has(img) || !eligibleImage(img)) return;
    processedImages.add(img);
    imageObserver.unobserve(img);

    const { engine, sourceLang, targetLang } = activeConfig;
    const key = `${engine}|${sourceLang}|${targetLang}|${img.currentSrc}`;

    let lines = imageCache.get(key);
    if (lines === undefined) {
      const badge = createImgBadge(img);
      try {
        const res = await sendBg({
          action: 'aiTranslateImage',
          imageUrl: img.currentSrc,
          sourceLang,
          targetLang
        });
        if (res.ok) {
          lines = res.lines;
          imageCache.set(key, lines);
        } else {
          processedImages.delete(img);
        }
      } finally {
        badge.remove();
      }
    }
    if (cancelled || !activeConfig) return;
    if (lines) {
      for (const line of lines) {
        if (line.translation) createLineOverlay(img, line.bbox, line.translation);
      }
    }
  }

  const imageObserver = new IntersectionObserver((entries) => {
    if (!activeConfig) return;
    for (const entry of entries) {
      if (entry.isIntersecting) {
        translateOneImage(entry.target);
      }
    }
  }, { rootMargin: '200px' });

  function observeAllImages() {
    document.querySelectorAll('img').forEach(img => imageObserver.observe(img));
  }

  async function translateImages() {
    observeAllImages();
    document.querySelectorAll('img').forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0 && eligibleImage(img)) {
        translateOneImage(img);
      }
    });
  }

  const mutationObserver = new MutationObserver(mutations => {
    if (!activeConfig) return;
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target.tagName === 'IMG') {
        processedImages.delete(m.target);
        imageObserver.observe(m.target);
      } else {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains(OVERLAY_CLASS)) continue;
          if (node.tagName === 'IMG') {
            imageObserver.observe(node);
          } else {
            node.querySelectorAll?.('img').forEach(img => imageObserver.observe(img));
          }
        }
      }
    }
  });

  function restore() {
    cancelled = true;
    activeConfig = null;
    imageObserver.disconnect();
    mutationObserver.disconnect();
    processedImages.clear();
    clearAllLoading();
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
      activeConfig = {
        engine: message.engine || 'ai',
        sourceLang: message.sourceLang,
        targetLang: message.targetLang
      };
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset']
      });
      translateImages();
      (async () => {
        try {
          await translateAllText(message.engine || 'ai', message.sourceLang, message.targetLang);
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
