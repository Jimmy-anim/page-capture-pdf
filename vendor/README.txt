Third-party OCR components (all run locally inside the extension, nothing is downloaded):
  tesseract.min.js, worker.min.js   tesseract.js 5.1.1 (Apache-2.0)
  core/*.wasm.js                    tesseract.js-core 5.x, Tesseract compiled to WebAssembly (Apache-2.0)
  lang/eng.traineddata.gz           Tesseract "best" English model, integer version (Apache-2.0)

Add a language: put <code>.traineddata.gz (e.g. deu, fra, chi_sim, jpn) into lang/. Get them from
  https://github.com/tesseract-ocr/tessdata_best  (gzip the .traineddata file), or
  npm i @tesseract.js-data/<code>  and copy 4.0.0_best_int/<code>.traineddata.gz
Then type the code in the export page, e.g.  eng+chi_sim
