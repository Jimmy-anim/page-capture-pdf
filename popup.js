import { DEFAULT_SETTINGS, DEFAULT_STATE } from './shared.js';
import { getLastShot } from './db.js';

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: e.message }));
const LABELS = { idle: 'Ready', running: 'Capturing', paused: 'Paused', done: 'Finished', stopped: 'Stopped', error: 'Error' };

let settings = { ...DEFAULT_SETTINGS };
let state = { ...DEFAULT_STATE };
let rect = null;
let thumbCount = -1;
let thumbUrl = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function clamp(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readSettings() {
  return {
    ...settings,
    nav: $('nav').value,
    selector: $('selector').value.trim(),
    delay: clamp($('delay').value, 0, 60000, DEFAULT_SETTINGS.delay),
    maxWait: clamp($('maxWait').value, 500, 120000, DEFAULT_SETTINGS.maxWait),
    retries: clamp($('retries').value, 0, 10, DEFAULT_SETTINGS.retries),
    maxPages: clamp($('maxPages').value, 1, 5000, DEFAULT_SETTINGS.maxPages),
    sensitivity: clamp($('sensitivity').value, 0.01, 50, DEFAULT_SETTINGS.sensitivity),
    captureScale: clamp($('captureScale').value, 1, 4, DEFAULT_SETTINGS.captureScale),
    autoDetect: $('autoDetect').checked,
    trustedKeys: $('trusted').checked,
    filename: $('filename').value.trim()
  };
}

function render() {
  const focused = document.activeElement;
  const set = (id, v) => { if (focused !== $(id)) $(id).value = v; };

  set('nav', settings.nav);
  set('selector', settings.selector);
  set('delay', settings.delay);
  set('maxWait', settings.maxWait);
  set('maxPages', settings.maxPages);
  set('retries', settings.retries);
  set('sensitivity', settings.sensitivity);
  set('captureScale', settings.captureScale);
  set('filename', settings.filename);
  $('autoDetect').checked = settings.autoDetect;
  $('trusted').checked = settings.trustedKeys;
  $('selectorRow').hidden = settings.nav !== 'button';
  $('trustedRow').hidden = settings.nav === 'button';

  const manual = rect && !rect.auto;
  for (const k of ['x', 'y', 'w', 'h']) {
    set(k, manual ? Math.round(rect[k]) : '');
    $(k).disabled = !manual;
  }
  $('showArea').disabled = !manual;
  $('autoArea').disabled = !manual;
  $('areaInfo').textContent = manual
    ? `Area: ${Math.round(rect.w)} × ${Math.round(rect.h)} px, saved until you change it. “Auto” goes back to automatic detection.`
    : 'Automatic: the page is detected and cropped on every capture. Or click “Select area on page” to choose one yourself.';

  const running = state.status === 'running';
  const paused = state.status === 'paused';
  $('count').textContent = state.count;
  $('status').textContent = LABELS[state.status] || state.status;
  $('status').className = 'pill ' + state.status;
  $('message').textContent = state.message || 'Ready to capture.';
  $('bar').classList.toggle('active', running);

  $('start').hidden = running || paused;
  $('start').disabled = false;
  $('pause').hidden = !running;
  $('resume').hidden = !paused;
  $('stop').hidden = !(running || paused);
  $('makePdf').disabled = state.count === 0 || running;
  $('reset').disabled = running || (state.count === 0 && state.status === 'idle');

  updateThumb();
}

async function updateThumb() {
  if (state.count === thumbCount) return;
  thumbCount = state.count;
  if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = null; }
  if (!state.count) { $('thumb').hidden = true; return; }
  const last = await getLastShot();
  if (!last) { $('thumb').hidden = true; return; }
  thumbUrl = URL.createObjectURL(last.blob);
  $('thumb').src = thumbUrl;
  $('thumb').hidden = false;
}

function showError(text) {
  $('message').textContent = text;
}

async function persistSettings() {
  settings = readSettings();
  await chrome.storage.local.set({ settings });
  render();
}

async function persistRect() {
  if (!rect) return;
  rect = {
    ...rect,
    x: clamp($('x').value, 0, rect.vw - 1, rect.x),
    y: clamp($('y').value, 0, rect.vh - 1, rect.y),
    w: clamp($('w').value, 20, rect.vw, rect.w),
    h: clamp($('h').value, 20, rect.vh, rect.h)
  };
  await chrome.storage.local.set({ rect });
  render();
}

/* ---------- events ---------- */

for (const id of ['nav', 'selector', 'delay', 'maxWait', 'retries', 'maxPages', 'sensitivity', 'filename', 'autoDetect']) {
  $(id).addEventListener('change', persistSettings);
}
for (const id of ['x', 'y', 'w', 'h']) $(id).addEventListener('change', persistRect);

$('captureScale').addEventListener('change', persistSettings);

$('trusted').addEventListener('click', persistSettings);

$('autoArea').addEventListener('click', async () => { await chrome.storage.local.remove('rect'); });

$('selectArea').addEventListener('click', async () => {
  const tab = await activeTab();
  const r = await send({ type: 'selectArea', tabId: tab.id });
  if (!r.ok) return showError(r.error);
  window.close();
});

$('showArea').addEventListener('click', async () => {
  const tab = await activeTab();
  const r = await send({ type: 'showArea', tabId: tab.id });
  if (!r.ok) showError(r.error);
});

$('pickBtn').addEventListener('click', async () => {
  const tab = await activeTab();
  const r = await send({ type: 'pickButton', tabId: tab.id });
  if (!r.ok) return showError(r.error);
  window.close();
});

$('start').addEventListener('click', async () => {
  await persistSettings();
  const tab = await activeTab();
  const r = await send({ type: 'start', tabId: tab.id, windowId: tab.windowId });
  if (!r.ok) showError(r.error);
});

$('pause').addEventListener('click', () => send({ type: 'pause' }));
$('resume').addEventListener('click', async () => {
  const tab = await activeTab();
  const r = await send({ type: 'resume', tabId: tab.id, windowId: tab.windowId });
  if (!r.ok) showError(r.error);
});
$('stop').addEventListener('click', () => send({ type: 'stop' }));
$('makePdf').addEventListener('click', async () => { await send({ type: 'openPdf' }); window.close(); });
$('reset').addEventListener('click', async () => {
  if (confirm('Discard all captured pages?')) await send({ type: 'reset' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  if (changes.state) state = { ...DEFAULT_STATE, ...changes.state.newValue };
  if (changes.rect) rect = changes.rect.newValue || null;
  render();
});

(async function init() {
  const d = await chrome.storage.local.get(['settings', 'state', 'rect']);
  settings = { ...DEFAULT_SETTINGS, ...d.settings };
  state = { ...DEFAULT_STATE, ...d.state };
  rect = d.rect || null;
  render();
})();
