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

// ── 🅿️ 구별 토큰(subject) 판정 — matchLive 'subject' 모드의 단일 소스 ──────────
//
// 왜 필요한가: matchLive 의 기존 규칙은 '토큰 2개 겹침'이라, 주차 글에서 흔한 일반어
//   두 개('주차'+'요금')만으로 무관한 글끼리 걸렸다. 실측(2026-07-25): 코엑스 글 하나가
//   "○○ 주차 요금" 형태의 지역 주제 14곳을 전부 차단했다. 반대로 '세텍 주차장'↔
//   '학여울역 SETEC 주차 요금'은 표기가 달라 겹침이 1개뿐이어서 통과했다(과소차단).
//   → 일반어를 걷어내고 '대상을 가리키는 토큰'이 하나라도 겹치는지로 판정한다.

// 수식어 — 대상이 아니다. 이것만 겹치는 건 중복이 아니다.
// 🔴 '무료주차'(4자)를 빠뜨리면 "여의도 주말 무료주차"가 대구삼성라이온즈파크 글에
//    걸린다(실측). 4자 이상이라 길이 가드를 통과해버리기 때문이다 — 신조어가 생기면
//    반드시 여기 추가할 것. 임계 1 판정은 이 목록의 품질에 민감하다.
export const MODIFIER = new Set([
  '주차', '주차장', '주차요금', '요금', '무료', '무료주차', '근처', '경기일', '콘서트', '공연', '행사',
  '총정리', '가이드', '완벽', '얼마', '기준', '조건', '정리', '방법', '위치', '비교', '최신', '안내',
  '할인', '팁', '꿀팁', '대안', '입구', '시간', '시간대', '정산', '예약', '만차', '혼잡',
  '주말', '평일', '대비',
]);

// 상권 지명 — 2자라도 '대상'으로 인정하는 화이트리스트.
//
// 🔴🔴 광역 지명(대구·서울·부산·인천·대전·광주·울산·경기·강원…)은 절대 넣지 마라.
//    넣는 순간 "대구 DGB대구은행파크"와 "대구 엑스코"가 '대구' 하나로 같은 대상이 되어
//    멀쩡한 새 시설이 차단된다. 이 오탐은 2026-07 첫 판에서 실제로 났고, SKILL.md §3 이
//    기록한 사고다. 오탐이 쌓이면 사람이 경보 자체를 무시하게 되는 게 가장 큰 손실이다.
//    여기 들어갈 수 있는 것은 '그 이름 하나로 상권이 특정되는' 지명뿐이다.
//
// 🔴 여기에는 '접미를 뗀 기본형'만 넣는다. 파생형(연남동·성수역·홍대입구)은 넣지 마라 —
//    아래 canonRegionSuffix 가 만들어 준다. 파생형을 직접 넣으면 REGION 검사가 먼저
//    걸려 절단 단계에 못 가고, 기본형과 파생형이 서로 다른 대상으로 남는다(연남↔연남동
//    실측). 아래 불변식이 이 실수를 로드 시점에 잡는다.
//    ※ '익선동'은 예외가 아니라 '기본형'이다 — 몸통 '익선'은 그 자체로 상권이 아니라서
//      REGION 에 없다. 그래서 '익선동' 통째가 기본형이고, 지우면 대상이 통째로 사라진다.
export const REGION = new Set([
  '경복궁', '덕수궁', '북촌', '홍대', '성수', '가로수길', '명동', '이태원',
  '힙지로', '을지로', '익선동', '연남', '서울숲', '여의도',
]);

// 표기 변형 — 한글↔영문 쌍. 발행글이 "학여울역 SETEC"인데 제안이 "세텍"이면
// 토큰이 하나도 안 겹쳐 그냥은 못 잡는다. curator.mjs 도 이 정의를 참조한다.
export const ALIAS = new Map([
  ['세텍', 'setec'], ['코엑스', 'coex'], ['디디피', 'ddp'],
  ['케이스포돔', 'kspo'], ['케이스포', 'kspo'],
]);

// ── 포함 관계(CONTAINS) — '이름은 다른데 같은 장소' ────────────────────────
//
// ALIAS 와 왜 분리하는가: ALIAS 는 **같은 이름의 다른 표기**를 잇는 1:1 사전이라
//   정확 일치로 충분하다(세텍 = SETEC). 여기는 성격이 다르다 — KSPO돔은 올림픽공원
//   **안에 있는 건물**이고, 이름이 겹치지 않아 정확 일치로는 영영 못 만난다.
//   주차 검색 의도로 보면 같은 대상이므로 부분 문자열로 봐야 잡힌다.
//   두 성격을 한 Map 에 섞으면 '정확일치 사전'에 부분매칭이 스며들어, 나중에
//   무엇이 왜 걸렸는지 설명할 수 없게 된다. 그래서 사전을 나눠 둔다.
//
// 🔴 키에는 '그 조각 하나로 대상이 특정되는' 충분히 긴 문자열만 넣는다.
//    짧은 조각을 넣으면(예: '공원'·'체육관') 무관한 시설이 통째로 한 대상이 되어
//    멀쩡한 새 글감이 영영 차단된다 — 아래 assertDistinctSubjects 가 고정 목록의
//    충돌은 잡아 주지만, 목록 밖 주제까지 지켜 주지는 않는다.
export const CONTAINS = new Map([
  ['kspo', '올림픽공원'],       // KSPO돔(옛 올림픽체조경기장)은 올림픽공원 안이다
  ['케이스포', '올림픽공원'],    // ALIAS 를 안 타는 파생 표기(케이스포아레나 등)까지
  ['올림픽체조', '올림픽공원'],  // 올림픽체조경기장 = KSPO돔의 옛 이름
]);

// 포함 관계 치환은 **한 번만** 한다. 결과를 다시 넣어 돌리면 사전이 커졌을 때
// A→B→C 연쇄가 생겨 무엇이 왜 그 값이 됐는지 추적할 수 없게 된다.
// 여러 키가 걸리면 Map 삽입 순서상 먼저 등재된 것이 이긴다.
function containsCanon(t) {
  for (const [frag, canon] of CONTAINS) if (t.includes(frag)) return canon;
  return t;
}

// ── 접미 정규화 — '여의도 ↔ 여의도역'은 같게, '잠실야구장 ↔ 잠실종합운동장'은 다르게 ──
//
// 문제: 별칭(ALIAS)은 정확 일치만 본다. 그래서 '여의도'와 '여의도역'이 서로 다른 토큰이
//   되어 중복을 못 막았다. 반대로 접미를 함부로 떼면 '잠실야구장'과 '잠실종합운동장'이
//   '잠실' 하나로 뭉개진다 — 이쪽이 훨씬 비싼 사고다(멀쩡한 시설 글이 영영 안 생긴다).
//
// 🔴 그래서 '두 자물쇠'를 건다. 둘 다 만족할 때만 치환한다:
//     ① 꼬리가 LOCATION_SUFFIX 에 있다   ② 남은 몸통이 REGION 에 **정확히** 있다
//   하나라도 실패하면 원본을 그대로 돌려준다(부분 절단 금지). 그래서
//   '성수동물병원'은 성수동물병 → 성수동물 어느 것도 REGION 에 없어 안 깎이고,
//   '충전구역'은 몸통 '충전구'가 REGION 에 없어 안 깎인다. 앵커가 없으면 아무 일도 없다.
const LOCATION_SUFFIX = ['사거리', '입구', '역', '앞', '동']; // 긴 것 우선(입구역 → 입구 먼저)

// 🔴 시설 구분어 — **절대 접미로 취급하지 않는다.** 서로 다른 장소를 가르는 결정적
//    토큰이기 때문이다('야구장' vs '종합운동장'). 이 목록은 깎는 데 쓰지 않는다.
//    오직 아래 불변식이 "위치접미가 시설구분어의 꼬리와 겹치지 않는가"를 검사할 때만 쓴다.
//    예: '점'을 위치접미에 넣으면 '백화점'이 '백화'로 깎인다 → 불변식이 로드 시점에 잡는다.
const FACILITY_KIND = new Set([
  '야구장', '종합운동장', '운동장', '체육관', '경기장', '전시장', '컨벤션', '아레나', '스타디움',
  '돔', '공원', '아트센터', '미술관', '박물관', '공항', '터미널', '시장', '백화점', '병원',
  '대학교', '호텔', '파크', '필드', '센터',
]);

const MAX_STRIP = 2;  // '홍대입구역' → '홍대입구' → '홍대'
const MIN_BASE = 2;   // 몸통은 최소 2자(REGION 최단 항목이 2자)

// 불변식 — 사전을 잘못 늘렸을 때 조용히 뭉개지지 않고 **로드 시점에 죽는다**.
// 조용한 오작동(다른 시설을 같다고 판정)은 몇 주 뒤에나 발견되고, 그때는 이미
// 안 쓰인 글감이 재고에서 소진된 뒤다. 그래서 시끄럽게 실패하는 쪽을 택한다.
for (const f of FACILITY_KIND) {
  const bad = LOCATION_SUFFIX.find((s) => f !== s && f.endsWith(s));
  if (bad) throw new Error(`[titleRules] 위치접미 '${bad}' 가 시설구분어 '${f}' 의 꼬리다 — 시설이 뭉개진다`);
}
for (const r of REGION) {
  for (const s of LOCATION_SUFFIX) {
    if (!r.endsWith(s) || r.length - s.length < MIN_BASE) continue;
    const base = r.slice(0, -s.length);
    if (REGION.has(base)) {
      throw new Error(`[titleRules] REGION 에 '${r}' 와 '${base}' 가 함께 있다 — 파생형은 빼고 기본형 '${base}' 만 남겨라`);
    }
  }
}

// 위치 접미를 떼어 상권 기본형으로 착지시킨다. 착지 못 하면 원본 그대로.
function canonRegionSuffix(w) {
  let cur = w;
  for (let i = 0; i < MAX_STRIP; i++) {
    if (REGION.has(cur)) return cur;
    const s = LOCATION_SUFFIX.find((x) => cur.endsWith(x) && cur.length - x.length >= MIN_BASE);
    if (!s) break;
    cur = cur.slice(0, -s.length);
  }
  return REGION.has(cur) ? cur : w; // 🔴 앵커 실패 → 원본 유지(반쪽짜리 토큰을 만들지 않는다)
}

// 🔴 토큰 정규화의 단일 소스. 별칭과 접미를 여기 한 곳에서만 처리한다.
//    distinctive(제안 키워드 쪽)와 topicsPool.aliasNorm(발행글 쪽)이 **같은 함수**를
//    써야 한다. 한쪽만 정규화하면 '여의도'와 '여의도역'이 여전히 못 만난다.
export function canonToken(w) {
  const l = String(w).toLowerCase();
  let t;
  if (ALIAS.has(l)) t = ALIAS.get(l);      // 별칭 정확일치 우선(세텍 → setec)
  else {
    const r = canonRegionSuffix(l);
    t = ALIAS.get(r) || r;                 // 절단 후 별칭 재확인
  }
  return containsCanon(t);                 // 🔴 포함 관계는 맨 끝에서 딱 한 번
}

// 대상을 가리키는 토큰만 남긴다. 가드는 **3자** — '킨텍스'(3자)를 살리고 '대구'(2자)를
// 떨어뜨리는 경계값이다. 4자로 잡으면 킨텍스가 탈락해 같은 시설 글이 또 생성된다(실측).
// 정규화 결과는 정의상 REGION 원소라 2자여도 이 가드를 통과한다('성수'·'홍대').
export function distinctive(s) {
  const toks = norm(s).toLowerCase()
    .replace(/[^가-힣a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !MODIFIER.has(w) && !/^\d+$/.test(w))
    .map(canonToken)
    .filter((w) => w.length >= 3 || REGION.has(w));
  return [...new Set(toks)];
}

// 🔴 고정 목록 충돌 불변식 — 서로 다른 두 대상이 같은 구별 토큰으로 착지하면
//    **로드 시점에 죽는다.**
//
// 왜 필요한가: 주차 계급의 중복 판정은 구별 토큰 **1개** 겹침이면 차단이다(topicsPool
//   liveDupe). 그래서 사전을 잘못 늘려 두 시설이 한 토큰으로 뭉개지면, 둘 중 하나는
//   "이미 있는 글"로 오인돼 **영영 생성되지 않는다.** 이 고장은 에러를 내지 않는다 —
//   조용히 글감이 사라질 뿐이라, 몇 주 뒤 재고가 마르고 나서야 알아챈다.
//   그때는 이미 되돌릴 시점이 지났다. 그래서 시끄럽게 실패하는 쪽을 택한다.
//
// 규칙 자체(무엇이 충돌인가)는 여기 한 곳에만 두고, 실제 목록을 가진 쪽
// (parking.mjs 의 PARKING_TOPICS)이 로드 때 이 함수를 부른다. 목록을 여기로 가져오면
// titleRules ← topicsPool ← parking 순환 import 가 된다.
export function assertDistinctSubjects(names, where = 'list') {
  const owner = new Map(); // 구별 토큰 → 그 토큰을 처음 차지한 이름
  for (const name of names) {
    for (const tok of distinctive(name)) {
      const prev = owner.get(tok);
      if (prev !== undefined && prev !== name) {
        throw new Error(
          `[titleRules] ${where}: '${prev}' 와 '${name}' 이 같은 구별 토큰 '${tok}' 으로 정규화된다 ` +
          `— 둘 중 하나는 중복으로 오인돼 영영 생성되지 않는다. ALIAS·CONTAINS·REGION 등재를 되돌려라`
        );
      }
      owner.set(tok, name);
    }
  }
  return names.length;
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
