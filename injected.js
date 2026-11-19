// Functions injected into the web page with chrome.scripting.executeScript({ func }).
// Each one MUST be fully self-contained (no references to anything outside its body).

export function pcSelectArea() {
  document.getElementById('__pc_overlay')?.remove();

  const ov = document.createElement('div');
  ov.id = '__pc_overlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.35);user-select:none;';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;display:none;box-sizing:border-box;pointer-events:none;border:2px dashed #fff;outline:1px solid #0f766e;background:rgba(15,118,110,.2);';
  const tip = document.createElement('div');
  tip.textContent = 'Drag to select the capture area. Press Esc to cancel.';
  tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#1c1f24;color:#fff;font:13px system-ui,sans-serif;pointer-events:none;';
  ov.append(box, tip);
  document.documentElement.append(ov);

  const toast = text => {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 16px;border-radius:8px;background:#0f766e;color:#fff;font:13px system-ui,sans-serif;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3);';
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 3500);
  };

  let sx = 0, sy = 0, dragging = false;
  const geom = e => ({
    x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY),
    w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy)
  });
  const paint = e => {
    const g = geom(e);
    box.style.left = g.x + 'px'; box.style.top = g.y + 'px';
    box.style.width = g.w + 'px'; box.style.height = g.h + 'px';
  };
  const cleanup = () => { ov.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = e => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); cleanup();
      chrome.runtime.sendMessage({ type: 'selectionCancelled' });
    }
  };

  ov.addEventListener('mousedown', e => {
    e.preventDefault(); dragging = true; sx = e.clientX; sy = e.clientY;
    box.style.display = 'block'; paint(e);
  });
  ov.addEventListener('mousemove', e => { if (dragging) paint(e); });
  ov.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    const g = geom(e);
    cleanup();
    if (g.w < 20 || g.h < 20) { toast('Selection too small. Try again.'); return; }
    const rect = { x: g.x, y: g.y, w: g.w, h: g.h, vw: window.innerWidth, vh: window.innerHeight };
    chrome.runtime.sendMessage({ type: 'areaSelected', rect });
    toast(`Area saved (${Math.round(g.w)} × ${Math.round(g.h)}). Click the extension icon to start.`);
  });
  window.addEventListener('keydown', onKey, true);
}

export function pcShowArea(rect) {
  const b = document.createElement('div');
  b.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;box-sizing:border-box;border:2px dashed #0f766e;background:rgba(15,118,110,.15);z-index:2147483647;pointer-events:none;`;
  document.documentElement.append(b);
  setTimeout(() => b.remove(), 2000);
}

export function pcPickElement() {
  const hl = document.createElement('div');
  hl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #f59e0b;background:rgba(245,158,11,.25);display:none;';
  const tip = document.createElement('div');
  tip.textContent = 'Click the Next-page button. Press Esc to cancel.';
  tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:8px;background:#1c1f24;color:#fff;font:13px system-ui,sans-serif;z-index:2147483647;pointer-events:none;';
  document.documentElement.append(hl, tip);

  const cssPath = el => {
    const unique = s => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let part = el.localName;
      if (el.id && unique('#' + CSS.escape(el.id))) { parts.unshift('#' + CSS.escape(el.id)); break; }
      const cls = [...el.classList].filter(c => /^[\w-]+$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.matches(part));
        if (same.length > 1) {
          const sameTag = [...parent.children].filter(c => c.localName === el.localName);
          part += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
        }
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
      el = parent;
    }
    return parts.join(' > ');
  };

  let cur = null;
  const stop = () => {
    hl.remove(); tip.remove();
    document.removeEventListener('mousemove', move, true);
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.removeEventListener(t, block, true);
    document.removeEventListener('keydown', key, true);
  };
  const move = e => {
    cur = e.target;
    const r = cur.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
  };
  const block = e => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (e.type !== 'click' || !cur) return;
    const target = cur.closest('button,a,[role="button"],input[type="button"],[onclick]') || cur;
    const selector = cssPath(target);
    stop();
    chrome.runtime.sendMessage({ type: 'buttonPicked', selector });
  };
  const key = e => {
    if (e.key === 'Escape') { e.preventDefault(); stop(); chrome.runtime.sendMessage({ type: 'selectionCancelled' }); }
  };
  document.addEventListener('mousemove', move, true);
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.addEventListener(t, block, true);
  document.addEventListener('keydown', key, true);
}

export function pcClickButton(selector) {
  let el;
  try { el = document.querySelector(selector); } catch { return { ok: false, reason: 'invalid' }; }
  if (!el) return { ok: false, reason: 'missing' };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')) {
    return { ok: false, reason: 'disabled' };
  }
  el.click();
  return { ok: true };
}

export function pcSyntheticKey(key, code, keyCode) {
  const target = document.activeElement || document.body;
  for (const type of ['keydown', 'keyup']) {
    const ev = new KeyboardEvent(type, {
      key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, view: window
    });
    try {
      Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
      Object.defineProperty(ev, 'which', { get: () => keyCode });
    } catch { /* ignore */ }
    target.dispatchEvent(ev);
  }
}

// Looks for a pdf.js viewer (used by Firefox, many web apps and Zotero-style readers) and returns the
// on-screen box of the page that is most visible, in top-level viewport CSS pixels.
export function pcFindPdfPage() {
  const pages = [...document.querySelectorAll('.pdfViewer .page, #viewer .page[data-page-number], .page[data-page-number]')];
  if (!pages.length) return null;
  let ox = 0, oy = 0, topW = window.innerWidth, topH = window.innerHeight;
  try {
    let w = window;
    while (w !== w.top) {
      const fe = w.frameElement;
      if (!fe) return null;               // cross-origin frame: cannot place it, let image analysis handle it
      const r = fe.getBoundingClientRect();
      ox += r.left + fe.clientLeft; oy += r.top + fe.clientTop;
      w = w.parent;
    }
    topW = w.innerWidth; topH = w.innerHeight;
  } catch { return null; }
  let best = null;
  for (const p of pages) {
    const el = p.querySelector('.canvasWrapper canvas') || p.querySelector('.canvasWrapper') || p.querySelector('canvas') || p;
    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) continue;
    const x = r.left + ox, y = r.top + oy;
    const vis = Math.max(0, Math.min(x + r.width, topW) - Math.max(x, 0)) *
                Math.max(0, Math.min(y + r.height, topH) - Math.max(y, 0));
    if (vis > 0 && (!best || vis > best.vis)) best = { x, y, w: r.width, h: r.height, vis };
  }
  return best;
}
