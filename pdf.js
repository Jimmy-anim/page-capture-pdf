// Minimal, dependency-free PDF writer.
//  * Every screenshot becomes one page. Pixels are stored losslessly (RGB, Flate with PNG "Up"
//    prediction, which shrinks screenshots a lot), so quality and aspect ratio are preserved.
//  * Optional OCR words are written as an invisible text layer (render mode 3) behind the image,
//    so the PDF is searchable and its text can be selected, highlighted and annotated
//    (Zotero, Acrobat, Preview, browsers...).

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// PNG "Up" filter on every row: out[x] = in[x] - above[x]. Decoded by /Predictor 15.
function upFilter(rgb, w, h) {
  const stride = w * 3;
  const out = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), r = y * stride;
    out[o] = 2;
    if (y === 0) out.set(rgb.subarray(0, stride), o + 1);
    else for (let i = 0; i < stride; i++) out[o + 1 + i] = (rgb[r + i] - rgb[r - stride + i]) & 255;
  }
  return out;
}

async function decodeBlob(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width: w, height: h } = bmp;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = g.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
  }
  return { w, h, rgb };
}

const fmt = n => (Math.round(n * 100) / 100).toString();
const hex4 = n => n.toString(16).padStart(4, '0');
const utf16hex = ch => {
  const cp = ch.codePointAt(0);
  if (cp <= 0xffff) return hex4(cp);
  const v = cp - 0x10000;
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
};

/**
 * @param shots   [{blob, scale}] in page order (scale = image px per CSS px)
 * @param opts    { onProgress(i, n), words: Map<idx, [{text,x0,y0,x1,y1}]> (image px), decode }
 */
export async function buildPdf(shots, opts = {}) {
  const { onProgress = () => {}, words = null, decode = decodeBlob } = opts;
  const enc = new TextEncoder();
  const parts = [];
  const xref = [];
  let offset = 0;
  const push = d => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    parts.push(b);
    offset += b.length;
  };
  const obj = (id, body) => { xref[id] = offset; push(`${id} 0 obj\n`); body(); push('endobj\n'); };

  // Object ids: 1 catalog, 2 page tree, 3-6 text font, then 3 objects per page.
  const FIRST = 7;
  const n = shots.length;
  const cidOf = new Map();           // character -> CID, shared by all pages
  const cid = ch => {
    let c = cidOf.get(ch);
    if (!c && cidOf.size < 65000) { c = cidOf.size + 1; cidOf.set(ch, c); }
    return c;
  };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>\n'));
  const kids = shots.map((_, i) => `${FIRST + i * 3} 0 R`).join(' ');
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\n`));

  for (let i = 0; i < n; i++) {
    const base = FIRST + i * 3;
    const { w, h, rgb } = await decode(shots[i].blob);
    const data = await deflate(upFilter(rgb, w, h));
    // 1 CSS px = 0.75 pt, so the page matches the on-screen size of the captured area.
    const pwN = (w / (shots[i].scale || 1)) * 0.75, phN = (h / (shots[i].scale || 1)) * 0.75;
    const pw = fmt(pwN), ph = fmt(phN);

    let text = '';
    const pageWords = words && words.get(shots[i].idx);
    if (pageWords && pageWords.length) {
      const kx = pwN / w, ky = phN / h;
      text = 'BT\n3 Tr\n';
      for (const wd of pageWords) {
        const chars = [...String(wd.text).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()];
        const widthPt = (wd.x1 - wd.x0) * kx, heightPt = (wd.y1 - wd.y0) * ky;
        if (!chars.length || widthPt <= 0 || heightPt <= 0) continue;
        const codes = chars.map(cid);
        if (codes.some(c => !c)) continue;
        const fs = Math.max(1, heightPt);
        const tz = (widthPt / (chars.length * fs)) * 100;   // every glyph is 1 em wide
        const x = wd.x0 * kx, y = phN - wd.y1 * ky + heightPt * 0.2;
        text += `/F1 ${fmt(fs)} Tf ${fmt(tz)} Tz 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm <${codes.map(hex4).join('')}> Tj\n`;
      }
      text += 'ET\n';
    }
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q\n${text}`;

    obj(base, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${base + 2} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${base + 1} 0 R >>\n`));
    obj(base + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\n`));
    obj(base + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${w} >> /Length ${data.length} >>\nstream\n`);
      push(data);
      push('\nendstream\n');
    });
    onProgress(i + 1, n);
    await new Promise(r => setTimeout(r)); // let the UI repaint
  }

  // Invisible-text font. Written last because the ToUnicode map needs every character used.
  const entries = [...cidOf];
  let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    cmap += `${chunk.length} beginbfchar\n` + chunk.map(([ch, c]) => `<${hex4(c)}> <${utf16hex(ch)}>`).join('\n') + '\nendbfchar\n';
  }
  cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  if (!entries.length) cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap endcmap end end\n';

  obj(3, () => push('<< /Type /Font /Subtype /Type0 /BaseFont /InvisibleText /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>\n'));
  obj(4, () => push('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /InvisibleText /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 /CIDToGIDMap /Identity >>\n'));
  obj(5, () => push('<< /Type /FontDescriptor /FontName /InvisibleText /Flags 32 /FontBBox [0 -250 1000 750] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 750 /StemV 80 >>\n'));
  obj(6, () => push(`<< /Length ${enc.encode(cmap).length} >>\nstream\n${cmap}endstream\n`));

  const size = FIRST + n * 3;
  const xrefPos = offset;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) x += String(xref[id]).padStart(10, '0') + ' 00000 n \n';
  push(`${x}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
