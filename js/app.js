import { search, applySynonyms, normalize, stem, tokenize, variantsOf, STOPWORDS } from "./search.js";
import { pdfToParagraphs, pdfPageTexts, findPage } from "./pdf.js";

// pdf.js wordt pas geladen als er een PDF gelezen moet worden.
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import("../lib/pdfjs/pdf.min.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("../lib/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}
const pdfToText = async (data) => pdfToParagraphs(data, await loadPdfjs());

const $ = (s) => document.querySelector(s);
const els = {
  form: $("#search-form"), q: $("#q"), btn: $("#search-btn"), status: $("#status"),
  termsPanel: $("#terms-panel"), terms: $("#terms"), addTerm: $("#add-term"), newTerm: $("#new-term"), rerun: $("#rerun"),
  results: $("#results"), concept: $("#concept"), selCount: $("#sel-count"), copy: $("#copy-prompt"),
  copyFixed: $("#copy-fixed"), fractie: $("#fractie"), fixed: $("#prompt-fixed"), share: $("#share-settings"),
  template: $("#prompt-template"), savePrompt: $("#save-prompt"), resetPrompt: $("#reset-prompt"), level1: $("#level1"),
  docs: $("#docs"), docCount: $("#doc-count"), docList: $("#doc-list"), toast: $("#toast"),
  subject: $("#subject"), from: $("#from"), to: $("#to"), dossier: $("#dossier"),
  toolbar: $("#toolbar"), sort: $("#sort"), onlyQa: $("#only-qa"), onlyRecent: $("#only-recent"), shown: $("#shown"),
};

const DEFAULT_FIXED = `Je bent een ervaren beleidsmedewerker bij het ministerie van Financiën, Directoraat-Generaal Fiscale Zaken. Je stelt CONCEPTantwoorden op voor Kamervragen. Een medewerker controleert elk antwoord.

Bronnen, in deze volgorde:
- Niveau 1: de passages die in de vraag als [niveau 1] zijn gemarkeerd, en de documenten die bij deze chat zijn gevoegd. Zoek hier altijd eerst.
- Niveau 2: de passages die als [niveau 2] zijn gemarkeerd (eerdere Kamerstukken en antwoorden op Kamervragen). Gebruik deze alleen voor het deel dat niet in niveau 1 staat. Meld bij elke lijn uit niveau 2 onder 'Aandachtspunten' dat moet worden nagegaan of die nog actueel is.
Staat het antwoord niet in de bronnen, typ dan op die plek [NIET GEVONDEN IN BRONNEN]. Vul niets zelf aan en gebruik geen eigen kennis.

Regels:
- Begin met een parafrase: 'De leden van de fractie van [partij] vragen …'.
- Hergebruik de bestaande lijn zo letterlijk mogelijk, met dezelfde stelligheid ('kan', 'naar verwachting', 'in beginsel' overnemen).
- Doe geen toezeggingen en kondig geen nieuw beleid aan.
- Een bron die aan de Tweede Kamer is gericht en 'uw Kamer' noemt, gaat over de Tweede Kamer.
- Noem bij elke bewering de bron met Kamerstuknummer, datum en het paginanummer dat bij de passage staat, plus een letterlijk citaat van maximaal twee zinnen. Verzin nooit een paginanummer.

Uitvoer per vraag:
CONCEPTANTWOORD
[alleen de antwoordtekst]

-------- CONTROLE (niet kopiëren) --------
Bronnen: …
Aandachtspunten: …

Bevestig alleen met: 'Klaar. Stuur de eerste vraag.'`;

const DEFAULT_PROMPT = `Fractie: {{fractie}}
Vraag (letterlijk):
"{{vraag}}"

Gevonden passages uit Kamerstukken (letterlijke tekst, met vindplaats en paginanummer):

{{bronnen}}`;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* geen opslag beschikbaar */ } },
};

let state = { query: "", terms: [], passages: [], selected: new Set() };

// ---------------------------------------------------------------------------
// Hulpfuncties
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function setStatus(msg, { busy = false, error = false } = {}) {
  els.status.className = "status" + (error ? " error" : "");
  els.status.innerHTML = (busy ? '<span class="spinner" aria-hidden="true"></span>' : "") + esc(msg);
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d + "T12:00:00");
  return isNaN(dt) ? d : dt.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
}

function shortYear(vj) {
  // "2025-2026" -> "2025/26"
  const m = /^(\d{4})-(\d{4})$/.exec(vj || "");
  return m ? `${m[1]}/${m[2].slice(2)}` : vj || "";
}

// Gangbare bronvermelding, bijv. "Kamerstukken II 2025/26, 36748, nr. 6".
export function citation(doc) {
  const kamer = /Eerste Kamer/i.test(doc.creator) ? "I" : "II";
  const vj = shortYear(doc.vergaderjaar);
  let m;
  if ((m = /^ah-(tk|ek)-(\d{4})(\d{4})-(\d+)/.exec(doc.id))) {
    return `Aanhangsel Handelingen ${m[1] === "ek" ? "I" : "II"} ${m[2]}/${m[3].slice(2)}, nr. ${m[4]}`;
  }
  if (/^kst-/.test(doc.id) && doc.dossier && doc.ondernummer) {
    return `Kamerstukken ${kamer}${vj ? " " + vj : ""}, ${doc.dossier}, nr. ${doc.ondernummer}`;
  }
  if ((m = /^kst-(.+)-([^-]+)$/.exec(doc.id))) {
    return `Kamerstukken ${kamer}${vj ? " " + vj : ""}, ${doc.dossier || m[1]}, nr. ${doc.ondernummer || m[2]}`;
  }
  if ((m = /^h-(tk|ek)-(\d{4})(\d{4})-(.+)$/.exec(doc.id))) {
    return `Handelingen ${m[1] === "ek" ? "I" : "II"} ${m[2]}/${m[3].slice(2)}, nr. ${m[4].split("-")[0]}, item ${m[4].split("-")[1] || ""}`.replace(/, item $/, "");
  }
  return doc.id;
}

function typeLabel(doc) {
  if (/Aanhangsel/.test(doc.type)) return { text: "Antwoord Kamervragen", cls: "answer" };
  if (/Handelingen/.test(doc.type)) return { text: "Debat", cls: "" };
  if (/^Verslag \(initiatief\)wetsvoorstel/.test(doc.subtype || "")) return { text: "Verslag (alleen vragen)", cls: "" };
  const sub = doc.subtype && doc.subtype !== "Overig" ? doc.subtype.replace(/\s*\(nader\/[^)]*\)/, "").replace("n.a.v.", "naar aanleiding van") : "Kamerstuk";
  return { text: sub, cls: "" };
}

// Toon van een lange Kamerstuk-titel alleen het informatieve deel.
function niceTitle(doc) {
  const parts = doc.title.split(/\s*;\s*/);
  if (parts.length >= 3) return parts.slice(2).join("; ");
  if (parts.length === 2) return parts[1];
  return doc.title;
}

// Markeer zoektermen (inclusief varianten en verbuigingen) in een tekst.
function highlighter(terms) {
  const single = new Set();
  const stems = new Set();
  for (const t of terms) {
    for (const v of variantsOf(t)) {
      for (const w of tokenize(v)) {
        if (w.length < 3 || STOPWORDS.has(w)) continue;
        single.add(w);
        stems.add(stem(w));
      }
    }
  }
  const re = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  return (text) => {
    let out = "", last = 0, m;
    while ((m = re.exec(text))) {
      const w = normalize(m[0]);
      const hit = single.has(w) || stems.has(stem(w));
      out += esc(text.slice(last, m.index)) + (hit ? `<mark>${esc(m[0])}</mark>` : esc(m[0]));
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  };
}

// Alinea's met markering. Bij ingekorte weergave beginnen we bij de eerste
// alinea met een treffer, zodat de relevante tekst direct zichtbaar is.
function paras(text, hl, { fromHit = false } = {}) {
  let ps = text.split("\n").filter(Boolean).map((p) => hl(p));
  if (fromHit) {
    const first = ps.findIndex((p) => p.includes("<mark>"));
    if (first > 1) ps = ['<p class="muted">…</p>', ...ps.slice(first)];
    else ps = ps.map((p) => p);
  }
  return ps.map((p) => (p.startsWith("<p") ? p : `<p>${p}</p>`)).join("");
}

// Fractienaam(en) uit de vraag halen, in de schrijfwijze van de Schrijfwijzer.
const PARTY_NAMES = {
  bbb: "BBB", cda: "CDA", christenunie: "ChristenUnie", cu: "ChristenUnie", d66: "D66", fvd: "FvD",
  "groenlinks-pvda": "GroenLinks-PvdA", "gl-pvda": "GroenLinks-PvdA", glpvda: "GroenLinks-PvdA", groenlinks: "GroenLinks-PvdA",
  ja21: "JA21", pvdd: "PvdD", pvv: "PVV", sgp: "SGP", sp: "SP", volt: "Volt", vvd: "VVD", "50plus": "50PLUS",
  nsc: "NSC", denk: "DENK", pro: "PRO", osf: "OSF",
};
export function extractFractie(q) {
  const found = [];
  const add = (raw) => {
    const k = raw.toLowerCase().replace(/[’']/g, "");
    const name = PARTY_NAMES[k] || (/^[A-Z0-9][\w-]{1,20}$/.test(raw) ? raw : null);
    if (name && !found.includes(name)) found.push(name);
  };
  for (const m of q.matchAll(/\b([\w-]{2,20})-fractie/giu)) add(m[1]);
  for (const m of q.matchAll(/fracties? van (?:de |het )?([\w-]{2,20})((?:\s*(?:,|en)\s*(?:de |het )?[\w-]{2,20})*)/giu)) {
    add(m[1]);
    for (const x of (m[2] || "").split(/\s*(?:,|en)\s*/)) if (x) add(x.replace(/^(de|het)\s+/i, ""));
  }
  for (const m of q.matchAll(/\((BBB|CDA|ChristenUnie|D66|FvD|GroenLinks-PvdA|JA21|PvdD|PVV|SGP|SP|Volt|VVD|50PLUS|NSC|DENK)\)/g)) add(m[1]);
  if (found.length <= 1) return found[0] || "";
  return found.slice(0, -1).join(", ") + " en " + found[found.length - 1];
}

const parseDossiers = (v) => (v || "").split(/[\s,;]+/).map((x) => x.replace(/\D/g, "")).filter(Boolean);

// ---------------------------------------------------------------------------
// Zoeken
// ---------------------------------------------------------------------------

function currentOptions() {
  const types = [...document.querySelectorAll('input[name="type"]:checked')].map((i) => i.value);
  const dossiers = els.dossier.value.split(/[\s,;]+/).filter(Boolean);
  return { types, subject: els.subject.value, fromDate: els.from.value, toDate: els.to.value, dossiers };
}

async function runSearch({ query, terms } = {}) {
  query = (query ?? els.q.value).trim();
  if (!query && !terms?.length) { els.q.focus(); return; }
  const opts = currentOptions();
  if (!opts.types.length) { setStatus("Kies minimaal één soort stuk bij de filters.", { error: true }); return; }

  state = { query, terms: [], passages: [], selected: new Set() };
  els.fractie.value = extractFractie(query);
  els.btn.disabled = true;
  els.results.innerHTML = "";
  els.docs.hidden = true;
  updateUrl(query);
  const t0 = performance.now();
  try {
    const level1 = parseDossiers(els.level1.value);
    const searchOpts = { ...opts, terms, pdfToText };
    // Niveau 1-dossier(s) apart doorzoeken, zodat die stukken er altijd tussen staan.
    const level1Search = level1.length && !opts.dossiers.length
      ? search(query, { ...searchOpts, dossiers: level1, maxDocs: 8, maxPassages: 8 }).catch(() => null)
      : Promise.resolve(null);
    const [res, res1] = await Promise.all([
      search(query, { ...searchOpts, onProgress: (m) => setStatus(m, { busy: true }) }),
      level1Search,
    ]);
    const isLevel1 = (p) => level1.includes(p.doc.dossier);
    const key = (p) => `${p.doc.id}#${p.index}`;
    const seen = new Set();
    const merged = [];
    for (const p of [...(res1?.passages || []), ...res.passages]) {
      if (seen.has(key(p))) continue;
      seen.add(key(p));
      merged.push({ ...p, level1: isLevel1(p) });
    }
    // Niveau 1 bovenaan, verder op relevantie.
    merged.sort((a, b) => (b.level1 - a.level1) || b.score - a.score);
    state.terms = res.allTerms;
    state.passages = merged;
    renderTerms();
    renderDocs(res.candidates);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (res.docsUnavailable && !merged.length) {
      renderFallback(res.candidates);
      setStatus("De documentendatabank van officielebekendmakingen.nl reageert nu niet. Daardoor kunnen geen tekstfragmenten worden getoond. Hieronder staan wel de best passende stukken.", { error: true });
      return;
    }
    renderResults();
    setStatus(res.passages.length
      ? `${state.passages.length} relevante passages uit ${res.candidates.length} documenten (${secs} s).${res1?.passages?.length ? ` Waarvan ${state.passages.filter((p) => p.level1).length} uit niveau 1.` : ""}`
      : "Geen passende passages gevonden. Probeer andere of minder zoektermen.");
    if (res.failed && !res.docsUnavailable) {
      els.status.insertAdjacentHTML("beforeend", ` <span class="muted">(${res.failed} documenten konden niet worden opgehaald.)</span>`);
    }
  } catch (e) {
    console.error(e);
    if (e.allTerms) { state.terms = e.allTerms; renderTerms(); }
    const msg = e.name === "AbortError" ? "De zoekdienst reageert niet. Probeer het later opnieuw." : e.message;
    setStatus(msg, { error: true });
  } finally {
    els.btn.disabled = false;
  }
}

function updateUrl(query) {
  try {
    const u = new URL(location.href);
    u.searchParams.set("q", query);
    history.replaceState(null, "", u);
  } catch { /* negeren */ }
}

// ---------------------------------------------------------------------------
// Weergave
// ---------------------------------------------------------------------------

function renderTerms() {
  els.termsPanel.hidden = false;
  els.terms.innerHTML = state.terms.map((t, i) => {
    const syn = variantsOf(t).filter((v) => v !== t.term);
    const title = syn.length ? `Ook gezocht op: ${syn.join(", ")}` : "";
    return `<span class="chip${t.df === 0 ? " zero" : ""}" title="${esc(title)}">
      ${esc(t.term)}${syn.length ? ` <span class="syn">+${syn.length}</span>` : ""}
      <span class="n">${t.df ?? ""}</span>
      <button type="button" data-i="${i}" aria-label="Verwijder ${esc(t.term)}">×</button></span>`;
  }).join("");
}

const OLD_DAYS = 730; // antwoorden ouder dan 2 jaar krijgen een waarschuwing
const ageDays = (d) => (Date.now() - new Date(d + "T12:00:00")) / 864e5;

// Welke passages tonen we, in welke volgorde (filters en sortering uit de balk).
function visiblePassages() {
  let list = state.passages.map((p, i) => ({ p, i }));
  if (els.onlyQa.checked) list = list.filter(({ p }) => p.question && p.answer);
  if (els.onlyRecent.checked) list = list.filter(({ p }) => ageDays(p.doc.date) <= OLD_DAYS);
  if (els.sort.value === "date") list.sort((a, b) => (b.p.level1 - a.p.level1) || b.p.doc.date.localeCompare(a.p.doc.date) || b.p.score - a.p.score);
  return list;
}

// Nieuwste stuk per dossier onder de resultaten, om te wijzen op een mogelijk nieuwere lijn.
function newestPerDossier() {
  const m = new Map();
  for (const p of state.passages) {
    const k = p.doc.dossier;
    if (!k) continue;
    if (!m.has(k) || p.doc.date > m.get(k).date) m.set(k, p.doc);
  }
  return m;
}

function renderResults() {
  const hl = highlighter(state.terms.filter((t) => t.df > 0));
  els.concept.hidden = state.passages.length === 0;
  els.toolbar.hidden = state.passages.length === 0;
  const list = visiblePassages();
  const newest = newestPerDossier();
  els.shown.textContent = list.length === state.passages.length ? "" : `${list.length} van ${state.passages.length} getoond`;
  if (state.passages.length && !list.length) {
    els.results.innerHTML = `<div class="empty">Geen passages over met deze filters.</div>`;
    updateSelection();
    return;
  }
  els.results.innerHTML = list.map(({ p, i }) => {
    const d = p.doc;
    const old = ageDays(d.date) > OLD_DAYS;
    const nd = d.dossier && newest.get(d.dossier);
    const newer = nd && nd.id !== d.id && nd.date > d.date ? nd : null;
    const notices = [];
    if (old) notices.push(`<strong>Let op:</strong> dit antwoord is ouder dan 2 jaar. Controleer of dit nog de lijn van het kabinet is.`);
    if (newer) notices.push(`Er is een nieuwer stuk in dit dossier: <a href="${esc(newer.url)}" target="_blank" rel="noopener">${esc(citation(newer))}</a> (${esc(fmtDate(newer.date))}).`);
    if (p.alsoIn?.length) notices.push(`Dezelfde tekst staat ook in: ${p.alsoIn.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(citation(o))}</a>`).join(", ")}.`);
    const type = typeLabel(d);
    const long = (p.question.length + p.answer.length) > 1100;
    const sel = state.selected.has(i);
    return `<article class="result${sel ? " selected" : ""}" data-i="${i}">
      <div class="result-meta">
        ${p.level1 ? `<span class="badge level1" title="Uit het dossier dat je als niveau 1 hebt ingesteld">Niveau 1</span>` : ""}
        <span class="badge ${type.cls}">${esc(type.text)}</span>
        <span>${esc(fmtDate(d.date))}</span>
        ${d.unformatted ? `<span class="badge new" title="Dit stuk is recent gepubliceerd en nog niet definitief opgemaakt. De tekst komt uit de PDF.">Nieuw · nog niet opgemaakt</span>` : ""}
        ${old ? `<span class="badge old" title="Controleer of dit nog de actuele lijn is">Ouder dan 2 jaar</span>` : ""}
        ${d.indiener && /Aanhangsel/.test(d.type) ? `<span>Vragensteller: ${esc(d.indiener)}</span>` : ""}
      </div>
      <h3><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(niceTitle(d))}</a></h3>
      <div class="ref">${esc(citation(d))}${p.page ? ` · <span class="page">blz. ${p.page}</span>` : ""}</div>
      ${p.heading && !/^Vraag/.test(p.heading) ? `<div class="heading">${esc(p.heading)}</div>` : ""}
      <div class="qa${long ? " clamp" : ""}">
        ${p.question ? `<div class="q">${paras(p.question, hl)}</div>` : ""}
        ${p.answer ? `<div class="a${p.question ? " labelled" : ""}">${paras(p.answer, hl, { fromHit: long })}</div>` : ""}
      </div>
      ${notices.map((n) => `<div class="notice">${n}</div>`).join("")}
      <div class="result-actions">
        <label><input type="checkbox" class="pick" ${sel ? "checked" : ""}> Gebruik als bron</label>
        ${long ? `<button type="button" class="linkish more">Toon alles</button>` : ""}
        <button type="button" class="linkish copy-one">Kopieer passage</button>
        <a href="${esc(d.url)}" target="_blank" rel="noopener">Open document ↗</a>
      </div>
    </article>`;
  }).join("");
  updateSelection();
}

// Als de teksten niet op te halen zijn: toon de gevonden stukken als lijst met links.
function renderFallback(docs) {
  els.concept.hidden = true;
  els.toolbar.hidden = true;
  els.results.innerHTML = `<div class="notice-box">
      <strong>Storing bij officielebekendmakingen.nl.</strong> Het zoeken werkt, maar de tekst van de stukken is op dit moment niet op te halen.
      Hieronder staan de stukken die het best bij je vraag passen, op volgorde van relevantie. Open een stuk om de tekst te lezen, of probeer het later opnieuw.
    </div>` + docs.slice(0, 20).map((d) => {
    const type = typeLabel(d);
    return `<article class="result">
      <div class="result-meta"><span class="badge ${type.cls}">${esc(type.text)}</span><span>${esc(fmtDate(d.date))}</span></div>
      <h3><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(niceTitle(d))}</a></h3>
      <div class="ref">${esc(citation(d))}</div>
    </article>`;
  }).join("");
}

function renderDocs(docs) {
  els.docs.hidden = !docs.length;
  els.docCount.textContent = docs.length;
  els.docList.innerHTML = docs.map((d) =>
    `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(niceTitle(d))}</a> <span class="muted">— ${esc(citation(d))}, ${esc(fmtDate(d.date))}</span></li>`
  ).join("");
}

function updateSelection() {
  const n = state.selected.size;
  els.selCount.textContent = n;
  els.copy.disabled = n === 0;
}

// ---------------------------------------------------------------------------
// Prompt voor conceptantwoord
// ---------------------------------------------------------------------------

function passageText(p) {
  const parts = [];
  if (p.question) parts.push(`Vraag: ${p.question.replace(/\n/g, " ")}`);
  if (p.answer) parts.push(`${p.question ? "Antwoord: " : ""}${p.answer}`);
  return parts.join("\n");
}

function addressedTo(d) {
  if (/^ah-ek-|^h-ek-/.test(d.id) || /Eerste Kamer/i.test(d.creator)) return "Eerste Kamer";
  return "Tweede Kamer";
}

function sourceBlock(p, n) {
  const d = p.doc;
  const level = p.level1 ? "[niveau 1] " : parseDossiers(els.level1.value).length ? "[niveau 2] " : "";
  const page = p.page ? `blz. ${p.page}` : p.pageUnknown ? "paginanummer niet gevonden, controleer in het document" : "";
  return [
    `[${n}] ${level}${citation(d)} – ${niceTitle(d)} (${fmtDate(d.date)})${page ? ", " + page : ""}`,
    `Gericht aan: ${addressedTo(d)}${p.heading && !/^Vraag/.test(p.heading) ? ` · Paragraaf: ${p.heading}` : ""}`,
    `Link: ${d.url}`,
    passageText(p),
  ].join("\n");
}

// Paginanummers opzoeken in de PDF van elk geselecteerd stuk (één keer per stuk).
const pageCache = new Map();
async function addPageNumbers(passages) {
  const todo = passages.filter((p) => !p.page && !p.pageUnknown && p.doc.pdfUrl);
  if (!todo.length) return;
  setStatus("Paginanummers opzoeken in de PDF…", { busy: true });
  const pdfjs = await loadPdfjs();
  await Promise.all([...new Set(todo.map((p) => p.doc))].map(async (doc) => {
    if (!pageCache.has(doc.id)) {
      pageCache.set(doc.id, fetch(doc.pdfUrl)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((b) => pdfPageTexts(new Uint8Array(b), pdfjs))
        .catch(() => null));
    }
  }));
  for (const p of todo) {
    const pages = await pageCache.get(p.doc.id);
    const page = pages && (findPage(pages, p.question || p.answer) || findPage(pages, p.answer));
    if (page) p.page = page; else p.pageUnknown = true;
  }
  setStatus(`${state.passages.length} relevante passages. Paginanummers toegevoegd.`);
  renderResults();
}

function selectedPassages() {
  return [...state.selected].sort((a, b) => a - b).map((i) => state.passages[i]);
}

function buildPrompt() {
  const tpl = els.template.value || DEFAULT_PROMPT;
  const picked = selectedPassages();
  // Niveau 1 eerst in de bronnenlijst.
  picked.sort((a, b) => (b.level1 || 0) - (a.level1 || 0));
  const bronnen = picked.map((p, k) => sourceBlock(p, k + 1)).join("\n\n");
  return tpl
    .replaceAll("{{fractie}}", els.fractie.value.trim() || "[partij]")
    .replaceAll("{{vraag}}", state.query)
    .replaceAll("{{bronnen}}", bronnen);
}

// Instellingen delen via een link (in het #-deel, dat niet naar een server gaat).
async function packSettings(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let data = bytes;
  if (typeof CompressionStream !== "undefined") {
    const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    data = new Uint8Array(await new Response(cs).arrayBuffer());
  }
  let bin = "";
  data.forEach((b) => { bin += String.fromCharCode(b); });
  return (typeof CompressionStream !== "undefined" ? "z" : "p") + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function unpackSettings(str) {
  const kind = str[0];
  const b64 = str.slice(1).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let data = bytes;
  if (kind === "z") {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    data = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(data));
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast(msg);
}

// ---------------------------------------------------------------------------
// Gebeurtenissen
// ---------------------------------------------------------------------------

els.form.addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
els.q.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSearch(); }
});

els.terms.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  state.terms.splice(+b.dataset.i, 1);
  renderTerms();
});

els.addTerm.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = els.newTerm.value.trim();
  if (!v) return;
  const term = normalize(v.replace(/["“”]/g, ""));
  const extra = applySynonyms([{ term, phrase: term.includes(" ") }], term);
  for (const t of extra) if (!state.terms.some((x) => x.term === t.term)) state.terms.push({ ...t, df: undefined });
  els.newTerm.value = "";
  renderTerms();
});

els.rerun.addEventListener("click", () => {
  if (!state.terms.length) return;
  const terms = state.terms.map(({ term, phrase, variants, compoundOf }) => ({ term, phrase, variants, compoundOf }));
  runSearch({ query: state.query || els.q.value, terms });
});

els.results.addEventListener("click", (e) => {
  const card = e.target.closest(".result");
  if (!card) return;
  const i = +card.dataset.i;
  if (e.target.classList.contains("more")) {
    const p = state.passages[i];
    const hl = highlighter(state.terms.filter((t) => t.df > 0));
    const a = card.querySelector(".a");
    if (a) a.innerHTML = paras(p.answer, hl);
    card.querySelector(".qa").classList.remove("clamp");
    e.target.remove();
  } else if (e.target.classList.contains("copy-one")) {
    copyText(sourceBlock(state.passages[i], 1).replace(/^\[1\] /, ""), "Passage gekopieerd");
  }
});
els.results.addEventListener("change", (e) => {
  if (!e.target.classList.contains("pick")) return;
  const card = e.target.closest(".result");
  const i = +card.dataset.i;
  if (e.target.checked) state.selected.add(i); else state.selected.delete(i);
  card.classList.toggle("selected", e.target.checked);
  updateSelection();
});

for (const el of [els.sort, els.onlyQa, els.onlyRecent]) el.addEventListener("change", renderResults);

els.copy.addEventListener("click", async () => {
  els.copy.disabled = true;
  try {
    await addPageNumbers(selectedPassages());
  } catch { /* zonder paginanummers verder */ }
  els.copy.disabled = state.selected.size === 0;
  copyText(buildPrompt(), "Vraag + bronnen gekopieerd – plak ze in je AI-chatbot");
});
els.copyFixed.addEventListener("click", () => copyText(els.fixed.value || DEFAULT_FIXED, "Vaste instructie gekopieerd – plak die als eerste bericht in een nieuw gesprek"));

els.fixed.value = store.get("kz-prompt-a", DEFAULT_FIXED);
els.template.value = store.get("kz-prompt-b", DEFAULT_PROMPT);
els.level1.value = store.get("kz-level1", "");
els.level1.addEventListener("change", () => store.set("kz-level1", els.level1.value.trim()));
const saveSettings = () => {
  store.set("kz-prompt-a", els.fixed.value);
  store.set("kz-prompt-b", els.template.value);
  store.set("kz-level1", els.level1.value.trim());
};
els.savePrompt.addEventListener("click", () => { saveSettings(); toast("Prompts opgeslagen in deze browser"); });
els.resetPrompt.addEventListener("click", () => {
  if (!confirm("Beide prompts terugzetten naar de standaardtekst?")) return;
  els.fixed.value = DEFAULT_FIXED; els.template.value = DEFAULT_PROMPT; saveSettings();
  toast("Standaardprompts teruggezet");
});
els.share.addEventListener("click", async () => {
  saveSettings();
  const packed = await packSettings({ a: els.fixed.value, b: els.template.value, l1: els.level1.value.trim() });
  const url = `${location.origin}${location.pathname}#instellingen=${packed}`;
  copyText(url, "Link met instellingen gekopieerd – stuur hem naar je collega's");
});

// Instellingen van een collega overnemen (link met #instellingen=…).
(async () => {
  const m = /#instellingen=([\w-]+)/.exec(location.hash);
  if (!m) return;
  try {
    const st = await unpackSettings(m[1]);
    if (confirm("Deze link bevat prompts en instellingen van een collega. Wil je die overnemen? Je eigen prompts worden dan vervangen.")) {
      if (st.a) els.fixed.value = st.a;
      if (st.b) els.template.value = st.b;
      if (typeof st.l1 === "string") els.level1.value = st.l1;
      saveSettings();
      toast("Instellingen overgenomen");
    }
  } catch {
    toast("Deze link met instellingen is niet leesbaar");
  }
  history.replaceState(null, "", location.pathname + location.search);
})();

// Lege staat met voorbeelden.
const VOORBEELDEN = [
  "De leden van de JA21-fractie vragen wat de eventuele gevolgen van de carry-back zullen zijn in een brede vermogenswinstbelasting.",
  "gegevenslevering banken 2028",
  "box 3 groene beleggingen",
  "Waarom zijn cryptoactiva niet opgenomen in de vermogenswinstbelasting?",
];
function renderEmpty() {
  els.results.innerHTML = `<div class="empty">
    <strong>Tip:</strong> plak de volledige Kamervraag. De zoeker haalt zelf de belangrijke woorden eruit, zoekt ook op synoniemen
    (bijv. crypto ↔ cryptovaluta) en laat per document de best passende vraag-en-antwoordpassages zien.
    <div class="examples">${VOORBEELDEN.map((v) => `<button type="button" class="btn">${esc(v.length > 60 ? v.slice(0, 57) + "…" : v)}</button>`).join("")}</div>
  </div>`;
  els.results.querySelectorAll(".examples button").forEach((b, i) =>
    b.addEventListener("click", () => { els.q.value = VOORBEELDEN[i]; runSearch(); }));
}

// Zoekvraag uit de link (gedeelde links werken zo direct).
const initial = new URLSearchParams(location.search).get("q");
if (initial) { els.q.value = initial; runSearch({ query: initial }); } else { renderEmpty(); }
