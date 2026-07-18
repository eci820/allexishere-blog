// 주차요금 순수 계산(도메인 로직) — DOM 무관. 컴포넌트와 테스트가 공유해 '계산 정확도'를 보장한다.
//  · metered(후불): 무료시간 차감 → 단위시간 올림 → 단위요금 → (1일 상한) → 감면.
//  · flat(선불 정액): 입차가 '정액 창'(경기 -before ~ +after) 안이면 정액, 밖이면 후불 미터로 fallback.

export const toMin = (t) => {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function durationMin(arriveMin, leaveMin) {
  let d = leaveMin - arriveMin;
  if (d < 0) d += 24 * 60; // 자정 넘김
  return d;
}

export function meteredFee({ durationMin, unit, freeMinutes = 0, dayCapWon = null, discountRate = 0 }) {
  const billable = Math.max(0, durationMin - freeMinutes);
  const units = Math.ceil(billable / unit.minutes);
  let fee = units * unit.won;
  // 1일 상한은 '숫자'일 때만 적용. null/undefined/"none"(상한 없음) 은 캡 미적용.
  if (typeof dayCapWon === 'number') fee = Math.min(fee, dayCapWon);
  fee = fee * (1 - (discountRate || 0));
  return { fee: Math.round(fee), units, billable };
}

// 반환: { fee, mode('flat'|'metered'|'metered-fallback'), inWindow?, durationMin?, units?, before?, after? }
export function computeParking({ data, profileId, vehicle, gameMin, arriveMin, leaveMin, summer = false, discountRate = 0 }) {
  const prof = data.profiles.find((p) => p.id === profileId);
  const meteredProf = data.profiles.find((p) => p.type === 'metered');

  if (prof.type === 'flat') {
    const before = summer ? prof.summerWindowBeforeMin : prof.windowBeforeMin;
    const after = summer ? prof.summerWindowAfterMin : prof.windowAfterMin;
    const inWindow = arriveMin >= gameMin - before && arriveMin <= gameMin + after;
    if (inWindow) {
      // 정액은 자정(24:00)까지. 자정을 넘기면 넘긴 만큼 후불 미터로 전환·가산(1일 상한 없음).
      const flatFee = prof.flatWon[vehicle];
      const crossesMidnight = leaveMin < arriveMin; // 출차 시각이 입차보다 이르면 자정 넘김
      if (crossesMidnight) {
        const postMidnightMin = leaveMin; // 00:00 ~ 출차
        const m = meteredFee({ durationMin: postMidnightMin, unit: meteredProf.unitWon[vehicle], freeMinutes: 0, dayCapWon: meteredProf.dayCapWon, discountRate: 0 });
        return { fee: flatFee + m.fee, mode: 'flat+overnight', inWindow: true, before, after, flatFee, postMidnightMin, postFee: m.fee, postUnits: m.units };
      }
      return { fee: flatFee, mode: 'flat', inWindow: true, before, after };
    }
    // 정액 창 밖 → 후불 미터(감면은 경기일 혼동 방지 위해 미적용)
    const dur = durationMin(arriveMin, leaveMin);
    const m = meteredFee({ durationMin: dur, unit: meteredProf.unitWon[vehicle], freeMinutes: meteredProf.freeMinutes, dayCapWon: meteredProf.dayCapWon, discountRate: 0 });
    return { fee: m.fee, mode: 'metered-fallback', inWindow: false, before, after, durationMin: dur, units: m.units, billable: m.billable };
  }

  // 평일 후불
  const dur = durationMin(arriveMin, leaveMin);
  const m = meteredFee({ durationMin: dur, unit: prof.unitWon[vehicle], freeMinutes: prof.freeMinutes, dayCapWon: prof.dayCapWon, discountRate });
  return { fee: m.fee, mode: 'metered', durationMin: dur, units: m.units, billable: m.billable };
}
