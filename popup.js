const langSelect = document.getElementById('langSelect');
const autoToggle = document.getElementById('autoToggle');
const translateBtn = document.getElementById('translateBtn');
const restoreBtn = document.getElementById('restoreBtn');
const status = document.getElementById('status');

function setStatus(text, type = '') {
  status.textContent = text;
  status.className = `status ${type}`;
}

chrome.storage.sync.get(['autoTranslate', 'targetLang'], (settings) => {
  if (settings.targetLang) langSelect.value = settings.targetLang;
  if (settings.autoTranslate) autoToggle.checked = settings.autoTranslate;
});

langSelect.addEventListener('change', () => {
  chrome.storage.sync.set({ targetLang: langSelect.value });
});

autoToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ autoTranslate: autoToggle.checked });
  if (autoToggle.checked) {
    setStatus('자동 번역 켜짐 - 다음 페이지부터 적용', 'active');
  } else {
    setStatus('자동 번역 꺼짐');
  }
});

translateBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  setStatus('번역 중...', 'loading');
  translateBtn.disabled = true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch {}

  chrome.tabs.sendMessage(tab.id, {
    action: 'translate',
    lang: langSelect.value
  }, (response) => {
    translateBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus('번역 실패: 페이지를 새로고침 해주세요');
      return;
    }
    if (response?.success) {
      setStatus('번역 완료', 'active');
    }
  });
});

restoreBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.tabs.sendMessage(tab.id, { action: 'restore' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.success) {
      setStatus('원문으로 복원됨');
    }
  });
});
