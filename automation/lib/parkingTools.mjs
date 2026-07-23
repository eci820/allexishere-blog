// 🅿️ 주차 글 인터랙티브 도구 배정 레지스트리 — 도구가 심어진 발행글의 단일 소스.
//
// 🔴 왜 parking.mjs 가 아니라 여기인가(= mapLink 의 LINKABLE_FACILITIES 를 따로 뺀 이유와 동일):
//    · parking.mjs 의 PARKING_TOPICS 는 '무엇을 새로 쓸까' 목록이다. 여기에 시설을 넣으면
//      봇이 그 시설 글을 '또 쓰자'고 제안한다(자기잠식). 도구가 심긴 글은 오히려 그 반대다.
//    · 그래서 '도구가 심긴 시설'은 PARKING_TOPICS 와 물리적으로 다른 파일에 둔다.
//
// 🔴 이 도구들은 stripping 위험이 없다(2026-07-23 확인):
//    · 삽입 방식이 '본문 한 줄'이 아니라 'frontmatter 한 줄 + 템플릿 렌더'다.
//    · 갱신/수정(generate.mjs 의 editDraft·refreshPublished)은 frontmatter(fm)를 verbatim 보존하고
//      LLM 은 body 만 재작성한다 → parkingCalc / parkingCompare 는 갱신을 타도 살아남는다.
//    (본문에 링크를 심던 mapLink 와 달리 90일 쿨다운 같은 방어가 필요 없다.)
//
// 🔴 재제안 위험도 없다:
//    · A(계산기)는 이미 데이터 구동이다 — generate.mjs 가 src/data/parking/*.json 을 읽어
//      신규 M1 글에 자동 부착한다. 여기 4개 시설은 전부 이미 발행돼 PARKING_TOPICS 에서 제외돼 있다.
//    · C(비교표)는 봇 자동 로직이 없다(사람이 frontmatter 로 부착). 확산 시 이 파일을 소스로 삼는다.
//
// ⚠️ 현재 이 모듈은 봇이 import 하지 않는다(= 순수 레지스트리·문서). 그래서 이 파일을 만들거나
//    고쳐도 봇 재시작이 필요 없다. 나중에 curator/refresh 의 '재제안 제외'에 쓰려고 import 하면
//    그때는 automation/ 모듈 수정이므로 봇 재시작이 필요하다.

// 도구 종류
//  · 'calc'    → 주차요금 계산기   (src/components/ParkingCalculator.astro + src/data/parking/*.json)
//  · 'compare' → 요금·거리 비교표   (src/components/ParkingCompare.astro   + src/data/parking-compare/*.json)
export const PARKING_TOOLS = [
  // 시설            slug   도구        데이터 파일                              검증 출처 / 확인일
  { facility: '킨텍스',        slug: '69', tool: 'calc',    data: 'src/data/parking/kintex.json',          source: 'kintex.com 공식 자차/주차 (2026-07-10)' },
  { facility: '고양종합운동장', slug: '96', tool: 'calc',    data: 'src/data/parking/goyang-stadium.json',   source: '고양도시관리공사 gys.or.kr (2026-06)' },
  { facility: '코엑스',        slug: '76', tool: 'compare', data: 'src/data/parking-compare/coex.json',      source: '본문 게재 수치(이관글) — 현장 확인 우선' },
  { facility: 'SETEC',        slug: '81', tool: 'compare', data: 'src/data/parking-compare/setec.json',     source: '본문 게재 수치(이관글) — 현장 확인 우선' },
  // C 비교표 확산 2차(2026-07-23 승인). 전부 '본문 게재 수치만' 재배치 — 현장 확인 우선.
  { facility: '서울월드컵경기장', slug: '서울월드컵경기장-근처-주차장-요금위치혼잡-대비-정리-2026', tool: 'compare', data: 'src/data/parking-compare/worldcup.json',      source: '본문 게재 수치 — 현장 확인 우선' },
  { facility: '벡스코',        slug: '벡스코-근처-주차장-입구-위치혼잡-시간대대체-주차-정리-2026',       tool: 'compare', data: 'src/data/parking-compare/bexco.json',         source: '본문 게재 수치 — 벡스코 공식·현장 안내 우선' },
  { facility: '대구삼성라이온즈파크', slug: '대구삼성라이온즈파크-경기일-주차-요금혼잡대체-주차-비교2026',  tool: 'compare', data: 'src/data/parking-compare/daegu-samsung.json', source: '본문 게재 수치(블로그·기사 기준) — 구단 공식 아님, 현장 확인 우선' },
  { facility: '고척스카이돔',   slug: '95', tool: 'compare', data: 'src/data/parking-compare/gocheok.json',       source: '본문 게재 수치 — 경기·공연일 돔 통대관, 앱 확인 우선' },
  // 🔴 잠실종합운동장: 부설주차장이 잠실야구장(A 계산기)과 같은 곳. 도구 유형이 달라(요금계산 vs 대안비교)
  //    사용자 승인으로 허용. 부설 행 요금(선불 소형6,000·대형12,000)은 잠실 계산기 값과 일치 유지.
  { facility: '잠실종합운동장', slug: '잠실종합운동장-근처-주차장-요금위치만차-대비-가이드-2026', tool: 'compare', data: 'src/data/parking-compare/jamsil-complex.json', source: '본문 게재 수치 — 부설 요금은 잠실 계산기(jamsil-baseball.json)와 일치' },
];

const norm = (s) => String(s || '').trim().toLowerCase();

// 시설명 또는 slug 로 도구 부착 여부 조회(향후 재제안 제외에 사용).
export function embeddedTool({ facility, slug } = {}) {
  return PARKING_TOOLS.find(
    (t) => (facility && norm(t.facility) === norm(facility)) || (slug && norm(t.slug) === norm(slug))
  ) || null;
}

export function hasEmbeddedTool(arg) {
  return !!embeddedTool(typeof arg === 'string' ? { facility: arg, slug: arg } : arg);
}
