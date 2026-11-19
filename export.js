import { listShots, deleteShot } from './db.js';
import { buildPdf } from './pdf.js';
import { ocrPages } from './ocr.js';

const $ = id => document.getElementById(id);
let shots = [];
let urls = [];
let building = false;
let pdfUrl = null;
let abort = null;
const ocrCache = new Map();   // shot idx -> words (so re-downloading doesn't repeat OCR)

function defaultName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `capture-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function refresh() {
  urls.forEach(u => URL.revokeObjectURL(u));
  urls = [];
  shots = (await listShots()).sort((a, b) => a.idx - b.idx);
  $('summary').textContent = shots.length
    ? `${shots.length} page${shots.length === 1 ? '' : 's'}, in capture order. Remove any you don't want, then download.`
    : 'No pages captured yet.';
  $('download').disabled = shots.length === 0 || building;

  const grid = $('grid');
  grid.replaceChildren();
  shots.forEach((s, i) => {
    const url = URL.createObjectURL(s.blob);
    urls.push(url);
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = url; img.loading = 'lazy'; img.alt = `Page ${i + 1}`;
    const cap = document.createElement('figcaption');
    const label = document.createElement('span');
    label.textContent = `Page ${i + 1}`;
    const del = document.createElement('button');
    del.className = 'ghost'; del.textContent = 'Remove';
    del.onclick = async () => {
      await deleteShot(s.idx);
      const { state } = await chrome.storage.local.get('state');
      if (state) await chrome.storage.local.set({ state: { ...state, count: Math.max(0, (state.count || 1) - 1) } });
      refresh();
    };
    cap.append(label, del);
    fig.append(img, cap);
    grid.append(fig);
  });
}

$('cancel').addEventListener('click', () => abort && abort.abort());

$('download').addEventListener('click', async () => {
  building = true;
  abort = new AbortController();
  $('download').disabled = true;
  $('cancel').hidden = false;
  $('progress').hidden = false;
  const bar = $('progress').firstElementChild;
  const useOcr = $('ocr').checked;
  const lang = $('ocrLang').value.trim() || 'eng';
  try {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ocr: useOcr, ocrLang: lang } });

    let words = null;
    if (useOcr) {
      const todo = shots.filter(s => !ocrCache.has(`${lang}:${s.idx}`));
      if (todo.length) {
        $('status').textContent = 'Starting the OCR engine…';
        const res = await ocrPages(todo, {
          lang,
          signal: abort.signal,
          onProgress: (i, n) => {
            bar.style.width = `${(i / n) * 50}%`;
            $('status').textContent = `Recognizing text: page ${i} of ${n}…`;
          }
        });
        for (const [idx, list] of res) ocrCache.set(`${lang}:${idx}`, list);
      }
      words = new Map(shots.map(s => [s.idx, ocrCache.get(`${lang}:${s.idx}`)]));
    }

    const base = useOcr ? 50 : 0, span = useOcr ? 50 : 100;
    const blob = await buildPdf(shots, {
      words,
      onProgress: (i, n) => {
        bar.style.width = `${base + (i / n) * span}%`;
        $('status').textContent = `Building PDF: page ${i} of ${n}…`;
      }
    });
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(blob);
    const name = ($('filename').value.trim() || defaultName()).replace(/[\\/:*?"<>|]+/g, '_');
    const a = document.createElement('a');
    a.href = pdfUrl; a.download = `${name}.pdf`;
    document.body.append(a); a.click(); a.remove();
    const mb = (blob.size / 1048576).toFixed(1);
    const nWords = words ? [...words.values()].reduce((t, l) => t + (l ? l.length : 0), 0) : 0;
    $('status').textContent = `PDF ready (${shots.length} pages, ${mb} MB${useOcr ? `, ${nWords} words recognized` : ''}). If the download didn't start, `;
    const link = document.createElement('a');
    link.href = pdfUrl; link.download = `${name}.pdf`; link.textContent = 'click here';
    $('status').append(link, '.');
  } catch (e) {
    console.error(e);
    $('status').textContent = e.message === 'Cancelled.' ? 'Cancelled.' : `Could not build the PDF: ${e.message}`;
  } finally {
    building = false;
    abort = null;
    $('cancel').hidden = true;
    $('download').disabled = shots.length === 0;
  }
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.state && !building) refresh();
});

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  $('filename').value = (settings && settings.filename) || defaultName();
  $('ocr').checked = !settings || settings.ocr !== false;
  $('ocrLang').value = (settings && settings.ocrLang) || 'eng';
  refresh();
})();
