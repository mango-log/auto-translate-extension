chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    autoTranslate: false,
    targetLang: 'ko'
  });
});
