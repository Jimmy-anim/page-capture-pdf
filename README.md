# Page Capture to PDF (Chrome and Edge, Manifest V3)

Select an area of a page, let the extension screenshot it, turn the page, and repeat until the
last page. Everything is combined into one PDF with selectable, searchable text. All processing
happens on your computer: no servers, no analytics, no network requests.

## Install
**Chrome:** unzip, open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, choose the
`page-capture-pdf` folder (the one containing `manifest.json`).
**Edge:** same at `edge://extensions`.
After updating the files, press the reload icon on the extension card.

## Use
1. Open the document and go to the first page. Keep the window size fixed.
2. Optional: click **Select area on page** and drag a rectangle. If you select nothing, the whole
   visible page is searched and each capture is cropped to the page automatically (press **Auto** to
   go back to this mode). With an area selected, choose a generous one *around* the page and keep
   "Crop to the page edges" on to trim it.
3. Choose how to turn pages (Right Arrow, Page Down, or a Next-page button via **Pick**).
4. Choose **Capture resolution** (default 3x). Click **Start capture**. 
5. Pause / Resume / Stop any time. When finished, a tab opens where you can review pages, remove
   any, and **Download PDF**.

## Sharper images (Capture resolution)
A normal screenshot is limited to your screen's pixel density, and stretching it adds no detail.
At 2x-4x the browser renders the selected region at that scale for the moment of the screenshot
(your page is not zoomed or changed), so text and vector content are genuinely sharper. Bitmap
content, such as the canvas of a pdf.js viewer, can only be as sharp as the viewer drew it; for those,
zoom the viewer in so the page fills the window. This uses the browser's "debugger" permission (Chrome
does not allow it to be optional), so the browser lists it at install and shows a "debugging this tab"
bar while capturing. Higher resolution means larger files (screenshots are stored losslessly).

## Automatic page boundary
Once per captured page (so sizes stay consistent), the extension crops to the page:
1. pdf.js viewers: the page element's exact position is read from the document.
2. Other snapshots: Scanic detects the largest credible document boundary and extracts its crop,
   correcting perspective when the page is tilted.
3. If Scanic cannot confidently find a page, the existing image analysis looks for the rectangle of
   "paper" colour (white, cream or dark-mode pages, light or dark viewer backgrounds). It verifies
   that flat viewer background lies just outside each edge, so it never stops half-way through a
   page. If neither detector is sure (for example a full-width photo or banner), or the area is
   already the page, nothing is cropped.
Switch it off with the checkbox if you want exactly the area you selected.
Scanic 1.8.0 runs locally from the bundled `vendor/scanic.js` library; its MIT license is in
`vendor/LICENSE-scanic.txt`.

## Searchable, highlightable text (OCR)
On the export page, "Make text selectable and searchable" is on by default. Tesseract OCR runs
locally (WebAssembly, bundled in `vendor/`) and writes an invisible text layer behind each page
image, so you can select, search, highlight and annotate in Zotero, Acrobat, browsers, etc.
The original image is untouched. OCR takes a few seconds per page; results are cached while the
export tab stays open.
* English is included. Other languages: see `vendor/README.txt`, then type e.g. `eng+deu`.
* OCR accuracy depends on resolution: use 2x or 3x for small text.

## Notes
* Keep the captured tab in the foreground, window visible and not minimized.
* Browsers allow about 2 standard screenshots per second; high-resolution capture is similar.
* If a viewer ignores script-generated key presses, tick **Use trusted key events** or use a Next button.
* Can't capture browser pages (`chrome://`, `edge://`) or the Web Store.
* Pages stay in local browser storage until you press **Discard pages**.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Capture loop, high-res capture, change detection, navigation |
| `detect.js` | Scanic document detection and color-analysis fallback |
| `injected.js` | Code injected into the page: selectors, key/click, pdf.js page lookup |
| `popup.*`, `ui.css` | Toolbar popup |
| `export.*` | Review pages, OCR options, download PDF |
| `ocr.js`, `vendor/` | Local Tesseract OCR, its model, and Scanic |
| `pdf.js` | Dependency-free PDF writer with invisible text layer |
| `db.js`, `shared.js` | Local storage, shared defaults |
