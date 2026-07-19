// 색인 상태 분류 — seo-watch(발견·색인 감시)와 quality-review(품질 진단)가 함께 쓴다.
//
// 🔴 여기 있는 이유: quality-review 가 seo-watch 에서 scanPosts 를 가져다 쓰므로,
//    seo-watch 가 거꾸로 quality-review 를 import 하면 순환 참조가 된다.
//    두 에이전트가 '같은 기준'으로 판정해야 리포트가 어긋나지 않으므로 공용 lib 으로 둔다.
//
// ── 왜 뭉뚱그리면 안 되는가(2026-07-19 전수 검사) ─────────────────────
// 미색인 글은 한 덩어리가 아니다. 세 종류이고 처방이 정반대다.
//
//   ① rejected   "크롤링됨 - 현재 색인이 생성되지 않음"
//      구글이 본문을 읽고 나서 색인을 만들지 않았다. 품질이 설명이 될 수 있는
//      유일한 경우다(→ quality-review 의 갱신 제안 대상).
//   ② discovered "발견됨 - 현재 색인이 생성되지 않음"
//      주소만 알고 아직 크롤을 안 했다. 본문을 고쳐도 소용없다 — 읽지 않은 글을
//      고쳐 봐야 읽지 않은 글일 뿐이다.
//   ③ unknown    "Google에는 아직 알려지지 않은 URL입니다"
//      발견조차 안 됐다. 사이트맵·내부 링크·크롤 예산의 영역이지 품질이 아니다.
//
// 실측: 미색인 20편을 뭉뚱그려 품질 사유를 붙였더니, 구글이 읽지도 않은 13편을
// 고치라는 리포트가 나왔다. 그래서 판정을 이 한 곳으로 모았다.
export function classifyIndex(coverageState) {
  const s = String(coverageState || '');
  if (/크롤링됨/.test(s)) return 'rejected';
  if (/발견됨/.test(s)) return 'discovered';
  if (/알려지지 않은|not known|unknown/i.test(s)) return 'unknown';
  return 'other';
}

export const CLASS_LABEL = {
  rejected: '크롤 후 색인 거절',
  discovered: '발견됐으나 크롤 안 됨',
  unknown: '구글이 주소를 모름',
  other: '기타',
};

// 상태별 한 줄 처방 — 리포트에서 "그래서 뭘 하라는 건가"를 사람이 매번 되묻지 않게.
export const CLASS_ACTION = {
  rejected: '본문 품질이 설명 가능 — 갱신 검토 대상(품질 검토자 담당)',
  discovered: '구글이 아직 안 읽음 — 본문 수정은 무의미, 크롤을 기다린다',
  unknown: '발견 전 — 사이트맵에 있으면 대개 시간이 해결한다',
  other: '분류되지 않음 — coverageState 원문을 확인',
};

// 색인 지연(3~14일)을 감안한 판정 유예. 이 전의 미색인은 실패가 아니라 '아직'이다.
export const INDEX_GRACE_DAYS = 14;
// 이 이상 '미발견'이면 단순 대기로 보기 어렵다 — 발견 경로를 의심할 구간.
export const UNKNOWN_ALERT_DAYS = 30;
