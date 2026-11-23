import { search } from "../js/search.js";
import { pdfToParagraphs } from "../js/pdf.js";
let pdfjs = null;
try { pdfjs = await import(process.env.PDFJS || "pdfjs-dist/legacy/build/pdf.mjs"); } catch { console.log("(pdf.js niet gevonden: PDF's worden overgeslagen)"); }
const v = process.argv[2];
const r = await search(v, { pdfToText: pdfjs ? (d) => pdfToParagraphs(d, pdfjs) : undefined });
console.log(r.terms.map(t => `${t.term}(${t.df})`).join(", "));
console.log("kandidaten:", r.candidates.map(d => d.id).join(" "));
r.passages.slice(0,6).forEach((p,i)=>console.log(i, p.score.toFixed(1), p.doc.id, p.matched.join("+"), "\n   Q:", p.question.slice(0,200), "\n   A:", p.answer.slice(0,300).replace(/\n/g," ")));
