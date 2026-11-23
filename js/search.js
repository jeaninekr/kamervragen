// Zoeklogica voor de Kamerstukken-zoeker.
// Werkt zonder server: zoekt live in de open data van officielebekendmakingen.nl
// (SRU-zoekdienst van KOOP) en rangschikt daarna de afzonderlijke passages
// (vraag + antwoord, alinea's) op relevantie. Geen DOM-afhankelijkheden, zodat
// dit bestand ook in Node getest kan worden.

import { SYNONIEMEN } from "./synoniemen.js";

export const SRU_URL = "https://repository.overheid.nl/sru";
const RARE_DF = 300; // termen die in maximaal zoveel stukken staan, halen we volledig op
const TIMEOUT_MS = 20000;

export const DOC_TYPES = {
  aanhangsel: { label: "Antwoorden op Kamervragen", cql: 'dt.type="Aanhangsel van de Handelingen"' },
  kamerstuk: { label: "Kamerstukken (brieven, nota's, MvT)", cql: 'dt.type="Kamerstuk"' },
  handelingen: { label: "Handelingen (debatten)", cql: 'dt.type="Handelingen"' },
};

export const SUBJECTS = {
  belasting: { label: "Financiën | Belasting", cql: 'dt.subject=="Financiën | Belasting"' },
  alles: { label: "Alle onderwerpen", cql: "" },
};

// ---------------------------------------------------------------------------
// Tekstverwerking
// ---------------------------------------------------------------------------

export const STOPWORDS = new Set(`
aan aangaande aangezien achter af afgelopen al aldaar aldus alhoewel alle allebei alleen alles als alsnog altijd andere anders ben bent bij bijna
binnen boven bovendien buiten daar daarbij daarin daarna daarnaast daarom daarop daarvan dan dat de deze die dit doch doen door dus echter een eens
en enig enige er erg ermee even ex geen gehad geweest haar had hadden heb hebben hebt heeft hem hen het hier hij hoe hoewel hun iemand iets ik in
inmiddels is ja je jij jou juist kan kon konden kunnen kunt later liever maar meer men met mij mijn moet moeten na naar nadat namelijk niet niets
noch nog nu of ofschoon om omdat ondanks onder ons ook op over reeds rond sinds sindsdien slechts sommige spoedig steeds tamelijk te tegen ten
tenzij ter terwijl toch toen tot totdat tussen u uit uw van vanaf vanwege veel verder via vooraf voor vooral voordat voorts vrij waar waarom
wanneer want waren was wat we weer wel welk welke werd werden wie wij wil willen word worden wordt zal ze zei zelf zich zij zijn zo zoals zodat zou
zouden zullen zowel daaraan hierover hierbij hiervan waarbij waarin waarvan waarop welke welk wiens wier ditmaal
`.trim().split(/\s+/));

// Woorden die in (Kamer)vragen vaak voorkomen maar niets over het onderwerp zeggen.
const FILLER = new Set(`
leden lid fractie fracties fractieleden vragen vraagt vraag vroeg vroegen gevraagd verzoek verzoeken verzocht gedaan doen regering kabinet
minister staatssecretaris bewindspersoon kamer tweede eerste duidelijkheid mogelijkheid mogelijkheden eventuele eventueel gevolgen gevolg
nader nadere toelichting toelichten ingaan reflectie reflecteren waarom welke hoe wat wanneer klopt het geven gegeven aangeven aangegeven
beschouwt beschouwen mening oordeel bereid bereidheid onze eigen zoals gedefinieerd opgenomen sprake genoemd genoemde noemt betreft
betreffende ten aanzien aanzien acht achten kunt kunnen wilt willen graag tevens alsmede ervan erop daarover hiervoor waarvoor
liggen ligt lag hoger lager grondslag basis gebaseerd tegenover verwacht verwachte verwachtte zullen zal leiden leidt
wet wetten gaan gaat komen komt maken maakt staan staat houden geldt gelden waarbij namelijk mogelijk aantal deel per
`.trim().split(/\s+/));

const PARTIES = new Set(`
vvd pvv cda d66 sp pvda groenlinks gl glpvda groenlinks-pvda cu christenunie sgp pvdd fvd ja21 bbb nsc volt denk 50plus bij1 pro
`.trim().split(/\s+/));

export function normalize(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'");
}

// Zeer lichte Nederlandse stemmer: alleen gangbare meervouds-/buigingsuitgangen.
export function stem(w) {
  w = w.replace(/'s$/, "");
  if (w.length > 6 && w.endsWith("heden")) return w.slice(0, -5) + "heid";
  if (w.length > 5 && w.endsWith("en")) return w.slice(0, -2);
  if (w.length > 5 && (w.endsWith("s") || w.endsWith("e"))) return w.slice(0, -1);
  return w;
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu;

export function tokenize(text) {
  return normalize(text).match(TOKEN_RE) || [];
}

// Haal zoektermen uit een vraag of een reeks steekwoorden.
// Geeft [{term, phrase, parts}] terug in volgorde van voorkomen.
export function extractTerms(input) {
  const terms = [];
  const seen = new Set();
  const add = (t) => {
    const key = t.term;
    if (!seen.has(key)) { seen.add(key); terms.push(t); }
  };

  // 1. Expliciete zinsdelen tussen aanhalingstekens.
  let rest = input.replace(/["“”]([^"“”]{2,80})["“”]/g, (_, p) => {
    add({ term: normalize(p.trim()), phrase: true });
    return " ";
  });

  // 2. Namen van Kamerleden na "het lid"/"de leden" weghalen (Van Eijk, Stultiens, ...).
  rest = rest.replace(/\b(lid|leden|kamerlid|kamerleden)\s+((?:[Vv]an|[Dd]e|[Dd]er|[Dd]en|[Tt]er|[Tt]en|'t)\s+)*\p{Lu}[\p{L}\-']+(\s*(?:,|en)\s*((?:[Vv]an|[Dd]e|[Dd]er|[Dd]en)\s+)*\p{Lu}[\p{L}\-']+)*/gu, " ");

  const raw = rest.match(TOKEN_RE) || [];
  const kept = []; // [{w, idx}]
  raw.forEach((orig, idx) => {
    const w = normalize(orig);
    const parts = w.split("-");
    if (PARTIES.has(w) || parts.every((p) => PARTIES.has(p) || p === "fractie")) return;
    if (/-fractie$/.test(w)) return;
    if (STOPWORDS.has(w) || FILLER.has(w)) return;
    const isNum = /^\d+$/.test(w);
    if (isNum && !(w.length === 4 && +w > 1990 && +w < 2100)) return; // alleen jaartallen
    if (!isNum && w.length < 3) return;
    kept.push({ w, idx });
  });

  kept.forEach(({ w }) => add({ term: w, phrase: false }));

  // 3. Samenstellingen: "realisatie gedrag" -> "realisatiegedrag".
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i], b = kept[i + 1];
    if (b.idx === a.idx + 1 && /^\p{L}+$/u.test(a.w) && /^\p{L}+$/u.test(b.w)) {
      add({ term: a.w + b.w, phrase: false, compoundOf: [a.w, b.w] });
    }
  }
  return applySynonyms(terms, normalize(input));
}

// Koppel synoniemen aan termen en voeg termen samen die hetzelfde begrip zijn.
export function applySynonyms(terms, normInput = "") {
  const out = [];
  const groupsUsed = new Map(); // groep-index -> term
  for (const t of terms) {
    const gi = SYNONIEMEN.findIndex((g) => g.includes(t.term));
    if (gi < 0) { out.push(t); continue; }
    if (groupsUsed.has(gi)) continue; // al opgenomen als variant
    const nt = { ...t, variants: [...new Set([t.term, ...SYNONIEMEN[gi]])] };
    groupsUsed.set(gi, nt);
    out.push(nt);
  }
  // Begrippen van meerdere woorden die letterlijk in de vraag staan ("box 3",
  // "Wet financieel toezicht"). De losse woorden daarvan vervallen dan.
  const padded = " " + (normInput.match(TOKEN_RE) || []).join(" ") + " ";
  const covered = new Set();
  SYNONIEMEN.forEach((g, gi) => {
    const hits = g.filter((v) => v.includes(" ") && padded.includes(" " + v + " "));
    if (!hits.length) return;
    hits.forEach((h) => h.split(" ").forEach((w) => covered.add(w)));
    if (!groupsUsed.has(gi)) {
      out.push({ term: hits[0], phrase: true, variants: [...g] });
      groupsUsed.set(gi, true);
    }
  });
  return out.filter((t) => {
    if (t.variants || t.phrase) return true;
    if (covered.has(t.term)) return false;
    if (t.compoundOf && t.compoundOf.some((w) => covered.has(w))) return false;
    return true;
  });
}

export function variantsOf(t) {
  return t.variants && t.variants.length ? t.variants : [t.term];
}

// ---------------------------------------------------------------------------
// SRU-zoekdienst
// ---------------------------------------------------------------------------

export function buildBaseQuery({ types = ["aanhangsel", "kamerstuk"], subject = "belasting", fromDate = "2018-01-01", toDate = "" } = {}) {
  const parts = ["c.product-area==officielepublicaties"];
  const typeCql = types.map((t) => DOC_TYPES[t]?.cql).filter(Boolean);
  if (typeCql.length) parts.push("(" + typeCql.join(" OR ") + ")");
  const subj = SUBJECTS[subject]?.cql;
  if (subj) parts.push(subj);
  if (fromDate) parts.push(`dt.date>=${fromDate}`);
  if (toDate) parts.push(`dt.date<=${toDate}`);
  return parts.join(" AND ");
}

function termCql(t) {
  const vs = variantsOf(t).map((v) => `cql.textAndIndexes="${v.replace(/"/g, "")}"`);
  return vs.length === 1 ? vs[0] : "(" + vs.join(" OR ") + ")";
}

async function fetchWithTimeout(fetchFn, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchFn(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sru(fetchFn, query, maximumRecords = 0, startRecord = 1) {
  const params = new URLSearchParams({
    query,
    maximumRecords: String(maximumRecords),
    startRecord: String(startRecord),
    httpAccept: "application/json",
  });
  const res = await fetchWithTimeout(fetchFn, `${SRU_URL}?${params}`);
  if (!res.ok) throw new Error(`Zoekdienst gaf fout ${res.status}`);
  const data = await res.json();
  const r = data.searchRetrieveResponse || {};
  let recs = r.records?.record || [];
  if (!Array.isArray(recs)) recs = [recs];
  return { total: Number(r.numberOfRecords || 0), records: recs.map(parseRecord).filter(Boolean) };
}

function val(x) {
  if (x == null) return "";
  if (Array.isArray(x)) return x.map(val).join(", ");
  if (typeof x === "object") return x.$ ?? "";
  return String(x);
}

export function parseRecord(rec) {
  try {
    const gzd = rec.recordData.gzd;
    const m = gzd.originalData.meta;
    const tp = m.tpmeta || {};
    const id = m.owmskern.identifier;
    const enriched = gzd.enrichedData || {};
    return {
      id,
      title: m.owmskern.title,
      type: val(m.owmskern.type),
      subtype: val(tp.subrubriek),
      date: m.owmsmantel.date || m.owmsmantel.issued || "",
      dossier: tp.dossiernummer ? String(tp.dossiernummer) : "",
      dossierTitle: tp.dossiertitel || "",
      ondernummer: tp.ondernummer != null ? String(tp.ondernummer) : "",
      indiener: val(tp.indiener),
      ontvanger: val(tp.ontvanger),
      vraagnummer: tp.vraagnummer || "",
      vergaderjaar: tp.vergaderjaar || "",
      creator: val(m.owmskern.creator),
      xmlUrl: enriched.url || "",
      url: enriched.preferredUrl || `https://zoek.officielebekendmakingen.nl/${id}.html`,
    };
  } catch {
    return null;
  }
}

// Kleine helper om met beperkte gelijktijdigheid te werken.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function* combinations(arr, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  for (let i = start; i < arr.length; i++) yield* combinations(arr, k, i + 1, [...prefix, arr[i]]);
}

// ---------------------------------------------------------------------------
// Documenten ophalen en in passages opdelen
// ---------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    });
}
function stripTags(s) {
  return decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// Zet de XML van een officiële publicatie om in een lijst blokken.
export function xmlToBlocks(xml) {
  // Metadata en kop niet meenemen.
  xml = xml.replace(/<metadata>[\s\S]*?<\/metadata>/, "");
  xml = xml.replace(/<(kamervraagkop|kamerstukkop|handelingenkop)[\s\S]*?<\/\1>/g, "");
  xml = xml.replace(/<noot\b[\s\S]*?<\/noot>/g, ""); // voetnoten
  const blocks = [];
  let ctx = null; // "vraag" | "antwoord" | "mededeling"
  const re = /<(vraag|antwoord|mededeling)\b[^>]*>|<\/(vraag|antwoord|mededeling)>|<(tussenkop|kop|titel|al|kamervraagomschrijving|spreker)\b[^>]*>([\s\S]*?)<\/\3>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1]) { ctx = m[1]; continue; }
    if (m[2]) { ctx = null; continue; }
    const tag = m[3];
    let text = stripTags(m[4]);
    if (!text) continue;
    if (tag === "spreker") { blocks.push({ kind: "spreker", text, ctx }); continue; }
    const kind = tag === "al" ? "al" : tag === "kamervraagomschrijving" ? "omschrijving" : "kop";
    blocks.push({ kind, text, ctx });
  }
  return blocks;
}

const QUESTION_START = /^(de leden (van )?de?\s*|deze leden|het lid|de leden der|ook de leden|tevens vragen|daarnaast vragen|voorts vragen|verder vragen)/i;

// Deel een document op in passages van behapbare grootte.
export function blocksToPassages(blocks, doc) {
  const passages = [];
  const isAanhangsel = /Aanhangsel/.test(doc.type);
  let heading = "";

  if (isAanhangsel) {
    // Elke vraag met het bijbehorende antwoord vormt één passage.
    let cur = null;
    const intro = blocks.filter((b) => b.kind === "omschrijving").map((b) => b.text).join(" ");
    for (const b of blocks) {
      if (b.ctx === "vraag") {
        if (!cur || cur.answer.length) { cur && passages.push(cur); cur = { question: [], answer: [] }; }
        cur.question.push(b.text);
      } else if (b.ctx === "antwoord") {
        if (!cur) cur = { question: [], answer: [] };
        cur.answer.push(b.text);
      }
    }
    if (cur) passages.push(cur);
    const out = passages.map((p, i) => ({
      heading: p.question[0]?.match(/^(Vraag [\d\s,en-]+)/)?.[1] || `Vraag ${i + 1}`,
      question: p.question.filter((t) => !/^Vraag [\d\s,en-]+$/.test(t)).join("\n"),
      answer: p.answer.filter((t) => !/^Antwoord [\d\s,en-]+$/.test(t)).join("\n"),
    }));
    if (!out.length && intro) out.push({ heading: "", question: "", answer: blocks.filter((b) => b.kind === "al").map((b) => b.text).join("\n") });
    return out.map((p) => ({ ...p, intro }));
  }

  // Overige stukken: groepeer alinea's per kopje; begin een nieuwe passage bij
  // "De leden van de ...-fractie vragen" (verslagen/nota's) of als het te lang wordt.
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    passages.push({ heading, text: cur.join("\n") });
    cur = []; curLen = 0;
  };
  for (const b of blocks) {
    if (b.kind === "kop") { flush(); heading = b.text; continue; }
    if (b.kind === "omschrijving") continue;
    if (b.kind === "spreker") { flush(); cur.push(b.text + ":"); curLen += b.text.length; continue; }
    const startsQuestion = QUESTION_START.test(b.text) && curLen > 0;
    if (startsQuestion || curLen + b.text.length > 1600) flush();
    cur.push(b.text);
    curLen += b.text.length;
  }
  flush();
  // Kleine restpassages samenvoegen met de vorige.
  const merged = [];
  for (const p of passages) {
    const last = merged[merged.length - 1];
    if (last && last.heading === p.heading && p.text.length < 200 && last.text.length < 1800) last.text += "\n" + p.text;
    else merged.push(p);
  }
  return merged.map((p) => {
    // Splits "vraag" en "antwoord" als de passage begint met een vraag van leden.
    const lines = p.text.split("\n");
    if (QUESTION_START.test(lines[0]) && lines.length > 1) {
      return { heading: p.heading, question: lines[0], answer: lines.slice(1).join("\n") };
    }
    return { heading: p.heading, question: "", answer: p.text };
  });
}

// ---------------------------------------------------------------------------
// Rangschikken
// ---------------------------------------------------------------------------

function idf(df, N) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

function passageTokens(p) {
  return tokenize(`${p.heading} ${p.question} ${p.answer}`);
}

export function scorePassages(passages, terms, avgLen) {
  const k1 = 1.2, b = 0.6;
  for (const p of passages) {
    const toks = passageTokens(p);
    const len = toks.length || 1;
    const stems = toks.map(stem);
    const joined = " " + toks.join(" ") + " ";
    let score = 0;
    const matched = [];
    for (const t of terms) {
      let tf = 0;
      for (const v of variantsOf(t)) {
        const vt = tokenize(v);
        if (vt.length > 1) {
          const needle = " " + vt.join(" ") + " ";
          let i = -1;
          while ((i = joined.indexOf(needle, i + 1)) !== -1) tf++;
        } else if (vt.length === 1) {
          const w = vt[0], st = stem(w);
          for (let i = 0; i < toks.length; i++) if (toks[i] === w || stems[i] === st) tf++;
        }
      }
      if (tf) {
        matched.push(t.term);
        score += t.idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen));
      }
    }
    // Passages die meerdere zoektermen bevatten krijgen extra gewicht.
    const coverage = matched.length / Math.max(1, terms.length);
    score *= 0.5 + coverage;
    if (p.answer && p.question) score *= 1.15; // vraag + antwoord is het meest bruikbaar
    p.score = score;
    p.matched = matched;
  }
  return passages;
}

// ---------------------------------------------------------------------------
// Hoofdfunctie
// ---------------------------------------------------------------------------

/**
 * Zoek passages in Kamerstukken die passen bij een vraag of steekwoorden.
 * @param {string} input  Kamervraag of steekwoorden
 * @param {object} opts   {types, subject, fromDate, toDate, maxDocs, fetchFn, onProgress, terms}
 */
export async function search(input, opts = {}) {
  const fetchFn = opts.fetchFn || ((...a) => fetch(...a));
  const progress = opts.onProgress || (() => {});
  const base = buildBaseQuery(opts);
  const maxDocs = opts.maxDocs || 30;

  // 1. Zoektermen bepalen en per term tellen hoe vaak hij voorkomt.
  let terms = opts.terms || extractTerms(input);
  if (!terms.length) throw new Error("Geen bruikbare zoektermen gevonden. Probeer andere woorden.");
  progress("Zoektermen wegen…");
  const totalRes = await sru(fetchFn, base, 0);
  const N = Math.max(1, totalRes.total);
  const dfs = await pool(terms, 6, (t) => sru(fetchFn, `${base} AND ${termCql(t)}`, 0).then((r) => r.total));
  terms = terms.map((t, i) => ({ ...t, df: typeof dfs[i] === "number" ? dfs[i] : 0 }));

  // Samenstelling gevonden? Dan de losse delen minder zwaar laten wegen.
  for (const t of terms) {
    if (t.compoundOf && t.df > 0) {
      for (const part of t.compoundOf) {
        const p = terms.find((x) => x.term === part);
        if (p) p.weak = true;
      }
    }
  }
  const allTerms = terms;
  terms = terms.filter((t) => t.df > 0);
  // Heel zeldzame woorden (bijv. Engelse termen) niet laten overheersen.
  for (const t of terms) t.idf = Math.min(idf(t.df, N), idf(15, N)) * (t.weak ? 0.5 : 1);
  if (!terms.length) {
    const e = new Error("Geen van de zoektermen komt voor in de geselecteerde stukken.");
    e.allTerms = allTerms;
    throw e;
  }

  // 2. Kandidaat-documenten zoeken. Per document houden we bij welke
  //    zoektermen er zeker in voorkomen; de som van hun gewicht bepaalt welke
  //    documenten we daarna helemaal ophalen.
  progress("Documenten zoeken…");
  const selective = terms.filter((t) => t.df < 0.4 * N).sort((a, b) => b.idf - a.idf);
  const pickFrom = selective.length ? selective : [...terms].sort((a, b) => b.idf - a.idf);
  const rare = pickFrom.filter((t) => t.df <= RARE_DF).slice(0, 8);
  const common = pickFrom.filter((t) => t.df > RARE_DF && !t.weak).slice(0, 5);

  const docs = new Map(); // id -> doc
  const known = new Map(); // id -> Set(term)
  const note = (r, ts) => {
    if (!r || r.error) return;
    for (const doc of r.records) {
      docs.set(doc.id, doc);
      if (!known.has(doc.id)) known.set(doc.id, new Set());
      ts.forEach((t) => known.get(doc.id).add(t));
    }
  };
  const jobs = [];
  // a. Zeldzame termen: alle documenten ophalen.
  for (const r of rare) jobs.push({ q: termCql(r), max: r.df, ts: [r] });
  // b. Zeldzame x veelvoorkomende term: welke veelvoorkomende termen staan ook in die documenten?
  for (const r of rare.filter((t) => !t.weak).slice(0, 3)) {
    for (const c of common) jobs.push({ q: `${termCql(r)} AND ${termCql(c)}`, max: r.df, ts: [r, c] });
  }
  // c. Combinaties van veelvoorkomende termen (alle, dan steeds één minder).
  const minLevel = rare.length ? 2 : 1;
  for (let level = common.length; level >= minLevel; level--) {
    const combos = [...combinations(common, level)]
      .map((c) => ({ c, w: c.reduce((s, t) => s + t.idf, 0) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 10);
    for (const { c } of combos) jobs.push({ q: c.map(termCql).join(" AND "), max: 30, ts: c });
  }
  const results = await pool(jobs, 6, (j) => sru(fetchFn, `${base} AND ${j.q}`, j.max));
  results.forEach((r, i) => note(r, jobs[i].ts));

  const cappedIdf = (t) => Math.min(t.idf, idf(5, N));
  const candidates = new Map();
  for (const [id, ts] of known) {
    const qscore = [...ts].reduce((s, t) => s + cappedIdf(t), 0);
    candidates.set(id, { doc: docs.get(id), qscore });
  }

  // Bijlagen zonder XML overslaan.
  let ranked = [...candidates.values()]
    .filter((c) => c.doc.xmlUrl)
    .sort((a, b) => b.qscore - a.qscore || b.doc.date.localeCompare(a.doc.date))
    .slice(0, maxDocs);

  // 3. Teksten ophalen en in passages opdelen.
  let done = 0;
  progress(`Teksten ophalen (0/${ranked.length})…`);
  const texts = await pool(ranked, 6, async ({ doc }) => {
    const res = await fetchWithTimeout(fetchFn, doc.xmlUrl);
    const xml = await res.text();
    progress(`Teksten ophalen (${++done}/${ranked.length})…`);
    return xml;
  });

  progress("Passages rangschikken…");
  const passages = [];
  ranked.forEach(({ doc, qscore }, i) => {
    const xml = texts[i];
    if (typeof xml !== "string") return;
    const ps = blocksToPassages(xmlToBlocks(xml), doc);
    ps.forEach((p, j) => passages.push({ ...p, doc, docScore: qscore, index: j }));
  });
  const avgLen = passages.reduce((s, p) => s + passageTokens(p).length, 0) / Math.max(1, passages.length);
  scorePassages(passages, terms, avgLen || 200);

  // Recentere stukken licht laten voorgaan.
  const now = new Date().getFullYear();
  for (const p of passages) {
    const y = parseInt(p.doc.date.slice(0, 4), 10) || now;
    p.score *= 1 + Math.max(0, 0.15 - 0.03 * (now - y));
  }

  passages.sort((a, b) => b.score - a.score);
  const perDoc = new Map();
  const top = [];
  for (const p of passages) {
    if (p.score <= 0) break;
    const n = perDoc.get(p.doc.id) || 0;
    if (n >= 3) continue;
    perDoc.set(p.doc.id, n + 1);
    top.push(p);
    if (top.length >= (opts.maxPassages || 30)) break;
  }

  return { terms, allTerms, total: N, candidates: ranked.map((r) => r.doc), passages: top };
}
