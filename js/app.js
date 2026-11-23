import { search, applySynonyms, normalize, stem, tokenize, variantsOf, STOPWORDS } from "./search.js";
import { pdfToParagraphs } from "./pdf.js";

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
  template: $("#prompt-template"), savePrompt: $("#save-prompt"), resetPrompt: $("#reset-prompt"),
  docs: $("#docs"), docCount: $("#doc-count"), docList: $("#doc-list"), toast: $("#toast"),
  subject: $("#subject"), from: $("#from"), to: $("#to"), dossier: $("#dossier"),
  toolbar: $("#toolbar"), sort: $("#sort"), onlyQa: $("#only-qa"), onlyRecent: $("#only-recent"), shown: $("#shown"),
};

const DEFAULT_PROMPT = `Je bent beleidsmedewerker bij het ministerie van Financiën, Directoraat-Generaal Fiscale Zaken. Stel een conceptantwoord op voor onderstaande Kamervraag.

- Baseer je uitsluitend op de bijgevoegde eerdere antwoorden en Kamerstukken.
- Sluit zo veel mogelijk aan bij de formuleringen die het kabinet eerder heeft gebruikt.
- Vermeld bij elke inhoudelijke bewering de bron tussen haakjes, bijvoorbeeld (Kamerstukken II 2025/26, 36748, nr. 6).
- Geef aan waar de bronnen geen antwoord bieden of mogelijk verouderd zijn.
- Schrijf in de stijl van een antwoord op Kamervragen: zakelijk, kort en zonder opsommingstekens tenzij nodig.

KAMERVRAAG:
{{vraag}}

BRONNEN:
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
  els.btn.disabled = true;
  els.results.innerHTML = "";
  els.docs.hidden = true;
  updateUrl(query);
  const t0 = performance.now();
  try {
    const res = await search(query, { ...opts, terms, pdfToText, onProgress: (m) => setStatus(m, { busy: true }) });
    state.terms = res.allTerms;
    state.passages = res.passages;
    renderTerms();
    renderResults();
    renderDocs(res.candidates);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(res.passages.length
      ? `${res.passages.length} relevante passages uit ${res.candidates.length} documenten (${secs} s).`
      : "Geen passende passages gevonden. Probeer andere of minder zoektermen.");
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
  if (els.sort.value === "date") list.sort((a, b) => b.p.doc.date.localeCompare(a.p.doc.date) || b.p.score - a.p.score);
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
        <span class="badge ${type.cls}">${esc(type.text)}</span>
        <span>${esc(fmtDate(d.date))}</span>
        ${d.unformatted ? `<span class="badge new" title="Dit stuk is recent gepubliceerd en nog niet definitief opgemaakt. De tekst komt uit de PDF.">Nieuw · nog niet opgemaakt</span>` : ""}
        ${old ? `<span class="badge old" title="Controleer of dit nog de actuele lijn is">Ouder dan 2 jaar</span>` : ""}
        ${d.indiener && /Aanhangsel/.test(d.type) ? `<span>Vragensteller: ${esc(d.indiener)}</span>` : ""}
      </div>
      <h3><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(niceTitle(d))}</a></h3>
      <div class="ref">${esc(citation(d))}</div>
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
  if (p.answer) parts.push(`${p.question ? "Antwoord: " : ""}${p.answer.replace(/\n/g, "\n")}`);
  return parts.join("\n");
}

function sourceBlock(p, n) {
  const d = p.doc;
  return `[${n}] ${citation(d)} (${fmtDate(d.date)}) – ${niceTitle(d)}\n${d.url}\n${passageText(p)}`;
}

function buildPrompt() {
  const tpl = els.template.value || DEFAULT_PROMPT;
  const picked = [...state.selected].sort((a, b) => a - b).map((i) => state.passages[i]);
  const bronnen = picked.map((p, k) => sourceBlock(p, k + 1)).join("\n\n");
  return tpl.replaceAll("{{vraag}}", state.query).replaceAll("{{bronnen}}", bronnen);
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

els.copy.addEventListener("click", () => copyText(buildPrompt(), "Prompt gekopieerd – plak hem in je AI-chatbot"));
els.template.value = store.get("kz-prompt", DEFAULT_PROMPT);
els.savePrompt.addEventListener("click", () => { store.set("kz-prompt", els.template.value); toast("Prompt opgeslagen in deze browser"); });
els.resetPrompt.addEventListener("click", () => { els.template.value = DEFAULT_PROMPT; store.set("kz-prompt", DEFAULT_PROMPT); toast("Standaardprompt teruggezet"); });

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
