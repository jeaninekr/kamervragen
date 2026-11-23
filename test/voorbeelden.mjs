import { search, extractTerms } from "../js/search.js";
import { pdfToParagraphs } from "../js/pdf.js";
// Voor PDF's (recente stukken) is pdfjs-dist nodig: npm install pdfjs-dist@4.4.168
let pdfjs = null;
try { pdfjs = await import(process.env.PDFJS || "pdfjs-dist/legacy/build/pdf.mjs"); } catch { console.log("(pdfjs-dist niet geïnstalleerd: PDF's worden overgeslagen)"); }
const vragen = [
  "Waarom zijn cryptoactiva, zoals gedefinieerd in de Markets in Crypto Asset Regulation en onze eigen Wet financieel toezicht (Wft), niet opgenomen in de vermogenswinstbelasting als financiële instrumenten?",
  "het lid Van Eijk heeft verzoek gedaan om duidelijkheid over de mogelijkheid van gegevenslevering van banken per 2028.",
  "De leden van de 50plus-fractie vragen naar de fluctuaties in inkomen uit een stelsel gebaseerd op werkelijk rendement tegenover een forfaitair stelsel.",
  "De leden van de JA21-fractie vragen wat de eventuele gevolgen van de carry-back zullen zijn in een brede vermogenswinstbelasting.",
  "De leden van de fractie van D66 constateren dat voor het begrip financieel instrument grotendeels wordt aangesloten bij de Wet op het financieel toezicht (Wft), maar dat de novelle dit begrip voor box 3 op onderdelen uitbreidt. Deze leden vragen of grensgevallen kunnen ontstaan en welke risico’s dit oplevert.",
  "De leden van de D66-fractie, CU-fractie en de PRO-fractie vragen naar de aannames over het realisatie gedrag die ten grondslag liggen aan de raming en de gevoeligheid op de raming als deze verwachtte bezitsduur hoger ligt.",
];
const only = process.argv[2] ? [vragen[+process.argv[2]]] : vragen;
for (const v of only) {
  const t0 = Date.now();
  console.log("\n=== " + v.slice(0, 90));
  console.log("termen:", extractTerms(v).map(t => t.term).join(", "));
  const r = await search(v, { pdfToText: pdfjs ? (d) => pdfToParagraphs(d, pdfjs) : undefined });
  console.log("gewogen:", r.terms.map(t => `${t.term}(${t.df})`).join(", "), "| kandidaten", r.candidates.length, "|", (Date.now()-t0)/1000+"s");
  for (const p of r.passages.slice(0, 4)) {
    console.log(`- [${p.score.toFixed(1)}] ${p.doc.id} ${p.doc.date} ${p.doc.subtype} | ${p.doc.title.slice(0,70)}`);
    console.log("    Q:", (p.question||"").slice(0,160).replace(/\n/g," "));
    console.log("    A:", (p.answer||"").slice(0,220).replace(/\n/g," "));
  }
}
