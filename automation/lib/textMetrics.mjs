// 본문 정적 지표 — LLM 0회. '셀 수 있는 것'만 둔다.
//
// 왜 따로 뺐나(2026-11-25): quality-review.mjs(주간 진단)와 lib/harness.mjs(생성 직후 검증)가
// 같은 '출처 없는 수치' 판정을 써야 한다. 두 곳에 따로 적으면 반드시 어긋나고, 어긋난 경고는
// 사람이 믿지 않게 된다(SKILL.md §2 titleRules 와 같은 이유). 정의는 여기 한 곳에만 둔다.

// 출처로 인정하는 표지. 기관명·연도 병기·명시적 출처 표기·링크.
// (운영 원칙: 기관 수치를 쓸 때는 기관명·연도·기준을 병기한다)
export const SOURCE_MARK = /(출처|자료|기준일|참고|고시|보건복지부|식약처|질병관리청|국세청|행정안전부|국토교통부|통계청|기상청|한국소비자원|WHO|FDA|EFSA|KDRIs|NIH|논문|가이드라인|\[[^\]]+\]\(https?:\/\/)/;
// 수치 주장으로 보는 패턴 — 단위가 붙은 숫자. 날짜·목차 번호는 제외하려고 단위를 요구한다.
export const NUMERIC_CLAIM = /\d[\d,.]*\s*(%|퍼센트|mg|g|kg|ml|L|리터|원|만원|억|배|시간|분|초|일|개월|년치|칼로리|kcal|cm|mm|도|℃)/;

// 본문을 문장 단위로 자른다. 표·코드블록은 따로 세므로 여기서 뺀다.
export function proseSentences(body) {
  const noCode = String(body || '').replace(/```[\s\S]*?```/g, '');
  const noTable = noCode.split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n');
  return noTable.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

// 🔴 이 저장소에서 가장 비싼 교훈의 지표.
//    폴더 9(물과 건강)는 출처 없는 구체 수치가 49개였고, 구글이 크롤하고도
//    색인을 거절했다. YMYL 글에서 이 값이 크면 색인 거절의 유력한 설명이 된다.
//
//    ⚠️ 정직하게: 이건 휴리스틱이다. '같은 문장 안에 출처 표지가 없는 수치 문장'을
//    셀 뿐, 문단 위에 출처를 한 번 밝히고 아래에서 수치를 나열한 경우를 과다 계상한다.
//    그래서 리포트는 이 값을 '판정'이 아니라 '확인해 볼 지점'으로 표시한다.
export function unsourcedNumbers(body) {
  const sents = proseSentences(body);
  const claims = sents.filter((s) => NUMERIC_CLAIM.test(s));
  const unsourced = claims.filter((s) => !SOURCE_MARK.test(s));
  return { claims: claims.length, unsourced: unsourced.length, samples: unsourced.slice(0, 2), all: unsourced };
}

// frontmatter·검수 주석을 뗀 본문만.
export function bodyOf(raw) {
  return String(raw).split(/^---\s*$/m).slice(2).join('---').split('<!--')[0].trim();
}

export const h2List = (body) => [...String(body).matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
export const linkCount = (body) => (String(body).match(/\[[^\]]+\]\([^)]+\)/g) || []).length;

// ── English (AU site) — 같은 '출처 없는 수치' 판정의 영어판 ───────────────────
// AU 글은 "unverified — check the official source" 표기와 인라인 URL 을 쓴다(au-generate 규칙).
export const SOURCE_MARK_EN = /(https?:\/\/|\.gov\.au|source|according to|as of|last updated|unverified)/i;
export const NUMERIC_CLAIM_EN = /(?:A?\$\s?\d[\d,.]*|\d[\d,.]*\s*(?:%|per ?cent|km|kms|kilometres|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|metres?|m\b|kg|cents?|AUD))/i;
export function unsourcedNumbersEn(body) {
  const claims = proseSentences(body).filter((s) => NUMERIC_CLAIM_EN.test(s));
  const unsourced = claims.filter((s) => !SOURCE_MARK_EN.test(s));
  return { claims: claims.length, unsourced: unsourced.length, samples: unsourced.slice(0, 2), all: unsourced };
}
