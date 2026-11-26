// 🧪 작성 → 검사 → 검증 → 수정 하네스 (2026-11-25 신설).
//
// 왜: 생성 엔진(generate.mjs)은 'CLI 1회 호출 → 짧으면 보강'뿐이라, 글을 다른 눈으로 다시
//     보는 단계가 없었다. 실측 사고 두 가지가 이 구멍에서 나왔다.
//       · 사직야구장 글: "자주 다니는 관람객들의 공통된 경험입니다" — 출처 없는 다수 경험담
//       · 요금 수치를 2차 블로그에서만 확인하고 그대로 본문에 씀(riskNotes 에만 남음)
//     그리고 2026-11 GSC 주간 노출이 한 자릿수로 무너졌다. 같은 틀·같은 말투로 찍어낸 글은
//     구글(대량 생성 콘텐츠)·네이버(어뷰징·C-Rank) 양쪽에서 불리하다.
//
// 단계:
//   ① 검사(LLM 0회)  — AI 문체(lib/aiTone.mjs) · 출처 없는 수치(lib/textMetrics.mjs) · SEO 형태
//   ② 검증(LLM 1회)  — 편집장·팩트체커 역할. 고치지 않고 판정만(JSON). WebSearch 로 핵심 수치 확인.
//   ③ 수정(LLM 0~1회) — 지적이 있을 때만. 없는 숫자를 만들지 않는다(삭제·완화·출처 있는 정정만).
//   ④ 재검사(LLM 0회) + 안전장치 — 수정본이 구조를 망가뜨리거나 더 나빠지면 버리고 원본 유지.
//
// 🔴 하네스는 발행하지 않는다. 결과(report)를 돌려줄 뿐이고, 발행 여부는
//    사람의 [✅승인] 또는 autopilot 의 품질 관문(passesGate)이 정한다.
// 🔴 실패해도 생성을 막지 않는다 — 검증 단계가 죽으면 그 사실을 report.errors 에 남기고
//    관문은 자동으로 '불통과'가 된다(사람 검수로 넘어감). 조용히 통과시키지 않는다.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runClaude, unwrapClaudeJSON } from './claudeCli.mjs';
import { lintAiTone, gradeRank, toneSummary } from './aiTone.mjs';
import { lintAiToneEn } from './aiToneEn.mjs';
import { unsourcedNumbers, unsourcedNumbersEn, h2List, linkCount } from './textMetrics.mjs';

// 🌏 언어 스위치(2026-11-26 AU 확장) — lang 이 'en' 이면 영어 검사기·영어 프롬프트. 없으면 한국어(기존 그대로).
const LINT = (b, lang) => (lang === 'en' ? lintAiToneEn(b) : lintAiTone(b));
const NUM = (b, lang) => (lang === 'en' ? unsourcedNumbersEn(b) : unsourcedNumbers(b));
import { titleBodyMismatch, parkingDedupOk } from './titleRules.mjs';

// ── claude CLI 공용 호출(구독·stdin) ───────────────────────────────
// generate.mjs 의 4개 호출부(생성·보강·수정·갱신)가 execFile 에 프롬프트를 '인자'로 넘기던 것을
// 이 하나로 모은다. 인자로 넘기면 실패 메시지에 프롬프트 전문이 실려 사유가 묻힌다(SKILL.md §6).
export async function claudeText(prompt, { model, timeoutSec = 240, tools = ['WebSearch'] } = {}) {
  const extraArgs = [];
  if (model) extraArgs.push('--model', model);
  if (tools && tools.length) extraArgs.push('--allowedTools', tools.join(',')); // 가변 인자라 맨 뒤
  const out = await runClaude(prompt, { cwd: os.tmpdir(), timeoutMs: timeoutSec * 1000, extraArgs });
  return unwrapClaudeJSON(out); // { result, costUsd }
}
export const stripFence = (t) => String(t || '').trim().replace(/^```(?:markdown|md|json)?\s*/i, '').replace(/```\s*$/, '').trim();

function parseJSONLoose(text) {
  let t = stripFence(text);
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('JSON 없음');
  return JSON.parse(t.slice(s, e + 1));
}

// ── ① SEO 형태 검사(LLM 0회) — 구글·네이버 공통 ─────────────────────
// 셀 수 있는 것만. "SEO 가 약하다" 같은 주관 판정은 ② 검증 단계의 몫이다.
const nospace = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const GENERIC_KW = new Set(['방법', '정리', '총정리', '가이드', '2026', '뜻', '이유', '기준', '비교']);
const EN_STOP = new Set(['how', 'to', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'is', 'what', 'when', 'where', 'why', 'do', 'does', 'can', 'you', 'your', 'vs', 'guide', 'australia']);
export function seoChecks({ title, description, body }, keyword, lang) {
  const EN = lang === 'en';
  const issues = [];
  const toks = String(keyword || '').split(/\s+/).filter((w) => w.length >= 2 && !(EN ? EN_STOP.has(w.toLowerCase()) : GENERIC_KW.has(w)));
  const subject = toks[0] || '';
  const T = nospace(title);
  const missing = toks.filter((w) => !T.includes(nospace(w)));
  if (missing.length) issues.push({ key: 'title-kw', msg: `제목에 검색어 '${missing.join(' ')}' 없음` });
  if (subject && T.indexOf(nospace(subject)) > (EN ? 30 : 12)) issues.push({ key: 'title-front', msg: `핵심어 '${subject}'가 제목 앞쪽에 없음` });
  const tl = [...String(title || '')].length;
  if (tl > (EN ? 65 : 45)) issues.push({ key: 'title-long', msg: `제목 ${tl}자 — 검색결과에서 잘림(${EN ? 65 : 45}자 이내 권장)` });
  const dl = [...String(description || '')].length;
  if (dl < (EN ? 70 : 50) || dl > (EN ? 160 : 155)) issues.push({ key: 'desc-len', msg: `설명문 ${dl}자(50~155자 권장)` });
  if (subject && !nospace(description).includes(nospace(subject))) issues.push({ key: 'desc-kw', msg: '설명문에 핵심어 없음' });
  const firstPara = (String(body).split(/\n\s*\n/).find((p) => p.trim() && !/^\s*[#|>!]/.test(p)) || '').trim();
  if (subject && !nospace(firstPara).includes(nospace(subject))) issues.push({ key: 'lead-kw', msg: '첫 문단에 핵심어 없음(두괄식 답 필요)' });
  const h2 = h2List(body);
  if (h2.length < 3) issues.push({ key: 'h2-few', msg: `소제목(h2) ${h2.length}개 — 검색 의도 하위 질문이 부족` });
  if (h2.length > 9) issues.push({ key: 'h2-many', msg: `소제목(h2) ${h2.length}개 — 지나치게 잘게 쪼갬` });
  if (toks.length && !h2.some((h) => toks.some((w) => nospace(h).includes(nospace(w)))))
    issues.push({ key: 'h2-kw', msg: '소제목 어디에도 검색어 단어가 없음' });
  if (subject) {
    const n = (nospace(body).match(new RegExp(nospace(subject).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const per1k = n / Math.max(1, String(body).length / 1000);
    if (per1k > 9) issues.push({ key: 'stuffing', msg: `핵심어 반복 과다(1천 자당 ${per1k.toFixed(1)}회 — 네이버 어뷰징 필터 위험)` });
  }
  return issues;
}

// ── ② 검증(LLM 1회) ─────────────────────────────────────────────
function verifyPrompt(d, keyword, opts, lint, seo, num, serp, lang) {
  if (lang === 'en') return verifyPromptEn(d, keyword, lint, seo, num, serp);
  return `당신은 한국어 정보 블로그의 편집장이자 팩트체커입니다. 아래 초안을 검수합니다.
🔴 글을 고치지 마세요. 판정만 JSON 으로 출력합니다. 지적은 반드시 본문에 '그대로 있는 문장'을 인용하세요.

[검색어] ${keyword}
[계급] ${opts.source || 'manual'}
[제목] ${d.title}
[설명문] ${d.description}

[검수 기준]
1. 사실 — 요금·수치·기준·날짜·제도 주장 중 핵심 3~5개를 WebSearch 로 확인하세요(공식 기관·운영처 우선).
   틀렸으면 action "correct" + 확인된 값 + 출처 URL. 공식 근거를 못 찾았으면 "soften"(현장·공식 확인 필요로 완화)
   또는 "delete". 🔴 출처 URL 없이 새 숫자를 제안하지 마세요.
   '많은 이용자들의 경험' 같은 출처 없는 다수 경험담·체험담은 지어낸 것이므로 delete.
2. 검색 의도 — 이 검색어로 들어온 사람이 알고 싶은 것을 1줄로 적고, 본문이 답하지 않는 하위 질문을 적으세요.
   (구글: 사람을 위한 글·정보 이득 / 네이버: 질문에 대한 직접 답·원본성)
3. 정보 이득 — 어느 대상에나 붙는 일반론("미리 확인하는 것이 좋습니다" 류)만 있고 이 대상 고유 정보가 없는 문장.
4. AI 문체 — AI 가 쓴 티가 나는 문장(상투 도입·맺음, 번역투, 면피 문구 반복, 기계적 3박자 나열, 같은 리듬) 최대 8개.
5. 사람다움 점수 1~10 (10 = 그 분야를 직접 확인한 사람이 쓴 글처럼 읽힘).
6. verdict — 사실 오류·지어낸 경험담·검색 의도 미충족이 하나라도 있으면 "revise", 사소한 문체만이면 "pass".

${serp && serp.mustCover && serp.mustCover.length ? `[상위 노출 글들이 공통으로 답하는 질문 — 본문이 답하지 않으면 intentGaps 에 넣을 것]\n${serp.mustCover.map((q) => '- ' + q).join('\n')}\n[상위 글이 놓친 점 — 본문이 하나도 채우지 못했으면 seo 에 '정보 이득 없음'으로]\n${(serp.gaps || []).map((q) => '- ' + q).join('\n')}\n\n` : ''}[코드 검사 결과(참고)]
- AI 문체 등급: ${toneSummary(lint, 6)}
- SEO 형태: ${seo.length ? seo.map((x) => x.msg).join(' / ') : '이상 없음'}
- 출처 표지 없는 수치 문장 ${num.unsourced}개${num.samples.length ? ': ' + num.samples.map((s) => `"${s.slice(0, 50)}"`).join(', ') : ''}

[본문]
${d.body}

아래 JSON 하나만 출력(코드펜스·설명 금지):
{"verdict":"pass|revise","intent":"...","intentGaps":["..."],"facts":[{"quote":"...","problem":"...","action":"delete|soften|correct","correct":"","source":""}],"filler":["..."],"aiSentences":[{"quote":"...","why":"..."}],"seo":["..."],"humanScore":7}`;
}

function sanitizeVerdict(v, body) {
  const inBody = (q) => q && body.includes(String(q).trim().slice(0, 25));
  const arr = (x) => (Array.isArray(x) ? x : []);
  const facts = arr(v.facts).filter((f) => f && inBody(f.quote)).map((f) => ({
    quote: String(f.quote).trim(), problem: String(f.problem || ''),
    // 출처 없는 정정은 정정으로 인정하지 않는다 — 완화로 내린다(지어내기 금지 §4).
    action: f.action === 'correct' && !/^https?:\/\//.test(String(f.source || '')) ? 'soften' : ['delete', 'soften', 'correct'].includes(f.action) ? f.action : 'soften',
    correct: String(f.correct || ''), source: String(f.source || ''),
  }));
  return {
    verdict: v.verdict === 'pass' ? 'pass' : 'revise',
    intent: String(v.intent || '').slice(0, 160),
    intentGaps: arr(v.intentGaps).map(String).slice(0, 5),
    facts,
    filler: arr(v.filler).map(String).filter(inBody).slice(0, 6),
    aiSentences: arr(v.aiSentences).filter((a) => a && inBody(a.quote)).slice(0, 8),
    seo: arr(v.seo).map(String).slice(0, 5),
    humanScore: Math.max(1, Math.min(10, Number(v.humanScore) || 5)),
    // 인용이 본문에 없어 버린 지적 수 — 검증자가 지어낸 지적을 걸러냈다는 기록.
    droppedQuotes: arr(v.facts).length - facts.length + arr(v.aiSentences).filter((a) => !(a && inBody(a.quote))).length,
  };
}

// ── ③ 수정(LLM 1회) ─────────────────────────────────────────────
function revisePrompt(d, keyword, lint, seo, v, minChars, lang) {
  if (lang === 'en') return revisePromptEn(d, keyword, lint, seo, v, minChars);
  const L = [];
  if (v) {
    for (const f of v.facts) L.push(`- [사실/${f.action}] "${f.quote}" — ${f.problem}` + (f.action === 'correct' ? ` → 확인된 값: ${f.correct} (출처 ${f.source})` : ''));
    for (const q of v.filler) L.push(`- [일반론·물타기] "${q}" — 이 대상 고유 정보로 바꾸거나 삭제`);
    for (const a of v.aiSentences) L.push(`- [AI 문체] "${a.quote}" — ${a.why}`);
    for (const g of v.intentGaps) L.push(`- [검색 의도 누락] ${g} — 확인 가능한 정보로만 답할 것(확인 못 하면 '공식 확인 필요'로)`);
    for (const s of v.seo) L.push(`- [SEO] ${s}`);
  }
  for (const f of lint.findings.filter((x) => x.sev !== 'S3' || x.samples.length)) L.push(`- [문체 패턴] ${f.label}${f.samples.length ? ' 예: "' + f.samples[0] + '"' : ''}`);
  for (const s of seo) L.push(`- [SEO 형태] ${s.msg}`);
  if (minChars && d.body.length < minChars * 0.9) L.push(`- [분량] 현재 약 ${d.body.length}자, 목표 ${minChars}자 이상 — 물타기 없이 실질 정보로 보강(WebSearch 로 확인한 것만)`);

  return `아래 블로그 초안을 '검수 지적'에 따라 고쳐 쓰세요. 검색어: ${keyword}

[고치는 원칙]
- 🔴 없는 숫자·사실·경험담을 만들지 마세요. 사실 지적은 action 대로만: delete=문장 삭제, soften=단정을 빼고 "공식 안내·현장 확인 필요"로, correct=주어진 값과 출처만 사용.
- 직접 방문·체험한 척하지 마세요("가보니", "직접 써보니" 금지). 확인 과정은 "운영처 안내 기준으로는"처럼 출처로 드러냅니다.
- h2 소제목의 개수·순서·의미는 유지(표현은 다듬어도 됨). GFM 표·마크다운 링크·🗺 지도 링크 줄은 그대로 둡니다.
- 사람이 쓴 글처럼: 문장 길이를 섞고(짧은 문장도 쓰기), 같은 어미 3번 연속 금지, -습니다체에 -요체를 가끔 섞어도 됩니다.
  쉼표는 한 문장에 1개 이하. "이 글에서는·알아보겠습니다·결론적으로·도움이 되셨길" 같은 상투 표현 삭제.
  "~에 대해·~을 통해·~할 수 있습니다·확인하는 것이 좋습니다·달라질 수 있습니다"는 꼭 필요한 곳에만.
- 첫 문단 1~2문장 안에 검색어에 대한 직접 답을 둡니다. 핵심 검색어는 제목 앞쪽·첫 문단·소제목 1곳에 자연스럽게(억지 반복 금지).
- 제목은 검색어가 빠졌거나 45자를 넘을 때만 고칩니다. 🅿️ 주차 글이면 '주차'를 띄어쓴 독립 단어로 유지.

[검수 지적]
${L.join('\n') || '- (지적 없음 — 문체만 다듬기)'}

[현재 제목] ${d.title}
[현재 설명문] ${d.description}
[현재 본문]
${d.body}

아래 JSON 하나만 출력(코드펜스·설명 금지). body 는 frontmatter 없는 전체 본문 마크다운:
{"title":"...","description":"...","body":"...","changes":["무엇을 왜 고쳤는지 짧게"]}`;
}

// ── 🇦🇺 English prompts (AU site) — same JSON contract as the Korean ones ──────────
function verifyPromptEn(d, keyword, lint, seo, num, serp) {
  return `You are the editor and fact-checker of an Australian (en-AU) information blog. Review the draft below.
🔴 Do NOT rewrite it. Output a verdict as JSON only. Every issue must quote a sentence that appears VERBATIM in the body.

[Search query] ${keyword}
[Title] ${d.title}
[Meta description] ${d.description}

[Checks]
1. Facts — verify 3–5 key prices/rules/times/dates with WebSearch (official .gov.au, operator, venue or manufacturer pages first).
   Wrong → action "correct" with the verified value and source URL. No official confirmation found → "soften" (state it must be
   checked with the official source) or "delete". 🔴 Never propose a new number without a source URL.
   Invented crowd testimony ("many locals swear by…", "fans agree…") is fabricated → delete.
2. Search intent — one line on what someone typing this query wants; list sub-questions the body does not answer.
   (Google: people-first content and information gain.)
3. Information gain — sentences that are generic filler and would fit any topic ("it's always best to check ahead").
4. AI tone — up to 8 sentences that read machine-written (stock openers/closers, "delve/landscape/tapestry", hedging stacks,
   rule-of-three lists, em-dash chains, heavy bold, uniform rhythm).
5. humanScore 1–10 (10 = reads like a knowledgeable local who checked the official sources).
6. verdict — "revise" if any factual error, fabricated testimony or unmet search intent; "pass" if only minor style.
${serp && serp.mustCover && serp.mustCover.length ? `\n[Questions the top-ranking pages all answer — if the body misses one, add it to intentGaps]\n${serp.mustCover.map((q) => '- ' + q).join('\n')}\n[What the top pages miss — if the body fills none, add "no information gain" to seo]\n${(serp.gaps || []).map((q) => '- ' + q).join('\n')}\n` : ''}
[Code checks (reference)]
- AI-tone grade: ${toneSummary(lint, 6)}
- SEO shape: ${seo.length ? seo.map((x) => x.msg).join(' / ') : 'ok'}
- Number sentences without a source marker: ${num.unsourced}${num.samples.length ? ': ' + num.samples.map((s) => `"${s.slice(0, 60)}"`).join(', ') : ''}

[Body]
${d.body}

Output ONE JSON object only (no code fence, no commentary):
{"verdict":"pass|revise","intent":"...","intentGaps":["..."],"facts":[{"quote":"...","problem":"...","action":"delete|soften|correct","correct":"","source":""}],"filler":["..."],"aiSentences":[{"quote":"...","why":"..."}],"seo":["..."],"humanScore":7}`;
}

function revisePromptEn(d, keyword, lint, seo, v, minChars) {
  const L = [];
  if (v) {
    for (const f of v.facts) L.push(`- [fact/${f.action}] "${f.quote}" — ${f.problem}` + (f.action === 'correct' ? ` → verified value: ${f.correct} (source ${f.source})` : ''));
    for (const q of v.filler) L.push(`- [filler] "${q}" — replace with a fact specific to this subject, or delete`);
    for (const a of v.aiSentences) L.push(`- [AI tone] "${a.quote}" — ${a.why}`);
    for (const g of v.intentGaps) L.push(`- [intent gap] ${g} — answer only with verifiable information; otherwise say it must be checked with the official source`);
    for (const s of v.seo) L.push(`- [SEO] ${s}`);
  }
  for (const f of lint.findings.filter((x) => x.sev !== 'S3' || x.samples.length)) L.push(`- [style] ${f.label}${f.samples.length ? ' e.g. "' + f.samples[0] + '"' : ''}`);
  for (const s of seo) L.push(`- [SEO shape] ${s.msg}`);
  if (minChars && d.body.length < minChars * 0.9) L.push(`- [length] body is ~${d.body.length} chars; expand with real, verified information only (no padding)`);
  return `Rewrite the Australian (en-AU) blog draft below according to the review notes. Search query: ${keyword}

[Rules]
- 🔴 Never invent numbers, facts or experiences. Fact notes: delete = remove the sentence; soften = drop the claim and say to check the
  official source; correct = use only the given value and source.
- Don't pretend to have visited or tried anything ("when I went…"). Show checking through sources ("per Transport for NSW…").
- Keep the H2 sections (count, order, meaning), markdown tables, all markdown links and gmap: links, the FAQ and the "Sources & last updated" list.
- Sound like a knowledgeable local, not a brochure: vary sentence length (some short), avoid three-item lists, no "delve/landscape/tapestry/
  in conclusion/whether you're…/hope this helps". Em-dashes: at most 3 in the whole piece (use full stops, commas or brackets).
  Bold: at most 5. Australian spelling (colour, centre, kerb), A$ for money, dd/mm/yyyy dates.
- Answer the query directly in the first 1–2 sentences. Put the core search phrase early in the title, in the first paragraph and in one H2, naturally.
- Change the title only if the search phrase is missing or it exceeds 65 characters. No "(2026)" tail habit.

[Review notes]
${L.join('\n') || '- (no notes — light style polish only)'}

[Current title] ${d.title}
[Current description] ${d.description}
[Current body]
${d.body}

Output ONE JSON object only (no code fence). "body" is the full markdown body without frontmatter:
{"title":"...","description":"...","body":"...","changes":["what changed and why, briefly"]}`;
}

// ── ④ 안전장치 — 수정본을 받아들일지 ───────────────────────────────
function acceptRevision(before, after, ctx) {
  const why = [];
  if (!after.body || after.body.length < before.body.length * 0.65) why.push(`본문이 ${before.body.length}→${(after.body || '').length}자로 과도하게 줄었다`);
  const h2b = h2List(before.body), h2a = h2List(after.body || '');
  if (h2a.length < h2b.length - 1) why.push(`소제목 ${h2b.length}→${h2a.length}개(구조 훼손)`);
  if (linkCount(after.body || '') < linkCount(before.body)) why.push('링크가 사라졌다'); // restoreLinks 후에도 부족할 때만
  if (ctx.tableIssues && ctx.tableIssues(after.body || '').length > ctx.tableIssues(before.body).length) why.push('표 문법이 깨졌다');
  if (titleBodyMismatch(after.title, h2a, ctx.source).length > titleBodyMismatch(before.title, h2b, ctx.source).length) why.push('제목 약속과 소제목이 어긋났다');
  if ((/주차/.test(before.title) || ctx.source === 'parking') && parkingDedupOk(before.title) && !parkingDedupOk(after.title)) why.push("제목의 '주차' 독립 단어가 사라졌다(자기잠식 방어)");
  // 2개까지는 허용 — 수정 단계가 검색 의도 누락을 메우며 수치 문장이 늘 수 있고, 지어낸 수치는
  // 뒤의 재채점(사실 검증)이 다시 잡는다. 실측 2026-11-26: 1개 증가로 수정본을 버려 관문 불통과.
  if (NUM(after.body || '', ctx.lang).unsourced > NUM(before.body, ctx.lang).unsourced + 2) why.push('출처 없는 수치 문장이 2개 넘게 늘었다');
  if (gradeRank(LINT(after.body || '', ctx.lang).grade) > gradeRank(LINT(before.body, ctx.lang).grade)) why.push('AI 문체 등급이 나빠졌다');
  return why;
}

// 수정본이 빠뜨린 마크다운 링크(관련 글·지도 등)를 되살린다. 실측 2026-11-26(자동차 배터리):
// 관련 글 링크 한 줄이 빠져 수정본 전체를 버렸다 — 링크 하나 때문에 개선 전체를 잃는 건 손해다.
function restoreLinks(beforeBody, afterBody) {
  const links = (s) => String(s).match(/\[[^\]]+\]\([^)]+\)/g) || [];
  const have = new Set(links(afterBody).map((l) => l.replace(/^\[[^\]]+\]/, '')));
  const lost = links(beforeBody).filter((l) => !have.has(l.replace(/^\[[^\]]+\]/, '')));
  if (!lost.length) return afterBody;
  // 원본에서 링크가 있던 줄(문장)을 그대로 가져온다 — 링크만 뚝 떼면 맥락 없는 줄이 된다.
  const lines = String(beforeBody).split('\n');
  const add = [...new Set(lost.map((l) => lines.find((x) => x.includes(l)) || l))];
  return String(afterBody).trimEnd() + '\n\n' + add.join('\n\n');
}

// ── 본체 ─────────────────────────────────────────────────────────
// draft: { title, description, body, ... } (generate.mjs 의 파싱 결과, 제자리 수정하지 않음)
// ctx: { keyword, opts, config, minChars, tableIssues }
// return: { draft(최종), report }
export async function runHarness(draft, ctx) {
  const cfg = (ctx.config && ctx.config.harness) || {};
  const model = cfg.model || (ctx.config && ctx.config.cliModel);
  const timeoutSec = cfg.timeoutSeconds || 300;
  const t0 = Date.now();
  const report = { version: 1, keyword: ctx.keyword, source: ctx.opts?.source || 'manual', errors: [], costUsd: 0, revised: false };

  let d = { ...draft };
  const lint0 = LINT(d.body, ctx.lang), seo0 = seoChecks(d, ctx.keyword, ctx.lang), num0 = NUM(d.body, ctx.lang);
  report.before = { tone: lint0.grade, toneLine: toneSummary(lint0), seo: seo0.map((x) => x.msg), unsourced: num0.unsourced, chars: d.body.length };

  // ② 검증
  let v = null;
  if (cfg.verify !== false) {
    try {
      const r = await claudeText(verifyPrompt(d, ctx.keyword, ctx.opts || {}, lint0, seo0, num0, ctx.serp, ctx.lang), { model, timeoutSec });
      report.costUsd += r.costUsd;
      v = sanitizeVerdict(parseJSONLoose(r.result), d.body);
      report.verify = { verdict: v.verdict, humanScore: v.humanScore, intent: v.intent, intentGaps: v.intentGaps, facts: v.facts, filler: v.filler.length, aiSentences: v.aiSentences.length, seo: v.seo, droppedQuotes: v.droppedQuotes };
    } catch (e) {
      report.errors.push(`검증 실패(${e.kind || 'error'}): ${String(e.message).slice(0, 120)}`);
    }
  }

  // ③ 수정 — 지적이 있을 때만
  const short = ctx.minChars && d.body.length < ctx.minChars * 0.9;
  const needRevise = (v && (v.verdict === 'revise' || v.facts.length || v.aiSentences.length >= 3 || v.filler.length))
    || lint0.grade !== 'A' || seo0.length > 0 || short;
  const maxRev = cfg.maxRevisions ?? 1;
  if (needRevise && maxRev > 0) {
    try {
      const r = await claudeText(revisePrompt(d, ctx.keyword, lint0, seo0, v, ctx.minChars, ctx.lang), { model, timeoutSec });
      report.costUsd += r.costUsd;
      const o = parseJSONLoose(r.result);
      const cand = { ...d, title: String(o.title || d.title).trim(), description: String(o.description || d.description).trim(), body: stripFence(o.body || '') };
      cand.body = restoreLinks(d.body, cand.body);
      const reject = acceptRevision(d, cand, { source: ctx.opts?.source, tableIssues: ctx.tableIssues, lang: ctx.lang });
      if (reject.length) {
        report.rejected = reject;
      } else {
        d = cand;
        report.revised = true;
        report.changes = Array.isArray(o.changes) ? o.changes.map(String).slice(0, 8) : [];
      }
    } catch (e) {
      report.errors.push(`수정 실패(${e.kind || 'error'}): ${String(e.message).slice(0, 120)}`);
    }
  }

  // ④ 재검사(LLM 0회)
  const lint1 = LINT(d.body, ctx.lang), seo1 = seoChecks(d, ctx.keyword, ctx.lang), num1 = NUM(d.body, ctx.lang);
  report.after = { tone: lint1.grade, toneLine: toneSummary(lint1), seo: seo1.map((x) => x.msg), unsourced: num1.unsourced, chars: d.body.length };
  // 검증자가 지적한 사실 문제 중 수정본에 여전히 남은 인용 — 관문 판정에 쓴다.
  report.openFacts = v ? v.facts.filter((f) => d.body.includes(f.quote.slice(0, 25))).map((f) => f.quote.slice(0, 60)) : [];

  // ⑤ 수정본 재채점(LLM 1회) — 관문은 '발행될 글'을 봐야 한다.
  //    실측(2026-11-26 문학경기장 초안): 원본 사람다움 4/10 → 수정 후 문체 B→A 인데, 관문이 원본 점수로
  //    판정해 불통과했다. 원본 점수로 거르면 수정 단계가 있으나 마나다. 재수정은 하지 않는다(1회 상한).
  const rescore = async () => {
    const l = LINT(d.body, ctx.lang), s = seoChecks(d, ctx.keyword, ctx.lang), n = NUM(d.body, ctx.lang);
    const r = await claudeText(verifyPrompt(d, ctx.keyword, ctx.opts || {}, l, s, n, ctx.serp, ctx.lang), { model, timeoutSec });
    report.costUsd += r.costUsd;
    const v2 = sanitizeVerdict(parseJSONLoose(r.result), d.body);
    report.final = { verdict: v2.verdict, humanScore: v2.humanScore, facts: v2.facts, intentGaps: v2.intentGaps, aiSentences: v2.aiSentences.length, filler: v2.filler.length };
    // 🔴 수정본이 있으면 '남은 사실 지적'은 재채점 결과로만 센다. 원본 인용의 앞 25자가 남았는지로
    //    세면, '완화'로 고친 문장도 앞부분이 같아 남은 것으로 오탐된다(실측 2026-11-26 결로·전기장판).
    report.openFacts = v2.facts.map((f) => f.quote.slice(0, 60));
    return v2;
  };
  if (report.revised && cfg.verify !== false && cfg.reverify !== false) {
    try {
      let v2 = await rescore();
      // 🛟 2차 수정 — 아깝게 떨어진 글(재채점 5~6점 또는 사실 지적 남음)만 재채점 지적으로 한 번 더 고친다.
      const min = (cfg.gate && cfg.gate.minHumanScore) || 6;
      if ((maxRev >= 2) && (v2.humanScore < min + 1 || v2.facts.length) && v2.humanScore >= 5) {
        const r2 = await claudeText(revisePrompt(d, ctx.keyword, LINT(d.body, ctx.lang), seoChecks(d, ctx.keyword, ctx.lang), v2, ctx.minChars, ctx.lang), { model, timeoutSec });
        report.costUsd += r2.costUsd;
        const o2 = parseJSONLoose(r2.result);
        const cand2 = { ...d, title: String(o2.title || d.title).trim(), description: String(o2.description || d.description).trim(), body: restoreLinks(d.body, stripFence(o2.body || '')) };
        const reject2 = acceptRevision(d, cand2, { source: ctx.opts?.source, tableIssues: ctx.tableIssues, lang: ctx.lang });
        if (reject2.length) report.rejected2 = reject2;
        else {
          const prevFinal = report.final;
          d = cand2;
          report.revisions = 2;
          report.changes = [...(report.changes || []), ...(Array.isArray(o2.changes) ? o2.changes.map(String).slice(0, 5) : [])];
          v2 = await rescore();
          report.final.prev = { humanScore: prevFinal.humanScore, facts: prevFinal.facts.length };
        }
      }
    } catch (e) {
      report.errors.push(`재채점 실패(${e.kind || 'error'}): ${String(e.message).slice(0, 120)}`);
    }
    const lint2 = LINT(d.body, ctx.lang), seo2 = seoChecks(d, ctx.keyword, ctx.lang), num2 = NUM(d.body, ctx.lang);
    report.after = { tone: lint2.grade, toneLine: toneSummary(lint2), seo: seo2.map((x) => x.msg), unsourced: num2.unsourced, chars: d.body.length };
  }
  report.ms = Date.now() - t0;
  return { draft: d, report };
}

// ── 자동 발행 품질 관문 ─────────────────────────────────────────────
// 🔴 autopilot 이 '사람 대신' 발행해도 되는지의 유일한 판정. 하나라도 걸리면 사람 검수로.
//    엄격하게 둔다 — 통과 못 한 글은 버려지지 않고 초안 카드로 가므로 손실이 없다.
export function passesGate(report, extra = {}, cfg = {}) {
  const g = { minHumanScore: 7, maxTone: 'B', ...(cfg.gate || {}) };
  const why = [];
  if (report.errors.length) why.push('하네스 단계 실패: ' + report.errors[0]);
  // 수정본이 있으면 수정본 재채점(final)으로, 없으면 원본 검증(verify)으로 판정한다.
  const judged = report.revised ? report.final : report.verify;
  if (!judged) why.push(report.revised ? '수정본 재채점을 거치지 않음' : '검증 단계를 거치지 않음');
  else {
    if (judged.humanScore < g.minHumanScore) why.push(`사람다움 ${judged.humanScore}/10 < ${g.minHumanScore}`);
    // 수정본 재채점의 'revise'는 대개 공식 자료가 없어 채울 수 없는 의도 누락이다(실측 2026-11-26:
    // 문학경기장 — 운영시간·결제수단 등). 그건 지어내지 말라는 원칙대로 '확인 필요'로 둔 결과라 막지 않는다.
    // 사실 문제는 openFacts 로, 품질은 humanScore 로 따로 거른다.
    if (!report.revised && judged.verdict === 'revise') why.push('검증자가 수정 요구했으나 수정본이 채택되지 않음');
  }
  if (report.openFacts && report.openFacts.length) why.push(`사실 지적 ${report.openFacts.length}건이 본문에 남음`);
  if (gradeRank(report.after.tone) > gradeRank(g.maxTone)) why.push(`AI 문체 등급 ${report.after.tone}`);
  const hardSeo = report.after.seo.filter((m) => /제목에 검색어|첫 문단에 핵심어|반복 과다/.test(m));
  if (hardSeo.length) why.push('SEO: ' + hardSeo.join(', '));
  for (const w of extra.warnings || []) why.push(w);
  return { pass: why.length === 0, why };
}

// ── 카드·주석용 문구 ─────────────────────────────────────────────
export function harnessCardLine(rep) {
  if (!rep) return '';
  const v = rep.verify;
  const parts = [`문체 ${rep.before.tone}→${rep.after.tone}`, `SEO 지적 ${rep.before.seo.length}→${rep.after.seo.length}`];
  if (v) {
    const c = { delete: 0, soften: 0, correct: 0 };
    for (const f of v.facts) c[f.action]++;
    if (v.facts.length) parts.push(`사실 지적 ${v.facts.length}(삭제${c.delete}·완화${c.soften}·정정${c.correct})`);
    parts.push(`사람다움 ${v.humanScore}${rep.final ? '→' + rep.final.humanScore : ''}/10`);
  }
  parts.push(rep.revised ? '1회 수정 반영' : rep.rejected ? '수정본 폐기' : '수정 없음');
  let s = `🧪 하네스: ${parts.join(' · ')}`;
  if (rep.rejected) s += `\n   ↳ 수정본 폐기 사유: ${rep.rejected.join(', ')}`;
  if (rep.errors.length) s += `\n⚠️ 하네스 오류: ${rep.errors.join(' / ')} — 사람 검수 필수`;
  if (rep.openFacts?.length) s += `\n⚠️ 남은 사실 지적: ${rep.openFacts.map((q) => `"${q.slice(0, 30)}…"`).join(', ')}`;
  if (rep.after.seo.length) s += `\n⚠️ SEO: ${rep.after.seo.join(' / ')}`;
  return s;
}

export function harnessComment(rep) {
  if (!rep) return '';
  const L = [`[하네스] ${harnessCardLine(rep).replace(/\n/g, ' ')}`];
  if (rep.verify?.intent) L.push(`검색 의도: ${rep.verify.intent}`);
  if (rep.verify?.intentGaps?.length) L.push(`의도 누락(검증 시점): ${rep.verify.intentGaps.join(' / ')}`);
  for (const f of rep.verify?.facts || []) L.push(`사실(${f.action}): "${f.quote.slice(0, 50)}" — ${f.problem}${f.source ? ' ' + f.source : ''}`);
  for (const c of rep.changes || []) L.push(`수정: ${c}`);
  return L.join('\n').replace(/-->/g, '—>');
}

export function logHarness(stateDir, slug, rep, gate) {
  try {
    fs.appendFileSync(path.join(stateDir, 'harness-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), slug, gate, ...rep }) + '\n');
  } catch (e) { console.error('[harness] 로그 기록 실패:', e.message); }
}

// ── 단독 실행: 기존 초안 파일로 하네스를 시험(파일·텔레그램 무변경) ─────────
//   node automation/lib/harness.mjs --file <index.md> --keyword "검색어" [--source parking] [--no-llm] [--out 수정본.md]
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
  const file = arg('--file');
  if (!file) { console.error('사용: --file <index.md> --keyword "검색어"'); process.exit(2); }
  const raw = fs.readFileSync(file, 'utf8');
  const fm = (k) => (raw.match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, 'm')) || [])[1] || '';
  const { bodyOf } = await import('./textMetrics.mjs');
  const draft = { title: fm('title'), description: fm('description'), body: bodyOf(raw) };
  const keyword = arg('--keyword') || draft.title.split(/\s+/).slice(0, 2).join(' ');
  const { loadConfig } = await import('./env.mjs');
  const config = loadConfig();
  if (process.argv.includes('--no-llm')) config.harness = { ...(config.harness || {}), verify: false, maxRevisions: 0 };
  const { draft: out, report } = await runHarness(draft, { keyword, opts: { source: arg('--source') }, config, minChars: 0 });
  console.log(JSON.stringify(report, null, 1));
  console.log('\n' + harnessCardLine(report));
  console.log('\n관문:', JSON.stringify(passesGate(report, {}, config.harness || {})));
  if (arg('--out')) { fs.writeFileSync(arg('--out'), `# ${out.title}\n\n> ${out.description}\n\n${out.body}\n`); console.log('수정본 →', arg('--out')); }
}
