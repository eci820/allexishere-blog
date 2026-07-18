// 🅿️ 대형 시설 주차 가이드 계급 — 7일 한정 테스트(2026-07-17~07-23).
//  · 근거: 유입 실측상 시설 주차 검색(킨텍스·세텍·삼성역·고척)이 실제 클릭을 만든다.
//    단 그 시설들은 이미 발행돼 있어(중복차단에 걸림) 미개척 시설로 확장한다.
//  · 재고(topics-pool.json)에 tier='parking' 으로 주입 → 기존 3중 방어를 그대로 탄다:
//    ① matchLive 발행글 강매칭 ② status(pending/published/skipped) ③ 30일 제안 쿨다운.
//  · config.parkingSlots.until 이 지나면 자동 비활성(원복). briefing.mjs 가 판정.
import { loadPool, savePool, addTopics, pickForBrief, seedPoolIfEmpty, matchLive } from './topicsPool.mjs';

// 배열 순서 = 우선순위. pickForBrief 는 별점(미측정=0) → lastProposedAt 오름차순으로
// 정렬하므로, 지표가 없는 초기에는 이 삽입 순서가 사실상 제안 순서가 된다.
// 그래서 🅰️A급(정기 대형행사·주차대란·검색의도 명확·대중교통 애매)을 맨 앞에 둔다.
//
// 등급화(2026-07-18): 검증된 성공 시설(킨텍스·고척·삼성역 코엑스)의 4대 DNA 기준.
//  · 🅰️ A급 14 — 야구장·아레나·대형경기장·대형전시장(4대 기준 다 충족) → 앞 배치
//  · 🅱️ B급 21 — 병원·컨벤션·공항·테마파크·복합몰(일부 충족) → A급 뒤
//  · 🅲 제외 — 시험장4·학교2·상권8·터미널3(검색의도 약함, 총 17개 제거)
// ⚠️ 이미 발행/지리적 중복이라 넣지 않는 시설:
//    킨텍스·코엑스/삼성역·SETEC·고척돔·고양종합운동장·올림픽공원(+그 안의 KSPO돔=올림픽체조).
//    올림픽공원·고양종합운동장은 '주차 vs 주차장' 토큰 차이로 addTopics dedup 이 못 걸러 수동 제외.
export const PARKING_TOPICS = [
  // ── 🅰️ A급 (14) — 4대 기준 충족. 배열 맨 앞 = 우선 노출 ──
  { keyword: '인스파이어 아레나 주차', angle: '공연일 만차·영종도 차량 접근·대안' },
  { keyword: '잠실야구장 주차', angle: '경기일 만차·대안 주차장·요금' },
  { keyword: '대구삼성라이온즈파크 주차', angle: '경기일 만차·대안·요금' },
  { keyword: '광주기아챔피언스필드 주차', angle: '경기일 만차·대안 주차' },
  { keyword: '창원NC파크 주차', angle: '경기일 만차·대안·요금' },
  { keyword: '대전한화생명볼파크 주차', angle: '경기일 만차·대안 주차' },
  { keyword: '수원kt위즈파크 주차', angle: '경기일 만차·대안·요금' },
  { keyword: '문학경기장 주차', angle: '경기일 요금·대안' },
  { keyword: '사직야구장 주차', angle: '경기일 만차·대안 주차' },
  { keyword: '서울월드컵경기장 주차', angle: '경기일 통제·대안 주차' },
  { keyword: '잠실종합운동장 주차', angle: '콘서트일 혼잡·대안·요금' },
  { keyword: '잠실실내체육관 주차', angle: '콘서트·농구일 만차·대안' },
  { keyword: '벡스코 주차', angle: '행사일 만차·요금·대안' },
  { keyword: '엑스코 주차', angle: '요금·행사일 대비·대안' },
  // ── 🅱️ B급 (21) — 일부 충족. A급 뒤로 ──
  // 대학병원(감면·장시간 검색 수요 큼, 정기행사 아님)
  { keyword: '서울아산병원 주차', angle: '요금·감면 조건·만차 대안' },
  { keyword: '삼성서울병원 주차', angle: '요금·감면 조건·대안' },
  { keyword: '세브란스병원 주차', angle: '요금·감면 조건·대안' },
  { keyword: '서울대병원 주차', angle: '요금·감면·인근 공영' },
  { keyword: '서울성모병원 주차', angle: '요금·감면 조건' },
  // 전시·컨벤션(행사일만 대란)
  { keyword: '수원컨벤션센터 주차', angle: '요금·무료 조건·인근' },
  { keyword: '송도컨벤시아 주차', angle: '행사일 혼잡·요금' },
  { keyword: 'aT센터 주차', angle: '박람회일 만차·대안' },
  { keyword: '대전컨벤션센터 주차', angle: '요금·인근 대안' },
  { keyword: '김대중컨벤션센터 주차', angle: '요금·지하철 연계' },
  { keyword: '창원컨벤션센터 주차', angle: '요금·인근 대안' },
  // 공연·복합(도심·대중교통 양호)
  { keyword: '블루스퀘어 주차', angle: '공연일 요금·인근 대안' },
  { keyword: '장충체육관 주차', angle: '행사일 요금·인근 공영' },
  { keyword: 'KBS아레나 주차', angle: '공연일 요금·대안' },
  { keyword: '고양체육관 주차', angle: '공연·경기일 요금·대안' },
  { keyword: '롯데월드타워 주차', angle: '요금·할인 조건·인근 대안' },
  { keyword: 'DDP 주차', angle: '요금·입구 선택·인근 공영' },
  // 공항·테마파크(장기주차·주말 혼잡)
  { keyword: '인천공항 주차', angle: '장기주차 요금·예약·대안' },
  { keyword: '김포공항 주차', angle: '요금·장기 대안' },
  { keyword: '에버랜드 주차', angle: '요금·무료 조건·혼잡' },
  { keyword: '서울랜드 주차', angle: '요금·인근 대안' },
  { keyword: '아쿠아플라넷 주차', angle: '요금·지점별 차이' },
];

// ── v2.8 모디파이어 매트릭스 ────────────────────────────────────────────
// 시설을 검색의도별 롱테일로 분화: M1 요금(+계산기)·M4 경기일(이벤트 전용)·M3 근처.
// 비이벤트(병원·공항·테마파크·몰)는 M4 제외 → M1·M3. 종합가이드 발행 시설은 통째 제외(자기잠식 방지).
const NON_EVENT = new Set([
  '서울아산병원', '삼성서울병원', '세브란스병원', '서울대병원', '서울성모병원',
  '롯데월드타워', 'DDP', '인천공항', '김포공항', '에버랜드', '서울랜드', '아쿠아플라넷',
]);
const A_FACILITIES = new Set(PARKING_TOPICS.slice(0, 14).map((t) => t.keyword.replace(/ 주차$/, '')));
const MODIFIERS = [
  { id: 'M1', suffix: '주차요금', angle: '요금 상세·계산·감면 조건' },
  { id: 'M4', suffix: '경기일 주차', angle: '경기·행사일 만차·대안·입차 시간대' },
  { id: 'M3', suffix: '근처 주차장', angle: '인근 대안·거리·요금 비교' },
];
const facilityName = (t) => t.keyword.replace(/ 주차$/, '');

// 결정1/3: 이 시설의 종합 가이드가 이미 발행됐나(= base "○○ 주차"가 발행글과 강매칭 score≥2).
export function isComprehensivelyPublished(name) {
  const m = matchLive(`${name} 주차`);
  return !!(m && m.score >= 2);
}

// M1 '○○ 주차요금' 키워드에서 시설명 추출(계산기 결합 판정용). M1 아니면 null.
export function m1Facility(keyword) {
  const m = /^(.+?)\s*주차요금$/.exec(String(keyword || '').trim());
  return m ? m[1].trim() : null;
}

// v2.8 확장 주제 목록(라운드 순 M1→M4→M3, A급 먼저). 종합발행 시설은 통째 제외.
export function expandParkingTopics() {
  const facilities = PARKING_TOPICS.map((t) => {
    const name = facilityName(t);
    return { name, grade: A_FACILITIES.has(name) ? 'A' : 'B', event: !NON_EVENT.has(name) };
  });
  const out = [];
  for (const mod of MODIFIERS) {
    for (const grade of ['A', 'B']) {
      for (const f of facilities) {
        if (f.grade !== grade) continue;
        if (mod.id === 'M4' && !f.event) continue;
        if (isComprehensivelyPublished(f.name)) continue; // 통째 제외
        out.push({ keyword: `${f.name} ${mod.suffix}`, tier: 'parking', series: 'facility', angle: mod.angle });
      }
    }
  }
  return out;
}

// 재고 주입(멱등). v2.8: base "○○ 주차" pending 은퇴(skipped) → 모디파이어 주입.
// version!=='v2.8' 이면 하위호환(base 3개 모드): base 만 주입.
export function seedParkingTopics(config) {
  const pool = seedPoolIfEmpty() || loadPool();
  if (config?.parkingSlots?.version !== 'v2.8') {
    const added = addTopics(pool, PARKING_TOPICS.map((t) => ({ keyword: t.keyword, tier: 'parking', series: 'facility', angle: t.angle })));
    if (added) savePool(pool);
    return { added, retired: 0, mode: 'v2.7-base' };
  }
  // v2.8: 아직 발행 안 된 base 만 은퇴(발행된 것은 published 유지)
  let retired = 0;
  const baseSet = new Set(PARKING_TOPICS.map((t) => t.keyword));
  for (const t of pool.topics) {
    if (t.tier === 'parking' && baseSet.has(t.keyword) && t.status === 'pending') {
      t.status = 'skipped'; t.skipReason = 'v2.8-base-retired'; retired++;
    }
  }
  const added = addTopics(pool, expandParkingTopics()); // addTopics 가 발행글 강매칭분 자동 제외
  if (added || retired) savePool(pool);
  return { added, retired, mode: 'v2.8-modifier' };
}

// 🅿️ 슬롯 상태 — v2.8 상시 운영(until 없음). enabled=false 면 비활성. (until 남아있으면 하위호환 만료판정)
export function parkingSlotState(config, now = Date.now()) {
  const p = config?.parkingSlots;
  if (!p || p.enabled !== true) return { active: false, count: 0, reason: 'disabled' };
  if (p.until) {
    const today = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (today >= p.until) return { active: false, count: 0, reason: `expired(${p.until})` };
  }
  return { active: true, count: p.count ?? 5, reason: 'active' };
}

// 오늘의 주차 후보 최대 count 개(있는 만큼만 — 억지 채움·재탕 없음). 3중 방어 그대로.
export function pickParking(pool, count, exclude = new Set()) {
  return pickForBrief(pool, 'parking', count, exclude).map((p) => ({
    keyword: p.keyword, source: 'parking', gossip: false, id: p.id, poolAngle: p.angle,
  }));
}

// 미발행 주차 주제(pending) 재고 수 — 재고 부족 알림용.
export function parkingStock(pool) {
  return pool.topics.filter((t) => t.tier === 'parking' && t.status === 'pending').length;
}
