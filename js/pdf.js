// Haalt leesbare alinea's uit een PDF (voor recente, nog "onopgemaakte" stukken
// waarvan alleen een PDF bestaat). Werkt met pdf.js; de bibliotheek wordt
// meegegeven zodat dit zowel in de browser als in Node getest kan worden.

export async function pdfToParagraphs(data, pdfjsLib) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Groepeer tekstfragmenten per regel (zelfde y-positie).
    const lines = [];
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const y = Math.round(it.transform[5]);
      const x = it.transform[4];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      let line = lines.find((l) => Math.abs(l.y - y) <= 2);
      if (!line) { line = { y, h, parts: [] }; lines.push(line); }
      line.parts.push({ x, s: it.str, eol: it.hasEOL });
      line.h = Math.max(line.h, h);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      l.x = l.parts[0]?.x ?? 0;
      l.text = l.parts.map((p) => p.s).join("").replace(/\s+/g, " ").trim();
    }
    pages.push(lines.filter((l) => l.text));
  }
  await doc.destroy();

  // Kop- en voetregels die op veel pagina's terugkomen weglaten.
  const freq = new Map();
  for (const lines of pages) {
    const seen = new Set();
    for (const l of [...lines.slice(0, 3), ...lines.slice(-3)]) {
      const key = l.text.replace(/\d+/g, "#");
      if (!seen.has(key)) { seen.add(key); freq.set(key, (freq.get(key) || 0) + 1); }
    }
  }
  const repeated = (t) => pages.length > 2 && (freq.get(t.replace(/\d+/g, "#")) || 0) >= Math.max(3, pages.length * 0.4);

  // Regels samenvoegen tot alinea's: nieuwe alinea bij een grotere witregel.
  const paras = [];
  for (const lines of pages) {
    let cur = "", prev = null;
    for (const l of lines) {
      if (repeated(l.text) || /^\d{1,3}$/.test(l.text)) continue;
      const gap = prev ? prev.y - l.y : 0;
      const newPara = prev && gap > Math.max(prev.h, l.h) * 1.6;
      if (newPara && cur) { paras.push(cur); cur = ""; }
      cur = cur ? (cur.endsWith("-") && /^[a-z]/.test(l.text) ? cur.slice(0, -1) + l.text : cur + " " + l.text) : l.text;
      prev = l;
    }
    if (cur) paras.push(cur);
  }
  // Alinea's die over een paginagrens doorlopen weer aan elkaar plakken.
  const merged = [];
  for (const p of paras) {
    const last = merged[merged.length - 1];
    if (last && !/[.:;?!»”)]$/.test(last) && /^[a-z(]/.test(p)) merged[merged.length - 1] = last + " " + p;
    else merged.push(p);
  }
  return merged.map((s) => s.trim()).filter((s) => s.length > 1);
}

// Tekst per pagina, om op te zoeken op welke bladzijde een passage staat.
export async function pdfPageTexts(data, pdfjsLib) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((it) => it.str || "").join(" "));
  }
  await doc.destroy();
  return pages;
}

// Vergelijkbare vorm: alleen letters en cijfers (afbreekstreepjes en
// regelafbrekingen in de PDF tellen dan niet mee).
const squash = (s) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

// Paginanummer (1-based) waarop de tekst begint, of null als hij niet gevonden wordt.
export function findPage(pageTexts, text) {
  const pages = pageTexts.map(squash);
  const t = squash(text);
  if (t.length < 20) return null;
  for (const start of [0, Math.floor(t.length / 3), Math.floor(t.length / 2)]) {
    const needle = t.slice(start, start + 70);
    if (needle.length < 20) continue;
    for (let i = 0; i < pages.length; i++) if (pages[i].includes(needle)) return i + 1;
    // Passage loopt over een paginagrens: zoek in twee pagina's achter elkaar.
    for (let i = 0; i + 1 < pages.length; i++) if ((pages[i] + pages[i + 1]).includes(needle)) return i + 1;
  }
  return null;
}
