// 재고 자동 보충(축2 [3]) — 니치 안 제안가능분 < 임계치면 claude-cli(구독)로 새 주제를 생성해 적재.
//  · 도그마(원리+판단) 부합 / 검색어 형태 / 기존 재고·발행글과 중복 금지(목록 전달).
//  · 🔴 니치(주차+전기요금+세금·환급) 밖은 프롬프트로 막고 코드로 한 번 더 버린다(2026-08-11).
//    트리거도 니치 안만 센다 — 니치 밖 사재기가 총합을 부풀리면 임계에 안 걸려 조용히 마른다.
//  · 보충분은 네이버 지표로 별점 산정 → ★2 미만은 자동 skipped. "N개 보충됨" 1줄 알림.
import { loadPool, savePool, addTopics, pendingCount, eligibleCount, liveIndex, matchLive, nicheAllows } from './topicsPool.mjs';
import { scoreKeyword } from './suitability.mjs';
import { claudeText } from './harness.mjs';

const REPLENISH_PROMPT = (existing, taxFloor, powerFloor) =>
  `당신은 한국어 정보 블로그의 '주제 재고 기획자'입니다. 아래 조건으로 새 블로그 주제 20개를 제안하세요.

[🔴 니치 — 이 밖의 주제는 단 하나도 내지 마세요]
이 블로그의 니치는 **주차 + 전기요금 + 세금·환급** 셋뿐입니다(2026-08-11 축소).
건강·영양제·운동·식단·검진·의료제도·보험·통신비는 **폐지된 주제**입니다. 제안하면 전량 버려집니다.

[🔴 계급 쿼터 — 반드시 지킬 것]
- evergreen/tax(세금·환급)를 **최소 ${taxFloor}개**, science/life(전기요금)를 **최소 ${powerFloor}개** 포함하세요.
- 이유: 🅿️주차 재고는 고정 시설 목록에서만 나와 자동 보충이 없다(지속가능 ≈1.4개/일).
  주차가 마르는 날 브리핑 부족분이 전부 이 둘의 백필로 흘러간다. 둘이 마르면 브리핑 카드 수가 붕괴한다.

[콘텐츠 도그마 — 필수]
- "원리를 설명하고, 돈이 드는 실생활 판단(선택·비용·시기)으로 연결"되는 주제만. 단순 나열·가십·인물·시사 금지.

[형태]
- keyword: 검색어 형태(짧게, 6~14자 권장). 예: '제습기 전기요금', '기타소득세 원천징수'.
- tier/series 는 **아래 3가지만** 허용합니다. 다른 조합은 쓰지 마세요:
  · tier=evergreen, series=tax     — 세금·환급·공제·지원금 (예: '의료비세액공제 한도', '취득세 생애최초 감면')
  · tier=evergreen, series=parking — 주차 제도·과태료·요금 일반 (예: '전기차 충전방해 과태료')
    ※ '○○ 주차요금' 같은 개별 시설 주차는 큐레이터 담당이니 내지 마세요.
  · tier=science,   series=life    — 가전·설비 전기요금 (예: '보일러 외출모드 전기요금')
- angle: 돈이 드는 판단 각도 한 줄(예: '연납 할인 유불리 판단').

[우선순위]
- 고단가 각도 우선: 환급·감면 금액이 큰 세목, 상시 가동 가전의 요금 차이. 신생 사이트라 대형 키워드 정면승부 금지 → 롱테일로 각도를 좁혀라(예: '연말정산'(X) → '의료비세액공제 한도'(O)).

[중복 금지 — 아래 목록과 겹치지 마세요]
${existing.join(', ')}

반드시 아래 JSON 배열 하나만 출력(코드펜스·설명 금지):
[{"keyword":"...","tier":"evergreen","series":"tax","angle":"..."}, ...]`;

function parseArr(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error('JSON 배열 없음');
  const arr = JSON.parse(t.slice(s, e + 1));
  return Array.isArray(arr) ? arr : [];
}

// pending 이 threshold 미만이면 want 개 보충. 반환: {added, skipped, note} 또는 null(보충 불필요/실패).
export async function replenishIfLow(config, { threshold = 30, want = 20, taxFloor = 8, powerFloor = 5 } = {}) {
  const pool = loadPool();
  if (!pool) return null;
  // 신선(제안 가능) 재고가 임계 미만이면 보충 — 총 pending이 아직 많아도 쿨다운으로 마르는 걸 방지.
  // 🔴 반드시 '니치 안'만 센다. 니치 밖 사재기(💪health 46개 등)가 총합을 부풀리면 임계에
  //    영영 안 걸려 니치 안 재고가 조용히 마른다 — health 쿨다운이 풀리는 시점에 실제로 난다.
  // 🔴 계열별 하한도 함께 본다: 총합이 임계를 넘어도 세금·전기요금 한쪽만 마르면 브리핑이 붕괴한다.
  //    (주차 슬롯이 빌 때 부족분 백필이 전부 이 둘에서 나가기 때문 — briefing.mjs §2.5)
  //    호출은 브리핑당 1회뿐이라 조건을 늘려도 LLM 호출은 여전히 최대 하루 1회다.
  const lowTotal = eligibleCount(pool, null, { niche: true }) < threshold;
  const lowTax = eligibleCount(pool, 'evergreen', { series: 'tax' }) < taxFloor;
  const lowPower = eligibleCount(pool, 'science', { series: 'life' }) < powerFloor;
  if (!lowTotal && !lowTax && !lowPower) return null;

  // 중복 금지 목록: 현재 재고 전체 + 발행글 제목(대표어)
  const existing = [
    ...pool.topics.map((t) => t.keyword),
    ...liveIndex().slice(0, 120).map((p) => p.title).filter(Boolean),
  ];

  let raw;
  try {
    // 공용 실행기(stdin·구독) — 예전엔 프롬프트를 명령행 인자로 넘겼다(SKILL.md §6 위반).
    const r = await claudeText(REPLENISH_PROMPT(existing, taxFloor, powerFloor), { model: config.cliModel, timeoutSec: config.cliTimeoutSeconds || 240, tools: [] });
    raw = r.result;
  } catch (e) {
    return { added: 0, skipped: 0, note: `⚠️ 재고 보충 실패: ${(e.message || '').slice(0, 80)}` };
  }

  let items;
  try { items = parseArr(raw); } catch { return { added: 0, skipped: 0, note: '⚠️ 재고 보충 파싱 실패' }; }

  // 네이버 지표로 별점 산정 → ★2 미만 자동 skipped. 발행글 매칭·기존 중복 제외.
  // 🔴 니치 밖은 프롬프트로 '요청'만 하지 않고 여기서 실제로 버린다 — 프롬프트 하한은 요청이지
  //    보장이 아니다(§7). 버린 수는 아래 note 에 드러내 조용히 새지 않게 한다.
  const offNiche = items.filter((it) => it && it.keyword && !nicheAllows({ tier: it.tier, series: it.series }, config));
  const fresh = items
    .filter((it) => it && it.keyword)
    .filter((it) => nicheAllows({ tier: it.tier, series: it.series }, config))
    .filter((it) => !pool.topics.some((t) => t.keyword === it.keyword) && !matchLive(it.keyword))
    .slice(0, want);

  let stats = {};
  try {
    const { enrichKeywords } = await import('./naver.mjs');
    stats = await enrichKeywords(fresh.map((f) => f.keyword));
  } catch { /* 지표 없으면 별점 필터 생략(전부 pending) */ }

  const now = Date.now();
  const prepared = fresh.map((it) => {
    const st = stats[it.keyword];
    const sc = scoreKeyword({ source: it.tier, angle: it.series === 'knowledge' ? 'knowledge' : undefined, keyword: it.keyword }, st);
    const metrics = st ? { vol: st.vol, doc: st.doc, ratio: st.ratio, stars: sc.stars, ts: now } : { stars: sc.stars, ts: now };
    // ★2 미만은 자동 skipped(재고엔 남기되 제안 안 함) — 지표가 있을 때만 필터
    const status = st && sc.stars < 2 ? 'skipped' : 'pending';
    return { keyword: it.keyword, tier: it.tier || 'evergreen', series: it.series || '', angle: it.angle || '', metrics, status };
  });

  const skipped = prepared.filter((p) => p.status === 'skipped').length;
  // 쿼터 준수 검증은 산수로 한다(LLM 재검증 없음). 프롬프트 하한은 '요청'이지 '보장'이 아니므로
  // 실제로 몇 개가 pending 으로 들어갔는지 계열별로 세어 리포트에 드러낸다 — 조용히 어기는 것만 막는다.
  const taxBefore = eligibleCount(pool, 'evergreen', { series: 'tax' });
  const powerBefore = eligibleCount(pool, 'science', { series: 'life' });
  const added = addTopics(pool, prepared);
  savePool(pool);
  const taxAdded = eligibleCount(pool, 'evergreen', { series: 'tax' }) - taxBefore;
  const powerAdded = eligibleCount(pool, 'science', { series: 'life' }) - powerBefore;
  const pendingAdded = added - skipped;
  const warns = [];
  if (lowTax && taxAdded < taxFloor) warns.push(`🌲세금 하한 ${taxFloor}개 요청 → ${taxAdded}개 확보`);
  if (lowPower && powerAdded < powerFloor) warns.push(`🔬전기요금 하한 ${powerFloor}개 요청 → ${powerAdded}개 확보`);
  const quotaWarn = warns.length
    ? `\n⚠️ 계열 쿼터 미달 — ${warns.join(' · ')}(중복 제외·★2미만 보류·니치 밖 폐기 영향). 다음 실행에서 재시도되며, 반복되면 프롬프트 하한을 올리거나 시드를 수기 추가하세요.`
    : '';
  // 니치 밖이 계속 돌아오면 프롬프트가 안 먹히고 있다는 뜻 — 조용히 버리지 않고 알린다.
  const offNote = offNiche.length
    ? `\n🚫 니치 밖 ${offNiche.length}개 폐기(${[...new Set(offNiche.map((o) => `${o.tier}/${o.series || '-'}`))].join(', ')}) — 반복되면 프롬프트를 손보세요.`
    : '';
  return {
    added,
    skipped,
    taxAdded,
    powerAdded,
    offNiche: offNiche.length,
    note: added
      ? `📥 주제 재고 ${pendingAdded}개 보충됨(🌲세금 ${taxAdded} · 🔬전기요금 ${powerAdded})${skipped ? ` (★2미만 ${skipped}개 보류)` : ''} · 현재 니치 안 제안가능 ${eligibleCount(loadPool(), null, { niche: true })}개 / 전체 pending ${pendingCount(loadPool())}개${quotaWarn}${offNote}`
      : `재고 보충: 새 주제 없음${quotaWarn}${offNote}`,
  };
}
