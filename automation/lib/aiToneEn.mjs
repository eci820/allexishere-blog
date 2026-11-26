// 🗣 English AI-tone lint (for the AU site) — LLM 0 calls, deterministic. (2026-11-26)
//
// Same contract as lib/aiTone.mjs (Korean): it finds sentences to fix, it does not "detect AI".
// Grade rules mirror the Korean one: A: S1 0 + S2 ≤ 2 · B: S1 1–2 or S2 3–5 · C: S1 3+ or S2 6+ · D: S1 5+ and S2 8+
// Patterns: widely observed LLM tells in English prose (stock openers/closers, "delve/tapestry/landscape"
// vocabulary, hedging stacks, connective overuse, rule-of-three lists, em-dash overuse, uniform rhythm).
// ⚠️ Honest limit: regex heuristics, not a classifier. Used only as revision input + gate signal.

import { proseSentences } from './textMetrics.mjs';

const S1 = [
  [/\b(?:in today'?s (?:fast-paced|digital|modern) (?:world|age|landscape))/gi, "in today's fast-paced world"],
  [/\b(?:let'?s (?:dive|delve) (?:in|into)|dive into|delve into|delves into)\b/gi, 'delve/dive into'],
  [/\b(?:in conclusion|to sum up|in summary|all in all)\b/gi, 'in conclusion (stock closer)'],
  [/\b(?:whether you'?re a [^,.]{1,40} or a [^,.]{1,40})/gi, "whether you're an X or a Y"],
  [/\b(?:this (?:comprehensive|ultimate|definitive) guide|our (?:comprehensive|ultimate) guide)\b/gi, 'this comprehensive guide'],
  [/\b(?:hope (?:this|you found this) (?:helps|was helpful)|happy (?:travels|driving|shopping)!)/gi, 'hope this helps (AI sign-off)'],
  [/\b(?:it'?s worth noting that|it is important to note that|it'?s important to remember that)\b/gi, "it's worth noting that"],
  [/\b(?:a testament to|rich tapestry|tapestry of|navigat(?:e|ing) the (?:complex|ever-changing) (?:world|landscape))\b/gi, 'tapestry/testament/navigate the landscape'],
  [/\b(?:many (?:locals|fans|drivers|visitors|people) (?:swear by|agree|say|recommend))\b/gi, 'unsourced crowd testimony'],
];

const S2 = [
  [/\b(?:additionally|furthermore|moreover)\b/gi, 'additionally/furthermore/moreover', 3],
  [/\b(?:crucial|essential|vital|pivotal|paramount)\b/gi, 'crucial/essential/vital', 4],
  [/\b(?:seamless(?:ly)?|robust|leverage|elevate|unlock|empower)\b/gi, 'seamless/robust/leverage/unlock', 2],
  [/\b(?:landscape|realm|journey|ecosystem)\b/gi, 'landscape/realm/journey', 2],
  [/\b(?:may|might|could) (?:potentially|possibly)\b/gi, 'stacked hedging', 2],
  [/\b(?:it'?s (?:always )?(?:best|a good idea|wise) to (?:check|confirm)|be sure to check|always check)\b/gi, 'check-the-official-site filler', 3],
  [/\b(?:can vary|may vary|subject to change)\b/gi, 'may vary (hedge repetition)', 3],
  [/\b\w+, \w+(?: \w+)?, and \w+\b/g, 'rule-of-three lists', 4],
];
// 실측(2026-11-26, AU 발행글 15편): em-dash 16~39개·굵게 12~57곳 — 둘 다 영어 AI 글의 대표 흔적이다.
// 한 번의 S2 로만 치면 전부 A 가 나와 쓸모가 없어서, 양에 따라 S1 까지 올린다.
const DASH_S2 = 6, DASH_S1 = 12, BOLD_S2 = 10, BOLD_S1 = 20;

function prose(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*>/.test(l))
    .join('\n')
    .replace(/\]\([^)]*\)/g, ']');
}
const snip = (s, at, len = 60) => s.slice(Math.max(0, at - 15), Math.max(0, at - 15) + len).replace(/\s+/g, ' ').trim();

export function lintAiToneEn(body) {
  const text = prose(body);
  const noHead = text.split('\n').filter((l) => !/^#/.test(l)).join('\n');
  const findings = [];
  for (const [re, label] of S1) {
    const hits = [...noHead.matchAll(re)];
    if (hits.length) findings.push({ sev: 'S1', label, count: hits.length, samples: hits.slice(0, 2).map((m) => snip(noHead, m.index)) });
  }
  for (const [re, label, limit] of S2) {
    const hits = [...noHead.matchAll(re)];
    if (hits.length >= limit) findings.push({ sev: 'S2', label, count: hits.length, samples: hits.slice(0, 2).map((m) => snip(noHead, m.index)) });
  }
  const sents = proseSentences(noHead).filter((s) => s.split(/\s+/).length >= 4 && !/^[-*\d]/.test(s));
  const n = sents.length || 1;
  const lens = sents.map((s) => s.split(/\s+/).length);
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const lenCV = mean ? sd / mean : 0;
  const starts = {};
  for (const s of sents) { const w = (s.match(/^\W*(\w+)/) || [])[1]?.toLowerCase(); if (w) starts[w] = (starts[w] || 0) + 1; }
  const topStart = Object.entries(starts).sort((a, b) => b[1] - a[1])[0];
  const bold = (String(body).match(/\*\*[^*\n]+\*\*/g) || []).length;
  const lines = String(body).split('\n').filter((l) => l.trim());
  const listRate = lines.filter((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l)).length / (lines.length || 1);
  const emoji = (noHead.replace(/📍/g, '').match(/\p{Extended_Pictographic}/gu) || []).length;
  if (sents.length >= 15) {
    if (lenCV < 0.35) findings.push({ sev: 'S2', label: `uniform sentence length (CV ${lenCV.toFixed(2)})`, count: 1, samples: [] });
    if (topStart && topStart[1] / n > 0.2 && !['the', 'a'].includes(topStart[0])) findings.push({ sev: 'S3', label: `${Math.round((topStart[1] / n) * 100)}% of sentences start with "${topStart[0]}"`, count: 1, samples: [] });
  }
  const dashes = (noHead.match(/—/g) || []).length;
  if (dashes >= DASH_S1) findings.push({ sev: 'S1', label: `em-dash ×${dashes} (use commas, full stops or brackets)`, count: 1, samples: [] });
  else if (dashes >= DASH_S2) findings.push({ sev: 'S2', label: `em-dash ×${dashes}`, count: 1, samples: [] });
  if (bold >= BOLD_S1) findings.push({ sev: 'S1', label: `bold ×${bold} (keep to ≤5)`, count: 1, samples: [] });
  else if (bold >= BOLD_S2) findings.push({ sev: 'S2', label: `bold ×${bold}`, count: 1, samples: [] });
  if (listRate > 0.45) findings.push({ sev: 'S3', label: `list lines ${Math.round(listRate * 100)}%`, count: 1, samples: [] });
  if (emoji > 2) findings.push({ sev: 'S3', label: `emoji ×${emoji}`, count: emoji, samples: [] });

  const s1 = findings.filter((f) => f.sev === 'S1').reduce((a, f) => a + f.count, 0);
  const s2 = findings.filter((f) => f.sev === 'S2').length;
  const s3 = findings.filter((f) => f.sev === 'S3').length;
  const s2e = s2 + Math.floor(s3 / 2);
  const grade = s1 >= 5 && s2e >= 8 ? 'D' : s1 >= 3 || s2e >= 6 ? 'C' : s1 >= 1 || s2e >= 3 ? 'B' : 'A';
  return { grade, s1, s2, s3, findings, metrics: { sentences: sents.length, lenCV: +lenCV.toFixed(2), bold, listRate: +listRate.toFixed(2) } };
}
