// Scanic handles general document boundaries; the color-based detector remains as a fallback for
// flat, uniform pages that Scanic cannot confidently identify.

import { scanDocument } from "./vendor/scanic.js";

// Scanic returns its strongest document contour and its perspective-corrected crop.
export async function detectScanicCrop(source) {
  const result = await scanDocument(source, {
    detector: "classical",
    mode: "extract",
    output: "canvas",
    maxProcessingDimension: 1000,
    minDetectionConfidence: 0.5,
    minDocumentCoverageRatio: 0.04,
    maxCandidateContours: 12,
  });
  if (!result.success || !result.corners || !result.output) return null;

  const points = [
    result.corners.topLeft,
    result.corners.topRight,
    result.corners.bottomRight,
    result.corners.bottomLeft,
  ];
  if (
    points.some(
      (p) =>
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.y < 0 ||
        p.x > source.width ||
        p.y > source.height,
    )
  )
    return null;

  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(twiceArea) / 2 < source.width * source.height * 0.04)
    return null;

  const minX = Math.min(...points.map((p) => p.x)),
    maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y)),
    maxY = Math.max(...points.map((p) => p.y));
  const crop = result.output;
  if (
    crop.width < 1 ||
    crop.height < 1 ||
    (maxX - minX >= source.width * 0.985 &&
      maxY - minY >= source.height * 0.985)
  )
    return null;
  return crop;
}

const TOL = 30; // max summed RGB distance for "same colour"
const THR = 0.3; // fraction of matching pixels a row/column needs to count as page

export function detectPageRect(d, w, h) {
  if (w < 40 || h < 40) return null;

  // Frequent colours (32 levels per channel), with their mean colour.
  const bins = new Map();
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    let b = bins.get(k);
    if (!b) {
      b = [0, 0, 0, 0];
      bins.set(k, b);
    }
    b[0]++;
    b[1] += d[i];
    b[2] += d[i + 1];
    b[3] += d[i + 2];
  }
  const candidates = [...bins.values()]
    .filter((b) => b[0] >= w * h * 0.03)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 5)
    .map((b) => [b[1] / b[0], b[2] / b[0], b[3] / b[0]]);

  let best = null;
  for (const c of candidates) {
    const box = growFromCentre(d, w, h, c);
    if (box && (!best || box.w * box.h > best.w * best.h)) best = box;
  }
  if (!best) return null;
  if (best.w * best.h < w * h * 0.12) return null; // implausibly small
  if (best.w >= w * 0.985 && best.h >= h * 0.985) return null; // already the whole area
  return best;
}

function growFromCentre(d, w, h, [pr, pg, pb]) {
  const mask = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    mask[p] =
      Math.abs(d[i] - pr) + Math.abs(d[i + 1] - pg) + Math.abs(d[i + 2] - pb) <=
      TOL
        ? 1
        : 0;
  }

  // Column profile: best of four horizontal bands, so a tall figure cannot hide the page.
  const colFrac = new Float32Array(w);
  for (const [fa, fb] of [
    [0.2, 0.35],
    [0.35, 0.5],
    [0.5, 0.65],
    [0.65, 0.8],
  ]) {
    const ya = (h * fa) | 0,
      yb = Math.max(ya + 1, (h * fb) | 0);
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let y = ya; y < yb; y++) n += mask[y * w + x];
      colFrac[x] = Math.max(colFrac[x], n / (yb - ya));
    }
  }
  const cx = argmaxRange(colFrac, (w * 0.35) | 0, (w * 0.65) | 0);
  if (colFrac[cx] < 0.5) return null;
  const [left, right] = grow(
    colFrac,
    cx,
    THR,
    Math.max(2, Math.round(w * 0.01)),
  );

  // Row profile measured on the page's side margins (blank beside any figure or text).
  const pageW = right - left + 1;
  const m0 = Math.max(1, Math.round(pageW * 0.02)),
    m1 = Math.max(m0 + 1, Math.round(pageW * 0.07));
  const rowFrac = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0,
      t = 0;
    for (let x = left + m0; x < left + m1; x++) {
      n += mask[y * w + x];
      t++;
    }
    for (let x = right - m1; x < right - m0; x++) {
      n += mask[y * w + x];
      t++;
    }
    rowFrac[y] = n / t;
  }
  const cy = argmaxRange(rowFrac, (h * 0.35) | 0, (h * 0.65) | 0);
  if (rowFrac[cy] < 0.5) return null;
  const [top, bottom] = grow(
    rowFrac,
    cy,
    THR,
    Math.max(3, Math.round(h * 0.02)),
  );

  const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  return edgesLookLikeBackground(d, w, h, box, [pr, pg, pb]) ? box : null;
}

// A real page edge has flat viewer background just outside it, in the same colour as the outer
// border of the capture. If the strip next to a side is paper-coloured, textured (photo, text), or a
// different flat colour (e.g. a banner across the page), the box stopped inside the page.
function edgesLookLikeBackground(d, w, h, box, paper) {
  const [pr, pg, pb] = paper;
  const mean = (xa, xb, ya, yb) => {
    let n = 0,
      r = 0,
      g = 0,
      b = 0;
    for (let y = ya; y < yb; y++)
      for (let x = xa; x < xb; x++) {
        const i = (y * w + x) * 4;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
    return n ? [r / n, g / n, b / n] : null;
  };
  const dist = (a, b) =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

  // Viewer background colours: the outer 3px of each border, ignoring borders that are page.
  const borders = [
    mean(0, 3, 0, h),
    mean(w - 3, w, 0, h),
    mean(0, w, 0, 3),
    mean(0, w, h - 3, h),
  ].filter((c) => c && dist(c, paper) > TOL);

  const GAP = 10,
    DEPTH = 8;
  const sides = [
    [
      box.x - GAP - DEPTH,
      box.x - GAP,
      box.y + box.h * 0.1,
      box.y + box.h * 0.9,
    ],
    [
      box.x + box.w + GAP,
      box.x + box.w + GAP + DEPTH,
      box.y + box.h * 0.1,
      box.y + box.h * 0.9,
    ],
    [
      box.x + box.w * 0.1,
      box.x + box.w * 0.9,
      box.y - GAP - DEPTH,
      box.y - GAP,
    ],
    [
      box.x + box.w * 0.1,
      box.x + box.w * 0.9,
      box.y + box.h + GAP,
      box.y + box.h + GAP + DEPTH,
    ],
  ];
  for (const [xa, xb, ya, yb] of sides) {
    const x0 = Math.round(xa),
      x1 = Math.round(xb),
      y0 = Math.round(ya),
      y1 = Math.round(yb);
    if (x0 < 0 || y0 < 0 || x1 > w || y1 > h || x1 <= x0 || y1 <= y0) continue; // at the image border: fine
    const m = mean(x0, x1, y0, y1);
    if (dist(m, paper) <= TOL) return false; // still paper
    let flat = 0,
      n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (
          Math.abs(d[i] - m[0]) +
            Math.abs(d[i + 1] - m[1]) +
            Math.abs(d[i + 2] - m[2]) <=
          TOL * 1.3
        )
          flat++;
        n++;
      }
    if (flat / n < 0.8) return false; // textured
    if (borders.length && !borders.some((c) => dist(c, m) <= TOL * 1.5))
      return false; // not the viewer background
  }
  return true;
}

function argmaxRange(a, lo, hi) {
  let best = lo;
  for (let i = lo; i < hi; i++) if (a[i] > a[best]) best = i;
  return best;
}

// Expand from `start` in both directions while values stay >= thr (tolerating short dips).
function grow(a, start, thr, maxGap) {
  let lo = start,
    gap = 0;
  for (let i = start; i >= 0; i--) {
    if (a[i] >= thr) {
      lo = i;
      gap = 0;
    } else if (++gap > maxGap) break;
  }
  let hi = start;
  gap = 0;
  for (let i = start; i < a.length; i++) {
    if (a[i] >= thr) {
      hi = i;
      gap = 0;
    } else if (++gap > maxGap) break;
  }
  return [lo, hi];
}
