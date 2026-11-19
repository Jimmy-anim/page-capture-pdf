// Defaults and constants shared by the background worker, popup and export page.

export const DEFAULT_SETTINGS = {
  nav: "ArrowRight", // 'ArrowRight' | 'PageDown' | 'button'
  selector: "", // CSS selector of the next-page button (nav === 'button')
  delay: 1000, // ms to wait after navigating before looking for changes
  maxWait: 2000, // ms to wait for the page to change before retrying / assuming last page
  retries: 1, // times to re-send the page turn before deciding it's the last page
  maxPages: 500, // safety limit
  sensitivity: 0.05, // % of the area that must change to count as a new page
  captureScale: 1, // 1-4: pixels per CSS pixel. >1 re-renders the page at higher density (debugger permission)
  autoDetect: true, // crop each capture to the page edges (pdf.js DOM, Scanic, then image analysis)
  trustedKeys: false, // send real key events through the debugger API (optional permission)
  ocr: true, // add an invisible, searchable text layer when exporting
  ocrLang: "eng", // Tesseract language code(s), e.g. 'eng' or 'eng+deu'
  v: 3,
  filename: "", // PDF file name (without extension)
};

export const DEFAULT_STATE = {
  status: "idle", // idle | running | paused | done | stopped | error
  count: 0,
  phase: "needNav", // needNav | waiting
  message: "",
  tabId: null,
  windowId: null,
};

export const KEYS = {
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
};
