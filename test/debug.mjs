import { search } from "../js/search.js";
const v = process.argv[2], needle = process.argv[3];
const r = await search(v, {});
console.log(r.terms.map(t => `${t.term}(${t.df})`).join(", "));
console.log("kandidaten:", r.candidates.map(d => d.id).join(" "));
r.passages.slice(0,8).forEach((p,i)=>console.log(i, p.score.toFixed(1), p.doc.id, p.matched.join("+"), "|", (p.question+" "+p.answer).slice(0,200).replace(/\n/g," ")));
