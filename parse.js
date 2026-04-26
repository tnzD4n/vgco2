const fs   = require('fs');
const path = require('path');

const PDF_PATH = path.join(__dirname, 'database.pdf');
const OUT_JS   = path.join(__dirname, 'data.js');
const OUT_JSON = path.join(__dirname, 'data.json');
const PDFJS    = path.join(
  __dirname, 'node_modules/pdf-parse/lib/pdf.js/v2.0.550/build/pdf.js'
);

if (!fs.existsSync(PDF_PATH)) {
  console.error('❌ Errore: database.pdf non trovato nella root del progetto.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
async function run() {
  const pdfjsLib = require(PDFJS);
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  const buffer = fs.readFileSync(PDF_PATH);
  const doc    = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0
  }).promise;

  console.log(`✓ Aperto PDF: ${doc.numPages} pagine`);

  const allLines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page  = await doc.getPage(p);
    const lines = await processPage(page, p);
    allLines.push(...lines);
  }

  const entries = parseQAPairs(allLines);

  const jsonStr = JSON.stringify(entries, null, 2);
  fs.writeFileSync(OUT_JSON, jsonStr, 'utf-8');
  fs.writeFileSync(OUT_JS, `window.KB_DATA = ${jsonStr};\n`, 'utf-8');

  console.log(`✓ Estratte ${entries.length} coppie domanda/risposta → data.js & data.json`);

  if (entries.length === 0) {
    console.warn('⚠️  Nessuna coppia trovata. Verifica che le risposte corrette siano evidenziate con Highlight annotation nel PDF.');
  } else {
    console.log(`   Esempio: "${entries[0].question.substring(0,60)}" → "${entries[0].answer}"`);
  }
}

// ---------------------------------------------------------------------------
// Per-page processing: returns lines sorted top-to-bottom, each line
// contains { y, text, isCorrect, page }
// ---------------------------------------------------------------------------
async function processPage(page, pageNum) {
  const [annotations, textContent] = await Promise.all([
    page.getAnnotations(),
    page.getTextContent()
  ]);

  // Highlight annotations (annotationType=9 or subtype='Highlight') mark correct answers.
  // Their rect = [x1, y1, x2, y2] in PDF user space (same as textContent transform).
  const highlights = annotations
    .filter(ann => ann.annotationType === 9 || ann.subtype === 'Highlight')
    .map(ann => ({
      y1: Math.min(ann.rect[1], ann.rect[3]),
      y2: Math.max(ann.rect[1], ann.rect[3])
    }));

  // Build raw text items with position and correctness flag
  const rawItems = textContent.items
    .filter(t => t.str.trim().length > 0)
    .map(t => ({
      str: t.str,
      x:   t.transform[4],
      y:   t.transform[5],   // baseline Y in PDF user space
      isCorrect: highlights.some(h => t.transform[5] >= h.y1 - 4 && t.transform[5] <= h.y2 + 4)
    }));

  // Group items that share the same baseline Y into "lines"
  const lineMap = new Map();
  for (const item of rawItems) {
    const key = Math.round(item.y * 2) / 2; // round to 0.5-pt grid
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push(item);
  }

  const lines = [];
  for (const [y, items] of lineMap) {
    items.sort((a, b) => a.x - b.x);
    const text      = items.map(i => i.str).join('').trim();
    const isCorrect = items.some(i => i.isCorrect);
    if (text) lines.push({ y: parseFloat(y), text, isCorrect, page: pageNum });
  }

  // Sort descending Y → top-to-bottom reading order
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

// ---------------------------------------------------------------------------
// Parse Q&A pairs.
// eCampus format: "NN.  Question text" then 4 answer lines, one highlighted.
// ---------------------------------------------------------------------------
function parseQAPairs(allLines) {
  const entries     = [];
  const qPattern    = /^(\d{1,3}[\.\)])\s{1,15}(.+)/;
  const skipPattern = /eCampus|Data Stampa|Lezione \d+|Docente:|© 2016|Set Domande|SCIENZE BIOLOGICHE|CHIMICA ORGANICA|Indice Lezioni/i;

  let id           = 1;
  let currentQ     = null;
  let currentPage  = null;
  let answers      = []; // { text, isCorrect }

  function commit() {
    if (!currentQ) return;
    const correct = answers.find(a => a.isCorrect);
    if (correct) {
      entries.push({
        id:       id++,
        question: currentQ.trim(),
        answer:   correct.text.trim(),
        page:     currentPage
      });
    }
    currentQ    = null;
    answers     = [];
  }

  for (const line of allLines) {
    if (skipPattern.test(line.text)) continue;

    const match = line.text.match(qPattern);
    if (match) {
      commit();
      currentQ    = match[2].trim();
      currentPage = line.page;
      answers     = [];
    } else if (currentQ !== null) {
      answers.push({ text: line.text, isCorrect: line.isCorrect });
    }
  }
  commit();

  return entries;
}

// ---------------------------------------------------------------------------
run().catch(err => {
  console.error('❌ Errore:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
