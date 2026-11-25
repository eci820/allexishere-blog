// 🔭 주제 스카우트 — "대중이 혹할 만한데 저품질에 안 걸리는" 정보형 주제 발굴 (2026-11-25 신설).
//
// 사용자 지시: 유튜브·커뮤니티·뉴스에서 지금 화제가 되는 것을 뽑되, 정보 중심으로 다양하게.
//
// 기존 방식과 무엇이 다른가:
//   · replenish.mjs  — 니치(주차·전기요금·세금) 안에서 '재고가 마르면' 채운다. 화제성 신호 없음.
//   · parking.mjs    — 시설 36곳 × 모디파이어 3종(요금·경기일·근처) = 최대 108편. 🔴 GSC 실측상
//                      이 행렬로 같은 시설 글이 2~3편씩 생긴 직후(7/18~19 이틀 34편) 사이트 전체 노출이
//                      0 이 됐다. 구글 정의로 '도어웨이(같은 검색 의도의 변형 페이지 대량 생성)'에 가깝다.
//   · scout(여기)    — 화제(왜 지금 사람들이 궁금해하나)를 출발점으로, '검증 가능한 정보 질문'으로
//                      바꿔서 가져온다. 한 대상당 한 편, 분야를 섞는다.
//
// 저품질 방지 규칙(코드로 강제 — 프롬프트는 요청일 뿐 보장이 아니다):
//   ① 인물·연예·가십·정치·사건사고 금지어 → 버림
//   ② 이미 발행한 대상과 겹치면 버림(liveDupe — 계급별 subject/token 판정 재사용)
//   ③ 한 번에 같은 분야 최대 3개 → 분야 다양성
//   ④ 네이버 검색량·문서수로 별점 → ★2 미만은 skipped(재고엔 남김)
//   ⑤ 공식 출처 후보가 없는 주제는 버림 — 확인할 길이 없으면 쓰면 안 된다(§4 지어내기 금지)
//
// 실행 경로: autopilot 이 재고가 마를 때 부른다. 재고 추가는 기존 addTopics() 로만 한다(계약 §3).

import { loadPool, savePool, addTopics, liveDupe } from './topicsPool.mjs';
import { scoreKeyword } from './suitability.mjs';
import { claudeText } from './harness.mjs';

// 분야 → 재고 tier/series. niche.allow 와 autopilot.excludeTiers 가 이 값으로 거른다.
export const CATEGORIES = {
  money: { tier: 'evergreen', series: 'tax', label: '돈·제도(지원금·세금·환급·요금 변경)' },
  consumer: { tier: 'evergreen', series: 'life', label: '소비자·생활비(환불·리콜·구독·요금제·장보기)' },
  home: { tier: 'science', series: 'life', label: '가전·집(전기요금·난방·곰팡이·청소 원리)' },
  science: { tier: 'science', series: 'knowledge', label: '생활과학·자연 현상(왜 그런가)' },
  mobility: { tier: 'evergreen', series: 'mobility', label: '교통·주차·자동차 제도(과태료·보험·충전)' },
  travel: { tier: 'evergreen', series: 'travel', label: '여행·나들이(제도·요금·시기)' },
  digital: { tier: 'evergreen', series: 'digital', label: 'IT·통신·보안(설정·요금·사기 예방)' },
};

const BANNED = /(열애|결혼|이혼|불륜|사망|별세|구속|기소|논란|폭로|루머|대통령|국회의원|정당|선거|탄핵|살인|사고 현장|아이돌|배우|가수|유튜버 .{0,4}(?:수입|근황)|근황|몇 기|출연자|러브라인)/;

const PROMPT = (existingSample, want) => `당신은 한국어 생활정보 블로그의 '주제 스카우트'입니다.
WebSearch 로 최근 2~3주 한국 유튜브(조회수 높은 생활·경제·과학 채널), 커뮤니티(더쿠·클리앙·뽐뿌·네이버 카페 화제글),
뉴스에서 '많은 사람이 궁금해하거나 오해하고 있는 것'을 찾고, 그것을 블로그 글 주제 ${want}개로 바꾸세요.

[주제가 되는 조건 — 모두 만족]
1. 대중이 혹할 만한 것: 몰라서 손해 보는 것, 바뀐 제도·요금, 널리 퍼진 오해, "이거 진짜야?" 싶은 생활 상식, 계절에 곧 필요한 것.
2. 정보형: 인물·연예·가십·정치·사건사고 자체는 금지. 화제가 사건이면 그 뒤의 '제도·원리·내 돈 문제'로 바꾸세요.
   예) "OO 해킹 사고"(X) → "유심 보호서비스 신청 방법과 해지 조건"(O)
3. 검증 가능: 공식 기관·운영처·제조사 문서 등 확인할 1차 출처가 있어야 합니다. official 에 기관/문서명을 적으세요.
4. 롱테일 검색어 형태(6~16자). 대형 키워드 정면승부 금지. 사람들이 실제로 치는 말로.
5. 한 대상당 하나. 같은 대상의 변형(○○ 요금 / ○○ 근처 / ○○ 할인)을 여러 개 내지 마세요.
6. 분야를 섞으세요(한 분야 최대 3개): ${Object.entries(CATEGORIES).map(([k, v]) => `${k}=${v.label}`).join(' / ')}
   건강·의료·투자 종목 추천은 내지 마세요.

[이미 다룬 주제 일부 — 겹치지 말 것]
${existingSample.join(', ')}

아래 JSON 배열 하나만 출력(코드펜스·설명 금지):
[{"keyword":"검색어","category":"money|consumer|home|science|mobility|travel|digital","hook":"왜 지금 사람들이 궁금해하나(근거 1줄)","evidence":"화제 근거 URL","angle":"글이 답할 판단 각도","official":"확인할 공식 출처"}]`;

function parseArr(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error('JSON 배열 없음');
  const a = JSON.parse(t.slice(s, e + 1));
  return Array.isArray(a) ? a : [];
}

// return { added, skipped, dropped:[{keyword, why}], note, costUsd }
export async function runScout(config, { want = 15, dry = false } = {}) {
  const pool = loadPool();
  const existingSample = pool.topics.slice(-120).map((t) => t.keyword);
  let raw, costUsd = 0;
  try {
    const r = await claudeText(PROMPT(existingSample, want), { model: config.cliModel, timeoutSec: (config.harness?.timeoutSeconds) || 300 });
    raw = r.result; costUsd = r.costUsd;
  } catch (e) {
    return { added: 0, skipped: 0, dropped: [], costUsd, note: `⚠️ 주제 스카우트 실패: ${String(e.message).slice(0, 100)}` };
  }
  let items;
  try { items = parseArr(raw); } catch { return { added: 0, skipped: 0, dropped: [], costUsd, note: '⚠️ 주제 스카우트 결과 해석 실패' }; }

  const dropped = [];
  const perCat = {};
  const kept = [];
  for (const it of items) {
    const kw = String(it?.keyword || '').trim();
    const cat = CATEGORIES[it?.category];
    if (!kw || !cat) { dropped.push({ keyword: kw || '?', why: '분야 미지정' }); continue; }
    if (BANNED.test(kw) || BANNED.test(String(it.angle || ''))) { dropped.push({ keyword: kw, why: '인물·가십·정치·사건' }); continue; }
    if (!String(it.official || '').trim()) { dropped.push({ keyword: kw, why: '공식 출처 후보 없음' }); continue; }
    if (pool.topics.some((t) => t.keyword === kw)) { dropped.push({ keyword: kw, why: '재고에 이미 있음' }); continue; }
    const dup = liveDupe(kw, cat.tier);
    if (dup) { dropped.push({ keyword: kw, why: `발행글과 겹침: ${dup.title || dup.slug}` }); continue; }
    if ((perCat[it.category] = (perCat[it.category] || 0) + 1) > 3) { dropped.push({ keyword: kw, why: '분야 쏠림(3개 초과)' }); continue; }
    kept.push({ kw, it, cat });
  }

  let stats = {};
  try {
    const { enrichKeywords } = await import('./naver.mjs');
    stats = await enrichKeywords(kept.map((k) => k.kw));
  } catch { /* 지표 없으면 별점 필터 생략 */ }

  const now = Date.now();
  const prepared = kept.map(({ kw, it, cat }) => {
    const st = stats[kw];
    const sc = scoreKeyword({ source: cat.tier, angle: cat.series === 'knowledge' ? 'knowledge' : undefined, keyword: kw }, st);
    return {
      keyword: kw, tier: cat.tier, series: cat.series,
      angle: `${String(it.angle || '').slice(0, 80)} | 화제: ${String(it.hook || '').slice(0, 80)} | 출처: ${String(it.official || '').slice(0, 60)}`,
      metrics: st ? { vol: st.vol, doc: st.doc, ratio: st.ratio, stars: sc.stars, ts: now } : { stars: sc.stars, ts: now },
      status: st && sc.stars < 2 ? 'skipped' : 'pending',
      origin: 'scout',
    };
  });
  const skipped = prepared.filter((p) => p.status === 'skipped').length;
  if (dry) return { added: 0, skipped, dropped, prepared, costUsd, note: `(dry) 후보 ${prepared.length} · 버림 ${dropped.length}` };
  const added = addTopics(pool, prepared);
  savePool(pool);
  return {
    added, skipped, dropped, costUsd,
    note: `🔭 주제 스카우트: ${added}개 재고 추가(★2 미만 보류 ${skipped}) · 버림 ${dropped.length}` +
      (dropped.length ? ` — ${[...new Set(dropped.map((d) => d.why))].join(', ')}` : ''),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, loadConfig } = await import('./env.mjs');
  loadEnv();
  const r = await runScout(loadConfig(), { dry: !process.argv.includes('--write') });
  console.log(JSON.stringify(r, null, 1));
}
