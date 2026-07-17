// 🅿️ 대형 시설 주차 가이드 계급 — 7일 한정 테스트(2026-07-17~07-23).
//  · 근거: 유입 실측상 시설 주차 검색(킨텍스·세텍·삼성역·고척)이 실제 클릭을 만든다.
//    단 그 시설들은 이미 발행돼 있어(중복차단에 걸림) 미개척 시설로 확장한다.
//  · 재고(topics-pool.json)에 tier='parking' 으로 주입 → 기존 3중 방어를 그대로 탄다:
//    ① matchLive 발행글 강매칭 ② status(pending/published/skipped) ③ 30일 제안 쿨다운.
//  · config.parkingSlots.until 이 지나면 자동 비활성(원복). briefing.mjs 가 판정.
import { loadPool, savePool, addTopics, pickForBrief, seedPoolIfEmpty } from './topicsPool.mjs';

// 배열 순서 = 우선순위. pickForBrief 는 별점(미측정=0) → lastProposedAt 오름차순으로
// 정렬하므로, 지표가 없는 초기에는 이 삽입 순서가 사실상 제안 순서가 된다.
// ⚠️ 이미 발행된 시설(킨텍스·코엑스/삼성역·SETEC·고척돔·고양종합운동장·올림픽공원)은
//    넣지 않는다 — addTopics 가 어차피 걸러내지만, 의도를 명시적으로 남긴다.
export const PARKING_TOPICS = [
  // ── 수도권 대형 시설(검색 수요 기대 상위) ──
  { keyword: '잠실야구장 주차', angle: '경기일 만차·대안 주차장·요금' },
  { keyword: '잠실종합운동장 주차', angle: '콘서트일 혼잡·대안·요금' },
  { keyword: '롯데월드타워 주차', angle: '요금·할인 조건·인근 대안' },
  { keyword: 'DDP 주차', angle: '요금·입구 선택·인근 공영' },
  { keyword: '고속터미널 주차', angle: '요금·무료 조건·혼잡 회피' },
  { keyword: '서울월드컵경기장 주차', angle: '경기일 통제·대안 주차' },
  { keyword: '동서울터미널 주차', angle: '요금·주변 대안' },
  { keyword: '남부터미널 주차', angle: '요금·예술의전당 연계' },
  // ── 전시·컨벤션 ──
  { keyword: '수원컨벤션센터 주차', angle: '요금·무료 조건·인근' },
  { keyword: '송도컨벤시아 주차', angle: '행사일 혼잡·요금' },
  { keyword: 'aT센터 주차', angle: '박람회일 만차·대안' },
  { keyword: '엑스코 주차', angle: '요금·행사일 대비' },
  { keyword: '대전컨벤션센터 주차', angle: '요금·인근 대안' },
  { keyword: '김대중컨벤션센터 주차', angle: '요금·지하철 연계' },
  { keyword: '창원컨벤션센터 주차', angle: '요금·인근 대안' },
  { keyword: '벡스코 주차', angle: '행사일 만차·요금·대안' },
  { keyword: '문학경기장 주차', angle: '경기일 요금·대안' },
  { keyword: '사직야구장 주차', angle: '경기일 만차·대안 주차' },
  // ── 대학병원(장시간 주차·감면 조건 검색 수요) ──
  { keyword: '서울아산병원 주차', angle: '요금·감면 조건·만차 대안' },
  { keyword: '삼성서울병원 주차', angle: '요금·감면 조건·대안' },
  { keyword: '세브란스병원 주차', angle: '요금·감면 조건·대안' },
  { keyword: '서울대병원 주차', angle: '요금·감면·인근 공영' },
  { keyword: '서울성모병원 주차', angle: '요금·감면 조건' },
  // ── 공항·테마파크 ──
  { keyword: '인천공항 주차', angle: '장기주차 요금·예약·대안' },
  { keyword: '김포공항 주차', angle: '요금·장기 대안' },
  { keyword: '에버랜드 주차', angle: '요금·무료 조건·혼잡' },
  { keyword: '서울랜드 주차', angle: '요금·인근 대안' },
  { keyword: '아쿠아플라넷 주차', angle: '요금·지점별 차이' },
  // ── 시험장(시험일 당일 검색 급증: 토익 매월·OPIc/토플 상시) ──
  { keyword: '토익 시험장 주차', angle: '시험장 주차 가능 여부·대안·지각 방지' },
  { keyword: 'OPIc 시험장 주차', angle: '센터별 주차·대안' },
  { keyword: '토플 시험장 주차', angle: '시험장 주차·대중교통 판단' },
  { keyword: '토익스피킹 시험장 주차', angle: '시험장 주차·대안' },
  // ── 학교 ──
  { keyword: '대학교 주차요금', angle: '외부인 요금·방문 절차' },
  { keyword: '초등학교 주차', angle: '학교 개방 주차·행사일 판단' },
  // ── 인구밀집 상권 맛집 주차 ──
  { keyword: '강남역 주차', angle: '요금 상한·저렴한 곳·맛집 연계' },
  { keyword: '강남역 맛집 주차', angle: '식당 제휴·발렛·공영 비교' },
  { keyword: '종로 주차', angle: '공영 요금·혼잡 회피' },
  { keyword: '종로 맛집 주차', angle: '제휴 주차·인근 공영' },
  { keyword: '여의도 주차', angle: '요금·주말 무료 여부' },
  { keyword: '여의도 맛집 주차', angle: '제휴·공원 주차 연계' },
  { keyword: '을지로 주차', angle: '공영·노상 요금 비교' },
  { keyword: '홍대 주차', angle: '요금·저렴한 대안' },
];

// 재고에 주차 주제 주입(멱등). addTopics 가 발행글 강매칭분을 자동 제외한다.
// 반환: 실제로 추가된 개수.
export function seedParkingTopics() {
  const pool = seedPoolIfEmpty() || loadPool();
  const added = addTopics(
    pool,
    PARKING_TOPICS.map((t) => ({ keyword: t.keyword, tier: 'parking', series: 'facility', angle: t.angle }))
  );
  if (added) savePool(pool);
  return added;
}

// 🅿️ 슬롯이 지금 유효한가 — until(KST) 이 지나면 자동 비활성(원복).
// 반환: { active, count, reason }
export function parkingSlotState(config, now = Date.now()) {
  const p = config?.parkingSlots;
  if (!p || p.enabled !== true) return { active: false, count: 0, reason: 'disabled' };
  if (p.until) {
    const today = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜
    if (today >= p.until) return { active: false, count: 0, reason: `expired(${p.until} 도달)` };
  }
  return { active: true, count: p.count ?? 3, reason: 'active' };
}

// 오늘의 주차 후보 count 개 — 3중 방어를 그대로 태운다(pickForBrief).
export function pickParking(pool, count, exclude = new Set()) {
  return pickForBrief(pool, 'parking', count, exclude).map((p) => ({
    keyword: p.keyword,
    source: 'parking',
    gossip: false,
    id: p.id,
    poolAngle: p.angle,
  }));
}
