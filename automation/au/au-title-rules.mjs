// 영어 제목 규칙 — 한국 lib/titleRules.mjs 의 이식(영어 기준).
//
// 철학(한국과 동일): 독자는 "총정리(complete guide)"를 검색하지 않는다. 구체적 니즈를
// 각각 검색한다. 제목에 pain point 2~3개를 나열하면 한 글이 여러 검색 의도를 동시에 잡는다.
// 제목은 곧 그 글이 답하겠다고 약속하는 질문 목록이다.
//
// 🔴 단일 소스: 축 정의는 여기 한 곳에만 둔다 — 생성 프롬프트(titleGuideFor)와
//    초안 검증(countPainPoints·titleBodyMismatch)이 같은 정의를 쓰게 하기 위해서다.
//    두 곳에 따로 적으면 반드시 어긋나고, 어긋난 경고는 사람이 안 믿게 되어 없느니만 못하다.

// class 별 pain-point 축. keys = 제목·본문에서 매칭할 소문자 변형들(영어).
export const PAIN_AXES = {
  stadium: {
    label: 'Stadium gameday',
    axes: ['best seats', 'shade & sun', 'roof open/closed', 'getting there (no parking)', 'membership vs GA', 'first-timer'],
    keys: {
      seats: ['seat', 'where to sit', 'best seats', 'section', 'view'],
      shade: ['shade', 'sun', 'sunny', 'afternoon sun', 'cover'],
      roof: ['roof', 'closed roof', 'open roof', 'wet weather'],
      access: ['getting there', 'no parking', 'park', 'transport', 'how to get'],
      membership: ['member', 'membership', 'general admission', 'ga', 'reserve'],
      firsttimer: ['first-timer', 'first time', 'first visit', "what to know"],
    },
    bad: 'MCG guide',
    good: 'MCG: best seats, which side has shade, and members vs GA explained',
  },
  toll: {
    label: 'Toll roads & driving costs',
    axes: ['how to avoid', 'what it costs / who owns', 'eligibility', 'paying without an account', 'notices & disputes', 'visitors & rentals'],
    keys: {
      avoid: ['avoid', 'skip', 'toll-free', 'without tolls', 'no tolls'],
      cost: ['cost', 'how much', 'price', 'who owns', 'real trip'],
      eligibility: ['eligible', 'eligibility', 'who qualifies', 'claim', 'cap', 'rebate', 'relief'],
      noaccount: ['without an account', 'no account', 'casual', 'pass', 'one-off', 'pay online'],
      disputes: ['notice', 'fine', 'dispute', 'unpaid', 'appeal'],
      visitors: ['visitor', 'rental', 'hire car', 'tourist', 'interstate'],
    },
    bad: 'Sydney tolls explained',
    good: 'Sydney tolls: how to actually avoid them, who charges you, and what a real trip costs',
  },
};

// 영어 토큰화 — 소문자 후 영숫자 단위로. (한국 토큰화와 달리 조사·CJK 처리 불필요)
function norm(s) {
  return String(s || '').toLowerCase();
}

// 제목에 나타난 축의 개수 (keys 중 하나라도 걸리면 그 축 1개로 셈).
export function countPainPoints(title, cls) {
  const spec = PAIN_AXES[cls];
  if (!spec) return 0;
  const t = norm(title);
  let n = 0;
  for (const variants of Object.values(spec.keys)) {
    if (variants.some((k) => t.includes(norm(k)))) n++;
  }
  return n;
}

// 나열 구분자로 쪼갠 세그먼트 수(축이 keys 밖이어도 '나열형'인지 구조로 본다).
export function countEnumSegments(title) {
  const before = String(title || '').split(/[:—-]/)[1] ?? String(title || '');
  return before.split(/[·•,/]|(?:\band\b)/i).map((s) => s.trim()).filter(Boolean).length;
}

// 제목이 너무 두루뭉술한가(경고용 — 차단 아님). pain point<2 이고 나열<3 이면 generic.
export function titleIsGeneric(title, cls) {
  return countPainPoints(title, cls) < 2 && countEnumSegments(title) < 3;
}

// 🔴 제목이 약속한 축이 본문(h2 목록)에 있는가. 없으면 그 축은 '낚시'다.
// toc = 본문 h2 텍스트 배열. 반환 = 제목엔 있는데 본문엔 없는 축 이름 목록.
export function titleBodyMismatch(title, toc, cls) {
  const spec = PAIN_AXES[cls];
  if (!spec) return [];
  const t = norm(title);
  const body = (toc || []).map(norm).join(' \n ');
  const missing = [];
  for (const [axis, variants] of Object.entries(spec.keys)) {
    const inTitle = variants.some((k) => t.includes(norm(k)));
    if (!inTitle) continue;
    const inBody = variants.some((k) => body.includes(norm(k)));
    if (!inBody) missing.push(axis);
  }
  return missing;
}

// 생성 프롬프트에 넣을 제목 가이드 — 위 축 정의에서 조립(단일 소스).
export function titleGuideFor(cls) {
  const spec = PAIN_AXES[cls];
  if (!spec) return '';
  return [
    `TITLE RULE (${spec.label}):`,
    `- Do NOT write a generic "guide"/"complete guide" title. List 2–3 concrete pain points the reader actually searches.`,
    `- Choose from these axes: ${spec.axes.join(' · ')}.`,
    `- ❌ bad:  "${spec.bad}"`,
    `- ✅ good: "${spec.good}"`,
    `- 🔴 Every pain point you put in the title MUST become an H2 in the body (same wording). Don't promise what you don't deliver.`,
    `- Use Australian English (colour, centre, kerb), AUD $, dd/mm/yyyy.`,
  ].join('\n');
}
