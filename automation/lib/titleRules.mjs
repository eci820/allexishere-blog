// 제목 규칙 — 전 계급 공통. 생성 프롬프트와 초안 검증이 '같은 정의'를 쓰게 하는 단일 소스.
//
// 🔴 여기 한 곳에만 두는 이유: 축(pain point) 목록을 프롬프트와 검증에 따로 적으면
//    반드시 어긋난다. 프롬프트는 "혼잡을 넣어라" 하는데 검증은 '혼잡'을 모르는 식이다.
//    그러면 사람이 경고를 믿지 않게 되고, 경고는 없느니만 못해진다.
//
// ── 공식 ──────────────────────────────────────────────────────────────
//   [주제/대상] + [독자 pain point 2~3개 구체 나열] + [가이드/정리/안내]
//
// 원리: **독자는 "총정리"를 검색하지 않는다.** 구체적인 니즈를 각각 검색한다.
//   "잠실야구장 주차 총정리"로 잡히는 검색어는 사실상 '잠실야구장 주차' 하나뿐이다.
//   pain point 를 나열하면 한 글이 '주차요금'·'주차장 위치'·'혼잡' 세 검색 의도를
//   동시에 잡는다. 제목이 곧 그 글이 답하겠다고 약속하는 질문 목록이다.
//
// 실측 근거: 노출 1위였던 글(호남 반도체 클러스터, 노출 481)의 클릭이 0이었다.
//   노출이 곧 성과가 아니다 — 제목이 구체적 검색 의도에 답하지 않으면 클릭이 안 난다.

// 계급별 pain point 축. 각 주제에서 '실제 검색 수요가 있는' 2~3개를 골라 쓴다.
// keys 는 검증에서 제목·본문 대조에 쓰는 표기 변형 목록이다.
export const PAIN_AXES = {
  parking: {
    label: '🅿️ 주차',
    axes: ['요금', '위치·입구', '혼잡·만차', '할인', '근처 대체'],
    keys: ['요금', '위치', '입구', '혼잡', '만차', '할인', '대체', '근처', '무료', '정산'],
    bad: '잠실야구장 주차 총정리',
    // 🔴 '주차'를 반드시 독립 단어로 둔다. "주차요금·주차장 위치…" 처럼 붙여 쓰면
    //    pain point 나열은 되지만 중복방어 인덱스가 '주차'를 인식하지 못해
    //    같은 시설 글이 또 생성된다(SKILL.md §3). 주차 계급은 이 제약이 우선한다.
    good: '잠실야구장 주차 요금·입구 위치·혼잡 대비 가이드',
  },
  health: {
    label: '💪 건강',
    axes: ['권장량/기준', '시간/타이밍', '부작용/과다', '대상별 차이', '방법'],
    keys: ['권장량', '기준', '시간', '타이밍', '부작용', '과다', '위험', '대상', '방법', '복용', '섭취'],
    bad: '물 마시기 총정리',
    good: '하루 물 권장량·마시는 시간·과다 위험 정리',
  },
  science: {
    label: '🔬 과학·생활원리',
    axes: ['뜻/정의', '종류/차이', '왜 중요한지', '실생활 연결'],
    keys: ['뜻', '정의', '종류', '차이', '왜', '중요', '이유', '원리', '비교', '요금', '전기요금'],
    bad: '반도체란 총정리',
    good: '반도체 뜻·종류·왜 중요한지 쉽게 정리',
  },
  evergreen: {
    label: '🌲 에버그린',
    axes: ['방법', '시간/타이밍', '주의사항', '대상별'],
    keys: ['방법', '시간', '타이밍', '주의', '보관', '복용', '대상', '조건', '기준', '신청'],
    bad: '유산균 총정리',
    good: '유산균 보관법·복용 시간·냉장 여부 안내',
  },
  finance: {
    label: '💰 금융·세금',
    axes: ['조건/자격', '금액/세율', '시기/기한', '신청 방법'],
    keys: ['조건', '자격', '금액', '세율', '한도', '시기', '기한', '신청', '방법', '기준'],
    bad: '연말정산 총정리',
    good: '연말정산 공제 조건·환급 시기·신청 방법 정리',
  },
  realestate: {
    label: '🏠 대출·부동산',
    axes: ['조건/자격', '금리/비용', '한도', '신청 절차'],
    keys: ['조건', '자격', '금리', '비용', '한도', '신청', '절차', '기준', '시기'],
    bad: '전세대출 총정리',
    good: '전세대출 자격 조건·금리 비교·한도 계산 안내',
  },
};

// 약속어만 있고 구체 축이 없는 제목을 잡기 위한 목록.
const PROMISE = ['총정리', '가이드', '정리', '안내', '완벽', '한눈에'];
// 모든 계급의 축 키워드 합집합 — 계급을 모를 때(캡처 등)도 검증할 수 있게.
const ALL_KEYS = [...new Set(Object.values(PAIN_AXES).flatMap((v) => v.keys))];

const norm = (s) => String(s || '').normalize('NFC');

// 제목이 담고 있는 pain point 축의 개수(어휘 기준).
export function countPainPoints(title, source) {
  const t = norm(title);
  const keys = PAIN_AXES[source]?.keys || ALL_KEYS;
  return keys.filter((k) => t.includes(k)).length;
}

// 🔴 나열 '구조'를 따로 센다(2026-07-19 실측으로 추가).
//    어휘 목록만으로 판정했더니 발행글 29편이 오탐이었다:
//      "랜드로버 디스커버리 성능·가격·공간·트림 비교 분석"  ← 4개 나열인데 '일반적' 판정
//      "국회의원 보좌관 역할·연봉·업무·자격 총정리"          ← 4개 나열인데 '일반적' 판정
//    축 목록에 없는 어휘(성능·공간·트림·연봉·업무…)를 못 세기 때문이다.
//    어휘를 무한정 늘리는 건 답이 아니다 — 나열했다는 '형태'를 보면 된다.
//    약속어 앞부분을 구분자로 쪼개 조각 수를 센다.
const SPLIT = /[·•,\/]/;
export function countEnumSegments(title) {
  const t = norm(title)
    .replace(/\([^)]*\)/g, ' ')  // (2026) 같은 괄호는 나열이 아니다
    .replace(/\d{4}/g, ' ');     // 연도도 제외
  const head = PROMISE.reduce((s, p) => s.split(p)[0], t); // 약속어 앞부분만
  return head.split(SPLIT).map((s) => s.trim()).filter((s) => s.length >= 2).length;
}

// ⚠️ 경고 대상인가 — 어휘로도, 형태로도 구체적이지 않을 때만.
// 🔴 차단이 아니라 경고다. 제목은 사람이 판단할 영역이고, 규칙에 안 맞는 좋은 제목도
//    있다("삼성서울병원 주차요금 얼마? 무료 조건 확인 방법"처럼 의문형 등).
//    그래서 판정을 좁게 잡는다 — 오탐이 쌓이면 경고 자체가 무시된다.
export function titleIsGeneric(title, source) {
  const t = norm(title);
  const hasPromise = PROMISE.some((p) => t.includes(p));
  const points = countPainPoints(t, source);
  const segs = countEnumSegments(t);
  // 축 어휘 2개 이상 '또는' 나열 조각 3개 이상이면 구체적으로 본다.
  if (points >= 2 || segs >= 3) return null;
  return {
    points, segs, hasPromise,
    reason: hasPromise
      ? `'${PROMISE.find((p) => t.includes(p))}'만 있고 구체적 pain point 나열이 없습니다`
      : '구체적 pain point 나열이 없습니다',
  };
}

// 🔴 지어내기 금지의 확장: 제목에 넣은 요소는 본문에 실제 내용이 있어야 한다.
//    제목에 '요금'을 약속하고 본문에 요금이 없으면 그건 낚시다.
//    toc(본문 h2 목록)와 대조해 약속만 하고 안 지킨 축을 돌려준다.
export function titleBodyMismatch(title, toc, source) {
  const t = norm(title);
  const sections = (toc || []).map(norm).join(' ');
  if (!sections) return []; // h2 를 못 뽑았으면 판정하지 않는다(오탐 방지)
  const keys = PAIN_AXES[source]?.keys || ALL_KEYS;
  return keys.filter((k) => t.includes(k) && !sections.includes(k));
}

// 🅿️ 자기잠식 방지 — 제목에 '주차'가 독립 단어로 있는가.
//    topicsPool.matchLive 가 제목 단어로 중복을 판정하므로, '주차장'·'주차요금'처럼
//    붙여 쓰면 '주차'로 인식되지 않아 같은 시설 글이 또 생성된다(SKILL.md §3).
//    원래 lib/capture.mjs 에 있었는데, 제목 규칙이므로 여기로 모았다 — 캡처 경로뿐
//    아니라 브리핑·수동 생성 경로도 이 점검을 받아야 하기 때문이다.
export function parkingDedupOk(title) {
  const toks = new Set(
    norm(title).replace(/[^가-힣a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2)
  );
  return toks.has('주차');
}

// 생성 프롬프트에 넣을 계급별 제목 지침.
// source 를 모르면(캡처 등) 공통 공식만 낸다.
export function titleGuideFor(source) {
  const a = PAIN_AXES[source];
  const common =
    `\n\n[제목 공식 — 반드시 따르세요]\n` +
    `  [주제/대상] + [독자 pain point 2~3개 구체 나열] + [가이드/정리/안내]\n` +
    `- 🔴 "총정리"만 붙인 일반적 제목을 쓰지 마세요. 독자는 "총정리"를 검색하지 않습니다.\n` +
    `  구체적 니즈를 각각 검색합니다. pain point 를 나열해야 한 글이 여러 검색 의도를 잡습니다.\n` +
    `- 제목에 나열한 pain point 는 **본문 h2 섹션으로 그대로 이행**하세요.\n` +
    `  (제목이 "권장량·시간·과다"면 본문 h2 도 그 세 가지여야 합니다. 순서도 맞추세요.)\n` +
    `- 🔴 제목에 넣은 요소는 본문에 실제 내용이 있어야 합니다. 확인 못 한 항목은 제목에도 넣지 마세요.\n` +
    `  (제목에 "요금"을 넣고 본문에 요금이 없으면 낚시입니다.)\n`;
  if (!a) return common;
  return (
    common +
    `\n[${a.label} — 이 계급의 pain point 축]\n` +
    `  ${a.axes.join(' · ')}\n` +
    `  → 이 중 '이 주제에서 실제 검색 수요가 있는' 2~3개를 골라 제목에 나열하세요.\n` +
    `  ❌ 나쁜 예: ${a.bad}\n` +
    `  ✅ 좋은 예: ${a.good}\n`
  );
}
