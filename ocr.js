// Local OCR using Tesseract (WebAssembly) bundled in /vendor. Nothing leaves the computer.
// Requires <script src="vendor/tesseract.min.js"> to be loaded before this module is used.

const base = () => chrome.runtime.getURL('vendor/');

async function prepare(shot) {
  // Small text OCRs poorly; upscale low-resolution captures (high-resolution ones are used as-is).
  const bmp = await createImageBitmap(shot.blob);
  const factor = Math.min(3, Math.max(1, 1800 / bmp.width), 6000 / Math.max(bmp.width, bmp.height));
  if (factor < 1.15) { bmp.close(); return { input: shot.blob, factor: 1 }; }
  const c = new OffscreenCanvas(Math.round(bmp.width * factor), Math.round(bmp.height * factor));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return { input: await c.convertToBlob({ type: 'image/png' }), factor };
}

/**
 * @returns Map<idx, [{text,x0,y0,x1,y1}]> with coordinates in the stored image's pixels.
 */
export async function ocrPages(shots, { lang = 'eng', workers, onProgress = () => {}, signal } = {}) {
  const T = self.Tesseract;
  if (!T) throw new Error('OCR engine not loaded.');
  const count = Math.max(1, Math.min(workers || Math.floor((navigator.hardwareConcurrency || 4) / 2), 4, shots.length));
  const pool = [];
  try {
    for (let i = 0; i < count; i++) {
      pool.push(await T.createWorker(lang, 1, {
        workerPath: base() + 'worker.min.js',
        corePath: base() + 'core/',
        langPath: base() + 'lang/',
        workerBlobURL: false,   // load the worker straight from the extension (blob workers are blocked by CSP)
        gzip: true,
        cacheMethod: 'none',
        logger: () => {}
      }));
    }
    const results = new Map();
    let next = 0, done = 0;
    await Promise.all(pool.map(async worker => {
      for (;;) {
        if (signal && signal.aborted) throw new Error('Cancelled.');
        const i = next++;
        if (i >= shots.length) return;
        const { input, factor } = await prepare(shots[i]);
        const { data } = await worker.recognize(input);
        const list = [];
        for (const w of data.words || []) {
          const text = (w.text || '').trim();
          if (!text || w.confidence < 30) continue;
          list.push({ text, x0: w.bbox.x0 / factor, y0: w.bbox.y0 / factor, x1: w.bbox.x1 / factor, y1: w.bbox.y1 / factor });
        }
        results.set(shots[i].idx, list);
        onProgress(++done, shots.length);
      }
    }));
    return results;
  } finally {
    await Promise.all(pool.map(w => w.terminate().catch(() => {})));
  }
}
