// 재고 자동 보충(축2 [3]) — pending < 임계치면 claude-cli(구독)로 새 주제를 생성해 재고에 적재.
//  · 도그마(원리+판단) 부합 / 검색어 형태 / 고단가 계열 우선 / 기존 재고·발행글과 중복 금지(목록 전달).
//  · 보충분은 네이버 지표로 별점 산정 → ★2 미만은 자동 skipped. "N개 보충됨" 1줄 알림.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadPool, savePool, addTopics, pendingCount, eligibleCount, liveIndex, matchLive } from './topicsPool.mjs';
import { scoreKeyword } from './suitability.mjs';
import { subscriptionEnv } from './claudeCli.mjs';

const execFileP = promisify(execFile);

const REPLENISH_PROMPT = (existing, evergreenFloor) =>
  `당신은 한국어 정보 블로그의 '주제 재고 기획자'입니다. 아래 조건으로 새 블로그 주제 20개를 제안하세요.

[🔴 계급 쿼터 — 반드시 지킬 것]
- evergreen 계급을 **최소 ${evergreenFloor}개** 포함하세요. 나머지는 아래 우선순위대로 자유롭게.
- 이유: 🅿️주차 슬롯이 마르는 날 브리핑 부족분이 전부 evergreen 백필로 흘러가 하루 3~6개씩
  소비된다. evergreen 이 마르면 브리핑 카드 수 자체가 붕괴한다(실측 2026-07-25).

[콘텐츠 도그마 — 필수]
- "원리를 설명하고, 돈이 드는 실생활 판단(선택·비용·시기)으로 연결"되는 주제만. 단순 나열·가십·인물·시사 금지.

[형태]
- keyword: 검색어 형태(짧게, 6~14자 권장). 예: '제습기 전기요금', '오메가3 rTG TG 차이'.
- tier: science(🔬 가전 원리+요금/자연·과학 원리) | health(💪 검진·영양제·헬스·수면·대사) | evergreen(🌲 주차·세금 등 생활정보).
- series: science=life|knowledge, health=A(검진)|B(영양제)|C(헬스)|D(수면)|E(대사), evergreen=parking|tax|life.
- angle: 돈이 드는 판단 각도 한 줄(예: '형태별 가격·흡수 판단').

[우선순위]
- 고단가 계열 우선: 가전(냉난방·정수·공기질)·의료제도·영양제·보험. 신생 사이트라 대형 키워드 정면승부 금지 → 롱테일로 각도를 좁혀라(예: '실손보험'(X) → '4세대 실손보험 전환 조건'(O)).

[중복 금지 — 아래 목록과 겹치지 마세요]
${existing.join(', ')}

반드시 아래 JSON 배열 하나만 출력(코드펜스·설명 금지):
[{"keyword":"...","tier":"health","series":"B","angle":"..."}, ...]`;

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
export async function replenishIfLow(config, { threshold = 30, want = 20, evergreenFloor = 8 } = {}) {
  const pool = loadPool();
  if (!pool) return null;
  // 신선(제안 가능) 재고가 임계 미만이면 보충 — 총 pending이 아직 많아도 쿨다운으로 마르는 걸 방지.
  // 🔴 계급별 판정도 함께 본다: 총합이 임계를 넘어도 evergreen 만 마르면 브리핑이 붕괴한다.
  //    (주차 슬롯이 빌 때 부족분 백필이 전부 evergreen 에서 나가기 때문 — briefing.mjs §2.5)
  //    호출은 브리핑당 1회뿐이라 이 조건을 추가해도 LLM 호출은 여전히 최대 하루 1회다.
  const lowTotal = eligibleCount(pool) < threshold;
  const lowEver = eligibleCount(pool, 'evergreen') < evergreenFloor;
  if (!lowTotal && !lowEver) return null;

  // 중복 금지 목록: 현재 재고 전체 + 발행글 제목(대표어)
  const existing = [
    ...pool.topics.map((t) => t.keyword),
    ...liveIndex().slice(0, 120).map((p) => p.title).filter(Boolean),
  ];

  let raw;
  try {
    const args = ['-p', REPLENISH_PROMPT(existing, evergreenFloor), '--output-format', 'json'];
    if (config.cliModel) args.push('--model', config.cliModel);
    const { stdout } = await execFileP('claude', args, {
      cwd: os.tmpdir(), maxBuffer: 20 * 1024 * 1024, timeout: (config.cliTimeoutSeconds || 240) * 1000, env: subscriptionEnv(),
    });
    const j = JSON.parse(stdout);
    if (j.is_error || !j.result) throw new Error(j.subtype || 'claude 실패');
    raw = j.result;
  } catch (e) {
    return { added: 0, skipped: 0, note: `⚠️ 재고 보충 실패: ${(e.message || '').slice(0, 80)}` };
  }

  let items;
  try { items = parseArr(raw); } catch { return { added: 0, skipped: 0, note: '⚠️ 재고 보충 파싱 실패' }; }

  // 네이버 지표로 별점 산정 → ★2 미만 자동 skipped. 발행글 매칭·기존 중복 제외.
  const fresh = items
    .filter((it) => it && it.keyword)
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
  // 실제로 몇 개가 pending 으로 들어갔는지 계급별로 세어 리포트에 드러낸다 — 조용히 어기는 것만 막는다.
  const everBefore = eligibleCount(pool, 'evergreen');
  const added = addTopics(pool, prepared);
  savePool(pool);
  const everAdded = eligibleCount(pool, 'evergreen') - everBefore;
  const pendingAdded = added - skipped;
  const quotaWarn = lowEver && everAdded < evergreenFloor
    ? `\n⚠️ evergreen 쿼터 미달 — 하한 ${evergreenFloor}개 요청했으나 ${everAdded}개만 확보(중복 제외·★2미만 보류 영향). 다음 실행에서 재시도되며, 반복되면 프롬프트 하한을 올리거나 시드를 수기 추가하세요.`
    : '';
  return {
    added,
    skipped,
    everAdded,
    note: added
      ? `📥 주제 재고 ${pendingAdded}개 보충됨(🌲evergreen ${everAdded}개)${skipped ? ` (★2미만 ${skipped}개 보류)` : ''} · 현재 pending ${pendingCount(loadPool())}개${quotaWarn}`
      : `재고 보충: 새 주제 없음${quotaWarn}`,
  };
}
