(() => {
  if (window.__aiAutoTranslateLoaded) return;
  window.__aiAutoTranslateLoaded = true;

  const BATCH_SIZE = 25;
  const MIN_IMG_SIZE = 80;
  const OVERLAY_CLASS = 'ai-translate-img-overlay';

  const originalTexts = new Map();
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

  async function translateAllText(sourceLang, targetLang) {
    const nodes = collectTextNodes();
    const total = nodes.length;
    let done = 0;

    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      if (cancelled) return;
      const batch = nodes.slice(i, i + BATCH_SIZE);
      const texts = batch.map(n => n.textContent.trim());

      const res = await sendBg({ action: 'aiTranslateTexts', texts, sourceLang, targetLang });
      if (cancelled) return;

      if (res.ok) {
        batch.forEach((node, j) => {
          if (!node.isConnected) return;
          const original = node.textContent;
          if (!originalTexts.has(node)) originalTexts.set(node, original);
          node.textContent = original.replace(original.trim(), res.translations[j]);
        });
      } else if (res.error === 'NO_API_KEY') {
        throw new Error('NO_API_KEY');
      }

      done = Math.min(i + BATCH_SIZE, total);
      reportProgress(done, total, 'text');
    }
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

    for (const img of imgs) {
      if (cancelled) return;
      const res = await sendBg({
        action: 'aiTranslateImage',
        imageUrl: img.currentSrc,
        targetLang
      });
      if (cancelled) return;
      if (res.ok && res.hasText && res.translation) {
        createOverlay(img, res.translation);
      }
      done++;
      reportProgress(done, total, 'image');
    }
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
          await translateAllText(message.sourceLang, message.targetLang);
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

  let lastSelection = '';
  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const text = (window.getSelection()?.toString() || '').trim();
      if (!text || text === lastSelection || text.length > 3000) return;
      lastSelection = text;
      chrome.runtime.sendMessage({ action: 'selectionChanged', text }).catch?.(() => {});
    }, 10);
  });
})();
