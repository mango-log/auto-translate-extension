let worker = null;
let workerLangs = '';
let queue = Promise.resolve();

async function getWorker(langs) {
  if (worker && workerLangs === langs) return worker;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  worker = await Tesseract.createWorker(langs, 1, {
    workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/tesseract-core-simd-lstm.wasm.js'),
    langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    workerBlobURL: false
  });
  workerLangs = langs;
  return worker;
}

function flattenLines(blocks) {
  const lines = [];
  for (const block of blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = (line.text || '').trim();
        if (!text || text.length < 2) continue;
        if (line.confidence < 40) continue;
        if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) continue;
        lines.push({ text, bbox: line.bbox, confidence: line.confidence });
      }
    }
  }
  return lines;
}

async function ocrImage(dataUrl, langs) {
  const w = await getWorker(langs);
  const result = await w.recognize(dataUrl, {}, { blocks: true });
  return flattenLines(result.data.blocks);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.action !== 'ocr') return;

  queue = queue.then(async () => {
    try {
      const lines = await ocrImage(message.dataUrl, message.langs);
      sendResponse({ ok: true, lines });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  });
  return true;
});
