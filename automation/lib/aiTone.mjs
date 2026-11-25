// 🗣 AI 문체 린트 — LLM 0회, 결정론적.
//
// 왜: 2026-07 이후 자동 생성 글이 쌓이면서 GSC 주간 노출이 900대 → 한 자릿수로 무너졌다
//     (data/perf-history.json, 2026-11 실측 주 3~8회). 원인을 하나로 단정할 수는 없지만,
//     같은 틀·같은 말투로 찍어낸 글은 구글의 '대량 생성 콘텐츠' 판정과 독자 이탈 양쪽에서
//     불리하다. 그래서 초안마다 'AI 같아 보이는 정도'를 셀 수 있는 지표로 잰다.
//
// 근거: korean-skills/humanizer (KatFishNet, arXiv 2503.00032 — 쉼표 패턴 94.88% AUC 등)
//       + 그 스킬의 경험 패턴(번역투·상투 결말). 등급 규칙도 그 스킬의 자연도 등급을 따른다:
//         A: S1 0 + S2 ≤ 2 · B: S1 1~2 또는 S2 3~5 · C: S1 3+ 또는 S2 6+ · D: S1 5+ 그리고 S2 8+
//
// ⚠️ 정직한 한계: 정규식 휴리스틱이다. 형태소 분석(품사 다양성·띄어쓰기 경직성)은 하지 않는다.
//    '이 글은 AI 가 썼다'를 판정하는 도구가 아니라, 고칠 문장을 찾아 주는 도구다.
//    그래서 결과는 수정 단계(lib/harness.mjs)의 입력과 카드 경고로만 쓴다 — 발행을 막지 않는다.

import { proseSentences } from './textMetrics.mjs';

// S1 — 한 번만 나와도 강한 신호(상투 도입·결말, 이중 피동).
const S1 = [
  [/결론적으로/g, '결론적으로'],
  [/요약하(?:자면|면)/g, '요약하면'],
  [/(?:알아|살펴)보(?:겠습니다|도록 하겠습니다|ㄹ게요|볼게요)/g, '알아보겠습니다(상투 도입)'],
  [/(?:알아|살펴)(?:보았|봤)습니다/g, '살펴봤습니다(상투 맺음)'],
  [/되어지(?:다|는|며|고|면|게)|되어집니다|되어졌/g, '되어지다(이중 피동)'],
  [/시사하는 바/g, '시사하는 바'],
  [/주목할 만(?:한|합니다|하다)/g, '주목할 만하다'],
  [/도움이 되(?:셨|었)?(?:길|기를|으면) 바랍니다|도움이 되셨(?:길|기를|으면)/g, '도움이 되길 바랍니다(AI 맺음)'],
  [/(?:이번|이) 글에서는/g, '이 글에서는(상투 도입)'],
  [/^#{2,3}\s*(?:마무리하며|마치며|맺음말)\s*$/gm, '마무리하며(상투 소제목)'],
  // 출처 없는 '다수 경험담' — 문체 문제이자 지어내기(SKILL.md §4). 실측: 사직야구장 글
  // "…도착해야 여유 있다는 게 자주 다니는 관람객들의 공통된 경험입니다".
  [/(?:관람객|이용자|방문객|운전자|사람|분)들?(?:의|이) (?:공통된|공통적인|대체적인) (?:경험|의견|후기|평가)/g, '출처 없는 다수 경험담'],
  [/(?:많은|대부분의) (?:분|이용자|관람객|방문객|사람)들이 (?:추천|선호|이용|말)/g, '출처 없는 다수 경험담'],
];

// S2 — 1~2회는 자연스럽다. 임계 이상 반복될 때만 신호.
const S2 = [
  [/에 대해(?:서)?/g, '~에 대해', 3],
  [/[을를] 통해(?:서)?/g, '~을 통해', 3],
  [/에 있어(?:서)?/g, '~에 있어서', 2],
  [/[와과] 관련(?:하여|해서|된)/g, '~와 관련하여', 3],
  [/가지고 있(?:습니다|다|는|어)/g, '가지고 있다(영어식 소유)', 2],
  [/다양한/g, '다양한', 3],
  [/효과적(?:인|으로)/g, '효과적인', 2],
  [/중요(?:합니다|한 것은|한 점은)/g, '중요합니다', 3],
  [/핵심적|필수적/g, '핵심적·필수적', 2],
  [/할 수 있습니다/g, '~할 수 있습니다(가능 표현 남발)', 6],
  [/것입니다/g, '~것입니다(단정 어미 남발)', 4],
  [/(?:^|[.!?]\s+)(?:또한|더불어|아울러|뿐만 아니라|따라서|그러므로),?\s/gm, '또한·따라서(접속사 과다)', 5],
  [/[^,\n]{1,20}, [^,\n]{1,20}, (?:그리고|및) /g, 'A, B, 그리고 C(3박자 나열)', 2],
  // 이 블로그 생성글에서 실측된 안전 문구 반복(2026-11 사직야구장·문학경기장 초안).
  [/확인하(?:는 (?:것이|편이)|시는 게) (?:좋습니다|안전합니다|바람직합니다)|확인하시기 바랍니다|참고하시기 바랍니다/g, '~확인하는 편이 안전합니다(안전 문구 반복)', 3],
  [/(?:고려|검토)할 만합니다|고려해 볼 수 있습니다/g, '고려할 만합니다', 2],
  [/달라질 수 있(?:습니다|어|으니|으므로)|변동될 수 있(?:습니다|어|으니|으므로)/g, '달라질 수 있습니다(면피 반복)', 3],
  [/(?:^|[.!?]\s+)다만,?\s/gm, '다만(단서 반복)', 3],
];

// 린트 대상 본문 — 표·제목·코드·인용(면책 문구)·링크 주소를 뺀 서술문.
function prose(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*>/.test(l))
    .join('\n')
    .replace(/\]\([^)]*\)/g, ']');
}

const snip = (s, at, len = 38) => {
  const a = Math.max(0, at - 12);
  return s.slice(a, a + len).replace(/\s+/g, ' ').trim();
};

export function lintAiTone(body) {
  const text = prose(body);
  const noHead = text.split('\n').filter((l) => !/^#/.test(l)).join('\n');
  const findings = [];

  for (const [re, label] of S1) {
    const src = /\^/.test(re.source) ? text : noHead;
    const hits = [...src.matchAll(re)];
    if (hits.length) findings.push({ sev: 'S1', label, count: hits.length, samples: hits.slice(0, 2).map((m) => snip(src, m.index)) });
  }
  for (const [re, label, limit] of S2) {
    const hits = [...noHead.matchAll(re)];
    if (hits.length >= limit) findings.push({ sev: 'S2', label, count: hits.length, samples: hits.slice(0, 2).map((m) => snip(noHead, m.index)) });
  }

  // ── 구조 지표 ──
  const sents = proseSentences(noHead).filter((s) => s.length >= 6 && !/^[-*\d]/.test(s));
  const n = sents.length || 1;
  const commaRate = sents.filter((s) => s.includes(',')).length / n; // AI 61% vs 사람 26% (KatFishNet)
  const lens = sents.map((s) => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const lenCV = mean ? sd / mean : 0; // 낮을수록 문장 리듬이 단조롭다
  const formalRate = sents.filter((s) => /니다[.!?]?$/.test(s)).length / n;
  let maxRun = 0, run = 0, prev = '';
  for (const s of sents) {
    // 어미 끝 3글자(합니다/됩니다/입니다/습니다…)로 비교한다. 2글자면 모든 -습니다체가 '니다'로 같아진다.
    const end = (s.replace(/[.!?。]+$/, '').match(/(\S{3})$/) || [])[1] || '';
    run = end && end === prev ? run + 1 : 1;
    prev = end;
    if (run > maxRun) maxRun = run;
  }
  const bold = (String(body).match(/\*\*[^*\n]+\*\*/g) || []).length;
  const lines = String(body).split('\n').filter((l) => l.trim());
  const listRate = lines.filter((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l)).length / (lines.length || 1);
  const emoji = (noHead.match(/\p{Extended_Pictographic}/gu) || []).length;

  if (sents.length >= 15) {
    if (commaRate > 0.45) findings.push({ sev: 'S2', label: `쉼표 과다(문장의 ${Math.round(commaRate * 100)}%에 쉼표)`, count: 1, samples: sents.filter((s) => (s.match(/,/g) || []).length >= 2).slice(0, 2).map((s) => s.slice(0, 38)) });
    if (lenCV < 0.35) findings.push({ sev: 'S2', label: `문장 길이 단조로움(변동계수 ${lenCV.toFixed(2)})`, count: 1, samples: [] });
    if (maxRun >= 5) findings.push({ sev: 'S3', label: `같은 어미 ${maxRun}문장 연속`, count: 1, samples: [] });
    if (formalRate > 0.95) findings.push({ sev: 'S3', label: `-습니다체 ${Math.round(formalRate * 100)}% (어투 변화 없음)`, count: 1, samples: [] });
  }
  if (bold > 8) findings.push({ sev: 'S3', label: `굵게 강조 ${bold}곳`, count: bold, samples: [] });
  if (listRate > 0.4) findings.push({ sev: 'S3', label: `목록 줄 비율 ${Math.round(listRate * 100)}%`, count: 1, samples: [] });
  if (emoji > 2) findings.push({ sev: 'S3', label: `본문 이모지 ${emoji}개`, count: emoji, samples: [] });

  const s1 = findings.filter((f) => f.sev === 'S1').reduce((a, f) => a + f.count, 0);
  const s2 = findings.filter((f) => f.sev === 'S2').length;
  const s3 = findings.filter((f) => f.sev === 'S3').length;
  // S3 는 단독으론 약하지만 겹치면 결정적이다(humanizer 규칙) → S3 두 개를 S2 하나로 친다.
  const s2e = s2 + Math.floor(s3 / 2);
  const grade = s1 >= 5 && s2e >= 8 ? 'D' : s1 >= 3 || s2e >= 6 ? 'C' : s1 >= 1 || s2e >= 3 ? 'B' : 'A';

  return {
    grade, s1, s2, s3, findings,
    metrics: { sentences: sents.length, commaRate: +commaRate.toFixed(2), lenCV: +lenCV.toFixed(2), formalRate: +formalRate.toFixed(2), maxSameEnding: maxRun, bold, listRate: +listRate.toFixed(2) },
  };
}

// 등급 비교용(A 가 가장 좋다).
export const gradeRank = (g) => ({ A: 0, B: 1, C: 2, D: 3 })[g] ?? 3;

// 카드·프롬프트용 한 줄 요약.
export function toneSummary(r, max = 4) {
  if (!r) return '';
  const top = [...r.findings].sort((a, b) => a.sev.localeCompare(b.sev)).slice(0, max).map((f) => f.label + (f.count > 1 ? `×${f.count}` : ''));
  return `${r.grade}${top.length ? ' — ' + top.join(', ') : ''}`;
}
