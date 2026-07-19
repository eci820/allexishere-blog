// 🗺 네이버 지도 링크 — 좌표 없이 '검색 링크'만 붙인다.
//
// 왜 링크인가(2026-07-19 조사 결론):
//  · API 키·도메인 등록·과금이 전혀 없다. 실측 확인: map.naver.com/p/search/… 는 그냥 200.
//  · 🔴 무엇보다 '틀릴 수 없다'. 좌표를 우리가 들고 있으면 잘못 넣어도 아무도 모른 채 굳는다.
//    검색 링크는 위치 판단을 네이버에 위임하므로, 폐업·이전·입구 변경도 알아서 반영된다.
//    요금이 틀리면 현장에서 확인되지만 위치가 틀리면 이미 도착한 뒤다 — 더 나쁘다.
//  · Static Map(②)은 시설 36개의 좌표를 새로 확보해야 하는 별개 작업이고,
//    JS 임베드(③)는 무료 한도가 조회수에 비례해 소모된다. 둘 다 지금은 과하다.
//
// ⚠️ 구 지도 API(AI NAVER API)는 2026-06-25 자로 서비스가 완전 종료됐다.
//    ②③ 을 나중에 검토하더라도 신규 'Maps' 상품 기준으로 다시 조사해야 한다.
import { PARKING_TOPICS } from './parking.mjs';

const ORIGIN = 'https://map.naver.com/p/search/';

// 검색어 보정 — 시설명 그대로 검색하면 엉뚱한 데로 가는 경우에만 넣는다.
//
// 🔴 비워둔 이유(실측): '짧으니까 모호할 것'이라는 가정으로 8개(벡스코·엑스코·aT센터·
//    DDP·인천공항·김포공항·에버랜드·서울랜드)에 지역을 붙이려 했으나, 브라우저로 확인해
//    보니 보정 없이도 정확히 해석됐다.
//      · "벡스코" → BEXCO컨벤션센터 (부산 해운대구 우동)
//      · "DDP"   → 동대문디자인플라자 (서울 중구 을지로7가)
//    네이버가 이미 잘 푸는 이름에 지역을 덧붙이면 오히려 검색을 좁혀 망칠 수 있다.
//    그래서 '확인되지 않은 보정'은 넣지 않는다 — 지어내기 금지는 좌표뿐 아니라
//    검색어에도 적용된다.
//
// 실제로 엉뚱한 결과가 확인된 시설이 생기면 그때 여기에 한 줄 추가한다:
//   '시설명': '보정된 검색어',
export const QUERY_OVERRIDE = {};

// 시설명 → 검색어.
export function mapQuery(facility) {
  const f = String(facility || '').trim();
  return QUERY_OVERRIDE[f] || f;
}

// 시설명 → 네이버 지도 검색 URL.
export function naverMapUrl(facility) {
  const q = mapQuery(facility);
  if (!q) return null;
  return ORIGIN + encodeURIComponent(q);
}

// 제목에서 시설을 찾는다. parking.mjs 의 고정 목록(36개)에만 의존하므로
// 우리가 관리하는 시설에만 링크가 붙는다 — 모르는 곳에 링크를 지어내지 않는다.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 🔴 제목에 쓰인 표기를 그대로 돌려준다 — 재고의 표기가 아니라.
//    실측(2026-07-19): 네이버 지도 검색은 한글 속 영문의 **대소문자를 구분**한다.
//      · "수원kt위즈파크"(재고 표기) → 검색 결과 0건(ERR-111)
//      · "수원KT위즈파크"(제목 표기) → 첫 결과가 구장 본체 ✅
//    재고 표기를 그대로 검색어로 쓰면 링크가 빈 화면으로 간다. 반면 제목은 사람이
//    읽는 이름이라 실제 등록 명칭과 표기가 일치할 확률이 높다.
//    그래서 매칭은 대소문자·띄어쓰기를 무시하되, 검색어로는 제목의 원문을 쓴다.
export function facilityFromTitle(title) {
  const t = String(title || '').normalize('NFC');
  let best = null;
  for (const topic of PARKING_TOPICS) {
    const name = topic.keyword.replace(/\s*주차\s*$/, '').trim();
    if (!name) continue;
    // 글자 사이 공백을 허용하고 대소문자를 무시해 찾되, 매칭된 '원문'을 취한다.
    const pattern = name.replace(/\s+/g, '').split('').map(escapeRe).join('\\s*');
    const m = t.match(new RegExp(pattern, 'i'));
    if (m && m[0]) {
      const hit = m[0].trim();
      // 가장 긴 이름을 고른다("잠실야구장" vs "잠실" 같은 부분일치 방지)
      if (!best || hit.replace(/\s/g, '').length > best.replace(/\s/g, '').length) best = hit;
    }
  }
  return best;
}

// 본문에 넣을 한 줄.
export function mapLinkLine(facility) {
  const url = naverMapUrl(facility);
  if (!url) return null;
  return `🗺 [네이버 지도에서 ${facility} 보기](${url}) — 길찾기·주변 주차장을 지도에서 바로 확인할 수 있습니다.`;
}

// 본문에 링크를 끼워 넣는다. 넣을 자리는 '위치·입구' 성격의 h2 바로 아래.
//  · 이미 지도 링크가 있으면 건드리지 않는다(갱신 시 중복 방지).
//  · 마땅한 h2 가 없으면 넣지 않는다 — 아무 데나 끼우면 글 흐름이 깨진다.
//    (그 경우 null 을 돌려주므로 호출부가 '삽입 안 됨'을 알 수 있다)
const LOCATION_H2 = /^##\s+.*(위치|입구|찾아가|오시는|가는\s*길).*$/m;

export function insertMapLink(body, facility) {
  const line = mapLinkLine(facility);
  if (!line) return { body, inserted: false, reason: '시설명 없음' };
  if (body.includes('map.naver.com')) return { body, inserted: false, reason: '이미 지도 링크 있음' };

  const m = body.match(LOCATION_H2);
  if (!m) return { body, inserted: false, reason: '위치·입구 h2 없음' };

  const at = m.index + m[0].length;
  const next = body.slice(at);
  return {
    body: body.slice(0, at) + '\n\n' + line + next.replace(/^\n+/, '\n\n'),
    inserted: true,
    reason: null,
  };
}
