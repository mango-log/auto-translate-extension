const $ = id => document.getElementById(id);

const translateToggle = $('translateToggle');
const sourceLang = $('sourceLang');
const targetLang = $('targetLang');
const status = $('status');
const progressBar = $('progressBar');
const progressFill = $('progressFill');
const provider = $('provider');
const apiKey = $('apiKey');
const model = $('model');
const saveBtn = $('saveBtn');
const settingsStatus = $('settingsStatus');
const settingsDetails = $('settingsDetails');
const selOriginal = $('selOriginal');
const selTranslated = $('selTranslated');

const MODEL_PLACEHOLDERS = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash'
};

function setStatus(el, text, type = '') {
  el.textContent = text;
  el.className = `status ${type}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false });
      }
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {}
}

chrome.storage.local.get(
  { provider: 'anthropic', apiKey: '', model: '', sourceLang: 'auto', targetLang: 'ko' },
  settings => {
    provider.value = settings.provider;
    apiKey.value = settings.apiKey;
    model.value = settings.model;
    sourceLang.value = settings.sourceLang;
    targetLang.value = settings.targetLang;
    model.placeholder = MODEL_PLACEHOLDERS[settings.provider] || '';
    if (!settings.apiKey) settingsDetails.open = true;
  }
);

provider.addEventListener('change', () => {
  model.placeholder = MODEL_PLACEHOLDERS[provider.value] || '';
});

sourceLang.addEventListener('change', () => {
  chrome.storage.local.set({ sourceLang: sourceLang.value });
});

targetLang.addEventListener('change', () => {
  chrome.storage.local.set({ targetLang: targetLang.value });
});

saveBtn.addEventListener('click', () => {
  chrome.storage.local.set(
    { provider: provider.value, apiKey: apiKey.value.trim(), model: model.value.trim() },
    () => {
      setStatus(settingsStatus, '저장되었습니다', 'active');
      setTimeout(() => setStatus(settingsStatus, ''), 2000);
    }
  );
});

translateToggle.addEventListener('change', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  if (translateToggle.checked) {
    const { apiKey: key } = await chrome.storage.local.get({ apiKey: '' });
    if (!key) {
      translateToggle.checked = false;
      settingsDetails.open = true;
      setStatus(status, 'AI 설정에서 API 키를 먼저 저장해주세요', 'error');
      return;
    }

    setStatus(status, '번역 중...', 'loading');
    progressBar.classList.add('visible');
    progressFill.style.width = '0%';

    await ensureContentScript(tab.id);
    const res = await sendToTab(tab.id, {
      action: 'startTranslate',
      sourceLang: sourceLang.value,
      targetLang: targetLang.value
    });

    if (!res.ok && res.error !== 'ALREADY_RUNNING') {
      translateToggle.checked = false;
      progressBar.classList.remove('visible');
      setStatus(status, '페이지에 연결할 수 없습니다. 새로고침 후 다시 시도해주세요', 'error');
    }
  } else {
    progressBar.classList.remove('visible');
    await sendToTab(tab.id, { action: 'restoreOriginal' });
    setStatus(status, '원문으로 복원됨');
  }
});

async function translateSelection(text) {
  selOriginal.textContent = text;
  selTranslated.innerHTML = '<span class="empty">번역 중...</span>';

  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage(
      {
        action: 'aiTranslateTexts',
        texts: [text],
        sourceLang: sourceLang.value,
        targetLang: targetLang.value
      },
      r => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)
    );
  });

  if (res?.ok) {
    selTranslated.textContent = res.translations[0];
  } else if (res?.error === 'NO_API_KEY') {
    selTranslated.innerHTML = '<span class="empty">API 키를 설정해주세요</span>';
    settingsDetails.open = true;
  } else {
    selTranslated.innerHTML = `<span class="empty">번역 실패: ${res?.error || '알 수 없는 오류'}</span>`;
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'selectionChanged' && message.text) {
    translateSelection(message.text);
  }

  if (message.action === 'translateProgress') {
    const pct = message.total ? Math.round((message.done / message.total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    const phaseLabel = message.phase === 'image' ? '이미지' : '텍스트';
    setStatus(status, `${phaseLabel} 번역 중... ${message.done}/${message.total}`, 'loading');
  }

  if (message.action === 'translateDone') {
    progressBar.classList.remove('visible');
    if (message.ok) {
      setStatus(status, '번역 완료', 'active');
    } else if (message.error === 'NO_API_KEY') {
      translateToggle.checked = false;
      settingsDetails.open = true;
      setStatus(status, 'API 키를 설정해주세요', 'error');
    } else {
      translateToggle.checked = false;
      setStatus(status, `번역 실패: ${message.error}`, 'error');
    }
  }
});

(async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const res = await sendToTab(tab.id, { action: 'getPageStatus' });
  if (res.ok) {
    translateToggle.checked = res.translated || res.running;
    if (res.running) setStatus(status, '번역 중...', 'loading');
    else if (res.translated) setStatus(status, '번역된 상태', 'active');
  }
})();
