#!/usr/bin/env node
// 📚 콘텐츠 큐레이터 (자율 개선 에이전트 3단계).
//
// 주 1회. "무엇을 새로 쓸까"를 제안한다. 제안까지만 — 재고에 넣는 것도 사람 승인 후다.
// 발행 경로는 만들지 않는다. 승인 시 기존 addTopics() 로만 재고에 들어가고,
// 거기서부터는 브리핑의 3중 방어(발행글 강매칭·중복·30일 쿨다운)를 그대로 탄다.
//
// LLM 호출 최대 1회(구독 CLI).
//
// ── 역할 경계(다른 에이전트·기존 로직과 겹치지 않게) ───────────────────
//  · 성과 분석가(daily)  — 지금 성과가 어떤가
//  · SEO 감시자(weekly)  — 기존 글이 괜찮은가 (유지)
//  · 큐레이터(여기)      — 무엇을 새로 쓸까 (생성)
//  · replenish.mjs       — 이미 자동으로 evergreen/tax·evergreen/parking·science/life 를 채운다.
//    ⚠️ 큐레이터는 이걸 중복하지 않는다. 그 계급은 '자동 보충 중'이라고 알리기만 한다.
//    큐레이터가 실제로 메우는 건 replenish 가 손대지 않는 곳이다:
//      ① 🅿️ 주차 — parking.mjs 의 고정 시설 목록(36개)에서만 나온다. 소진되면 보충 없음.
//      ② GSC 검색어 갭 — 노출은 나는데 우리 글이 약한 검색어.
//
// ── 🔴 니치(2026-08-11 축소) ──────────────────────────────────────────
// 주차 + 전기요금 + 세금·환급. 💪건강(영양제·운동·식단·검진)·통신비는 폐지된 주제다.
// 판정은 config.niche.allow 한 곳만 보는 nicheAllows() 로 한다 — 프롬프트에 적은 규칙과
// 코드가 갈라지면 카드에 보이는 판정과 실제 반영이 어긋난다(계약 §2·§3).
// 🔴 니치 필터는 반드시 '저장 전'에 건다. 승인 콜백(bot.mjs curate:)은 저장된 proposals 를
//    그대로 addVetted 로 넣으므로, 승인 단계에서 거르면 미리보기와 어긋난다.
//
// ── 🔴 데이터 성숙도 ──────────────────────────────────────────────────
// 성과 이력이 얕으면 성과 기반 제안을 억지로 하지 않는다. 1일치 데이터로 "이 주제가
// 뜬다"고 말하는 건 근거가 아니라 소음이다. 이력이 7일 이상 쌓이면 자동으로 켜진다.
//
// 단, GSC 검색어 데이터는 구글이 들고 있는 90일치라 우리 이력 길이와 무관하다.
// 그래서 갭 분석은 지금도 가능하다 — 이 둘을 섞지 않는 게 이 설계의 핵심이다.
//
// 사용:
//   node automation/curator.mjs --dry-run   # 화면 출력만(제안 파일·전송 없음)
//   node automation/curator.mjs             # 텔레그램 카드 전송 + 제안 저장
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, loadConfig, ROOT, AUTO_DIR } from './lib/env.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';
import { runClaude, unwrapClaudeJSON } from './lib/claudeCli.mjs';
import * as gsc from './lib/gsc.mjs';
import { loadPool, liveIndex, nicheAllows } from './lib/topicsPool.mjs';
import { PARKING_TOPICS, EXCLUDED_FACILITIES, expandParkingTopics } from './lib/parking.mjs';
import { MODIFIER, canonToken } from './lib/titleRules.mjs';

loadEnv();

const DRY = process.argv.includes('--dry-run');
const SITE_DOMAIN = 'allexishere.com';
const PERF = path.join(ROOT, 'data', 'perf-history.json');
const PROPOSALS = path.join(AUTO_DIR, 'state', 'curator-proposals.json');

// 성과 기반 제안을 켜는 최소 이력 길이. 이 아래면 "근거 부족"을 명시한다.
const PERF_MATURE_DAYS = 7;
// 주간 제안 상한 — 브리핑 12개 구성을 흔들지 않도록 소량만.
const WEEKLY_CAP = 5;
// replenish.mjs 가 자동으로 채우는 계급(큐레이터는 손대지 않는다).
// 💪health 는 2026-08-11 폐지 — 이제 아무도 채우지 않으므로 여기서도 뺀다.
// 🅿️parking 은 여기 없다: 자동 보충이 없어서 큐레이터가 유일한 공급원이다.
const AUTO_REPLENISHED = new Set(['science', 'evergreen']);

const perfDays = () => {
  try { return Object.keys(JSON.parse(fs.readFileSync(PERF, 'utf8')).days || {}).length; }
  catch { return 0; }
};

// ── 재고 예보 ─────────────────────────────────────────────────────────
// 계급별 pending 과 하루 소비량으로 소진 예상일을 낸다.
export function forecastInventory(pool, config) {
  const daily = {
    parking: config.parkingSlots?.enabled ? (config.parkingSlots.count ?? 5) : 0,
    ...(config.tierCounts || {}),
  };
  const out = [];
  const tiers = new Set([...Object.keys(daily), ...pool.topics.map((t) => t.tier)]);
  for (const tier of tiers) {
    const per = daily[tier] || 0;
    if (!per) continue; // 하루 0개 쓰는 계급은 마를 일이 없다
    const pending = pool.topics.filter((t) => t.tier === tier && t.status === 'pending').length;
    out.push({
      tier, pending, perDay: per,
      daysLeft: Math.floor(pending / per),
      autoReplenished: AUTO_REPLENISHED.has(tier),
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

// ── 주차 시설 갭 ──────────────────────────────────────────────────────
// parking.mjs 의 고정 목록에 없는 시설이 곧 '제안할 여지'다.
export function parkingFacilityState(pool) {
  const known = new Set(PARKING_TOPICS.map((t) => t.keyword.replace(/ 주차$/, '')));
  const pendingParking = pool.topics.filter((t) => t.tier === 'parking' && t.status === 'pending').length;
  const publishedParking = pool.topics.filter((t) => t.tier === 'parking' && t.status === 'published').length;
  // 🔴 v2.8 모디파이어 확장으로 아직 재고에 안 들어간 게 몇 개 남았나(읽기 전용).
  //    이게 0 이면 '고정 목록에서 더 뽑아낼 게 없다' = 새 시설이 들어오지 않는 한
  //    주차 공급은 순감한다는 뜻이다. 프롬프트에 숫자로 넘겨 모델이 추측하지 않게 한다.
  const have = new Set(pool.topics.map((t) => t.keyword));
  const expandable = expandParkingTopics().filter((e) => !have.has(e.keyword)).length;
  return { known: [...known], knownCount: known.size, pendingParking, publishedParking, expandable };
}

// ── GSC 검색어 갭 ─────────────────────────────────────────────────────
// 노출은 나는데 클릭이 없고 순위가 애매한(5~20위) 검색어 = 우리 글이 약한 지점.
// ⚠️ 이건 구글의 90일 데이터라 우리 이력 길이와 무관하게 지금도 쓸 수 있다.
export async function queryGaps(site, { minImpressions = 5, limit = 15 } = {}) {
  const rows = await gsc.searchAnalytics(site, {
    startDate: gsc.kstDaysAgo(31), endDate: gsc.kstDaysAgo(3), dimensions: ['query'], rowLimit: 300,
  });
  const gaps = rows
    .filter((r) => r.clicks === 0 && r.impressions >= minImpressions && r.position >= 5 && r.position <= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map((r) => ({ query: r.keys[0], impressions: r.impressions, position: +r.position.toFixed(1) }));
  const winners = rows
    .filter((r) => r.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 8)
    .map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions }));
  return { gaps, winners, total: rows.length };
}

// ── 제안 생성(LLM 1회) ────────────────────────────────────────────────
// export 이유: LLM 을 호출하지 않고 프롬프트를 그대로 렌더링해 검증할 수 있게.
// (--dry-run 은 runClaude 를 태우므로 프롬프트만 보고 싶을 때 쓸 수 없다)
export function buildPrompt({ mature, forecast, parking, gaps, winners, existing }) {
  const tight = forecast.filter((f) => !f.autoReplenished && f.daysLeft <= 21);
  return `당신은 한국어 정보 블로그의 '주제 기획자'입니다. 아래 근거만 보고 새 주제를 제안하세요.

[🔴 니치 — 이 밖의 주제는 단 하나도 내지 마세요]
이 블로그의 니치는 **주차 + 전기요금 + 세금·환급** 셋뿐입니다(2026-08-11 축소).
건강·영양제·운동·식단·검진·의료제도·보험·통신비는 **폐지된 주제**입니다. 절대 제안하지 마세요.
니치 밖 제안은 카드에 오르지도 못하고 전량 폐기됩니다(코드가 한 번 더 거릅니다).

tier/series 는 **아래 4가지 조합만** 허용합니다. 다른 조합을 쓰면 그 제안은 버려집니다:
 · tier=parking,   series=facility — 개별 시설 주차 (예: '전주월드컵경기장 주차')  ← 최우선
 · tier=evergreen, series=tax      — 세금·환급·공제·지원금 (예: '의료비세액공제 한도')
 · tier=evergreen, series=parking  — 주차 제도·과태료·요금 일반 (예: '전기차 충전방해 과태료')
 · tier=science,   series=life     — 가전·설비 전기요금 (예: '보일러 외출모드 전기요금')

[제안 상한] 최대 ${WEEKLY_CAP}개. 억지로 채우지 말고 근거가 분명한 것만 내세요.

[🔴 배분 — 주차 시설 발굴이 최우선]
가능하면 ${WEEKLY_CAP}개 중 **3개 이상을 tier=parking(새 시설)** 으로 내세요.
이유는 추측이 아니라 실측입니다:
 · 🅿️ 주차는 **자동 보충이 없습니다.** parking.mjs 의 고정 시설 목록에서만 나오고,
   그 목록을 늘리는 경로는 **당신의 제안 하나뿐**입니다.
 · v2.8 모디파이어 확장(요금/경기일/근처)으로 더 뽑아낼 수 있는 조합이 현재 **${parking.expandable}개** 남았습니다.
   ${parking.expandable === 0
      ? '즉 고정 목록에서 짜낼 것이 하나도 없습니다 — 새 시설이 들어오지 않으면 주차 재고는 발행할수록 순감합니다.'
      : '이것마저 소진되면 새 시설 없이는 주차 재고가 순감합니다.'}
 · 현재 주차 재고 ${parking.pendingParking}개 · 이미 발행 ${parking.publishedParking}개.
세금·전기요금은 replenish 가 매일 자동으로 채우므로, 당신이 굳이 채울 필요가 적습니다.
다만 주차 시설이 4대 기준(아래)을 만족하는 게 3개가 안 되면 **억지로 채우지 말고** 그만큼
세금·전기요금으로 내세요 — 기준 미달 시설을 넣는 것이 재고가 비는 것보다 나쁩니다.

[근거 1 — 재고 소진 예보]
${forecast.map((f) => `- ${f.tier}: 재고 ${f.pending}개, 하루 ${f.perDay}개 소비 → 약 ${f.daysLeft}일치${f.autoReplenished ? ' (자동 보충 대상 — 제안하지 마세요)' : ' ⚠️ 자동 보충 없음'}`).join('\n')}
${tight.length ? `→ 우선 보강 대상: ${tight.map((f) => f.tier).join(', ')}` : '→ 급한 계급 없음'}

[근거 2 — 🅿️ 주차 시설 현황]
이미 목록에 있는 시설(${parking.knownCount}개, 여기 있는 건 절대 다시 제안하지 마세요):
${parking.known.join(', ')}

🚫 아래 시설은 목록에 없지만 **이미 글이 있거나 지리적으로 겹칩니다 — 여기도 절대 제안 금지**입니다.
   괄호 안 이름은 같은 대상의 다른 표기이니 그것도 제안하지 마세요.
${EXCLUDED_FACILITIES.map((e) => `- ${e.name}${e.aliases?.length ? ` (=${e.aliases.join(', ')})` : ''} — ${e.reason}`).join('\n')}

새 시설을 제안한다면 아래 4대 기준을 모두 만족해야 합니다(검증된 성공 시설의 특성):
 ① 정기적으로 대형 행사가 열린다 ② 그날 주차 대란이 난다
 ③ "○○ 주차" 검색 의도가 명확하다 ④ 대중교통만으로는 애매해 차를 끌고 간다
시험장·학교·상권·터미널은 검색 의도가 약해 제외합니다.

[근거 3 — 참고용] 이미 우리 글이 노출되고 있는 검색어(최근 28일, 클릭은 0)
${gaps.length ? gaps.map((g) => `- "${g.query}" 노출 ${g.impressions} · 평균순위 ${g.position}`).join('\n') : '- (데이터 없음)'}
🔴 이 검색어들에 대해 새 글을 제안하지 마세요. 노출이 난다는 건 이미 우리 글이
   순위에 올라 있다는 뜻입니다. 여기에 새 글을 쓰면 기존 글과 서로 순위를 갉아먹습니다
   (자기잠식). 기존 글을 고치는 일은 다른 담당(SEO 감시)의 몫입니다.
   이 목록은 "우리가 어떤 영역에서 이미 노출을 얻고 있는지" 파악용으로만 쓰세요 —
   그 영역의 '아직 다루지 않은 다른 대상'을 찾는 힌트로만.

[근거 4 — 참고용] 클릭이 실제로 나는 검색어(수요가 검증된 영역)
${winners.length ? winners.map((w) => `- "${w.query}" 클릭 ${w.clicks}`).join('\n') : '- (데이터 없음)'}
🔴 마찬가지로 이 검색어 자체를 제안하지 마세요. 이미 글이 있습니다.
   "이 영역의 수요가 검증됐으니 같은 성격의 '다른 시설·다른 대상'을 다루자"는
   식으로만 활용하세요.

${mature
    ? '[성과 추세] 이력이 충분하므로 성과가 오르는 주제의 인접 주제도 제안 가능합니다.'
    : '[⚠️ 성과 근거 부족] 성과 이력이 아직 짧습니다. "요즘 뜨는 주제" 같은 추세 기반 추측은 하지 마세요. 위 재고·시설·검색어 근거로만 제안하세요.'}

[이미 재고·발행에 있는 것 — 중복 금지]
${existing.slice(0, 120).join(', ')}

[출력 형식] JSON 배열 하나만(코드펜스·설명 금지). series 는 반드시 채우세요(빈 값이면 폐기됩니다):
[{"keyword":"검색어 형태 6~16자","tier":"parking|evergreen|science","series":"facility|tax|parking|life","angle":"어떤 각도로 쓸지 한 줄","why":"이 제안의 근거를 위 [근거 N] 중 무엇에 기대는지 한 줄"}]`;
}

function parseProposals(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1) throw new Error('제안 JSON 배열을 찾지 못함');
  const arr = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error('배열이 아님');
  return arr
    .filter((x) => x && typeof x.keyword === 'string' && x.keyword.trim())
    .slice(0, WEEKLY_CAP)
    .map((x) => ({
      keyword: x.keyword.trim(),
      // 💪health 폐지(2026-08-11) — 화이트리스트에서 뺐다. 모르는 tier 는 evergreen 으로
      // 떨어지는데, 그러면 series 가 니치를 결정하므로 아래 nicheAllows 가 최종 판정한다.
      tier: ['parking', 'science', 'evergreen'].includes(x.tier) ? x.tier : 'evergreen',
      // 🅿️ 주차는 series 를 안 적어도 facility 로 본다(고정 목록·확장분이 모두 facility 다).
      // 그 밖의 계급은 비워두면 니치 판정이 불가능하므로 채워 넣지 않는다 — 임의로
      // 'tax' 같은 걸 넣으면 잡다한 주제가 세금 재고로 위장해 하한 카운트를 오염시킨다.
      series: String(x.series || (x.tier === 'parking' ? 'facility' : '')),
      angle: String(x.angle || '').slice(0, 80),
      why: String(x.why || '').slice(0, 80),
    }));
}

// 🔴 프롬프트만 믿지 않는다(§7 — 하한·금지는 '요청'이지 '보장'이 아니다).
//    니치 판정은 config.niche.allow 를 보는 nicheAllows() 한 곳만 쓴다 — 프롬프트에 적은
//    4가지 조합을 여기 또 하드코딩하면 두 곳이 갈라진다(SKILL.md §3).
//    반환: { kept, offNiche } — offNiche 는 조용히 버리지 않고 리포트에 수를 드러낸다.
export function splitByNiche(proposals) {
  const kept = [], offNiche = [];
  for (const p of proposals) (nicheAllows({ tier: p.tier, series: p.series }) ? kept : offNiche).push(p);
  return { kept, offNiche };
}

// 🔴 프롬프트만 믿지 않는다. 모델은 근거 데이터에 이끌려 '이미 글이 있는 대상'을
//    제안하는 경향이 있다(실제로 킨텍스·세텍을 제안했다). addTopics 의 matchLive 도
//    표기 변형에는 약하다 — 발행글이 "학여울역 SETEC"인데 제안이 "세텍 주차장"이면
//    토큰이 하나도 안 겹쳐 그대로 통과한다.
//    그래서 여기서 한 번 더 거른다: 제안어의 글자 조각이 발행글 제목에 들어있으면 의심.
// 수식어 — 시설명이 아니다. 이것만 겹치는 건 중복이 아니다.
// 첫 판에서 '콘서트+주차', '대구+주차' 처럼 주차 글이면 흔히 겹치는 단어 2개로
// 멀쩡한 새 시설(DGB대구은행파크)이 차단됐다. 시설명 단위로만 본다.
// MODIFIER·canonToken 은 lib/titleRules.mjs 에서 가져온다 — 원래 여기 따로 정의돼 있었는데,
// matchLive 의 subject 모드가 같은 목록을 쓰게 되면서 정의가 두 곳이 됐다. 두 곳에 적으면
// 반드시 어긋나고(SKILL.md §3), 어긋난 경고는 사람이 믿지 않게 되어 없느니만 못해진다.
//
// 🔴 ALIAS 를 직접 쓰지 않고 canonToken 을 경유한다. ALIAS 는 정규화의 '일부'일 뿐이라
//    직접 쓰면 나중에 붙는 규칙(위치접미 절단·포함관계)이 큐레이터에만 도달하지 않는다.
//    실제로 그런 상태였다 — 재고·발행 쪽은 '여의도역'을 '여의도'로 보는데 큐레이터만
//    둘을 다른 시설로 봤다. 정규화가 갈라지면 카드에 보이는 판정과 실제 반영이 어긋난다(계약 §2).
const facTokens = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^가-힣a-z0-9]/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 2 && !MODIFIER.has(w) && !/^\d+$/.test(w))
  .map(canonToken);

// 두 제목이 '같은 시설'을 가리키나.
//  · 시설명은 대개 4자 이상이다(올림픽공원·DGB대구은행파크·전주월드컵경기장).
//    그래서 4자 이상 토큰이 겹칠 때만 같은 시설로 본다 — '대구'(2자) 같은
//    지역명이 우연히 겹치는 걸로는 차단하지 않는다.
//  · 첫 대상어(주제어)가 같아도 같은 시설로 본다.
export function sameFacility(aTitle, bTitle) {
  const a = facTokens(aTitle), b = facTokens(bTitle);
  if (!a.length || !b.length) return null;
  const shared = a.filter((w) => b.includes(w) && w.length >= 4);
  if (shared.length) return shared[0];
  if (a[0] && a[0] === b[0]) return a[0];
  return null;
}

// 제외 목록(parking.mjs EXCLUDED_FACILITIES) 대조.
// 🔴 발행글 제목 대조보다 **먼저** 본다. 제외 사유가 '이미 발행'만이 아니기 때문이다 —
//    KSPO돔은 발행글 제목 어디에도 없지만 올림픽공원 안이라 지리적으로 겹친다.
//    제목만 대조하면 이런 건 영원히 안 걸리고, 매주 같은 제안이 다시 올라온다.
export function excludedHit(keyword) {
  for (const e of EXCLUDED_FACILITIES) {
    for (const n of [e.name, ...(e.aliases || [])]) {
      const hit = sameFacility(keyword, n);
      if (hit) return { on: hit, name: e.name, reason: e.reason };
    }
  }
  return null;
}

// 🔴 프롬프트만 믿지 않는다. 모델은 근거 데이터에 이끌려 '이미 글이 있는 대상'을
//    제안하는 경향이 있다(실제로 킨텍스·세텍·올림픽공원을 제안했다).
//
// 🔴 poolKeywords(재고 정확일치)를 보는 이유 — 계약 §2 위반을 미리보기에서 막는다.
//    프롬프트의 중복 금지 목록은 existing.slice(0,120) 인데 실제 existing 은 429개라
//    309개가 잘려 나간다. 잘린 구간에 주차 재고가 몰려 있어(전주·포항·대구·수원월드컵)
//    모델이 이미 재고에 있는 시설을 다시 제안했다. 그러면 카드엔 "추가 예정 3개"라고
//    보여주고 addVetted 는 2개만 넣는다 — 사람이 승인한 것과 반영된 것이 어긋난다.
//    (2026-08-11 실측: 전주월드컵경기장 주차 = existing[292], 8/10 카드에도 같은 일)
//
//    🔴 판정 기준은 addVetted 와 **정확히 같아야** 한다 — addVetted 는 `have.has(keyword)`,
//    즉 키워드 정확일치로만 건너뛴다. 여기서 sameFacility 같은 느슨한 판정을 쓰면
//    반대 방향으로 어긋난다(미리보기는 뺐는데 addVetted 는 넣는다). 그래서 정확일치만 본다.
//    slice(0,120) 상한은 일부러 건드리지 않는다 — 프롬프트 길이·비용을 늘리지 않고
//    '보여준 것과 반영되는 것'만 일치시키는 게 이 수정의 목적이다.
export function flagOverlaps(proposals, publishedTitles, poolKeywords = new Set()) {
  return proposals.map((p) => {
    const ex = excludedHit(p.keyword);
    if (ex) return { ...p, overlap: `${ex.name} (${ex.reason})`, overlapOn: ex.on, excluded: true, inStock: false };
    if (poolKeywords.has(p.keyword)) {
      return { ...p, overlap: '재고에 이미 있는 키워드', overlapOn: p.keyword, excluded: false, inStock: true };
    }
    for (const t of publishedTitles) {
      const hit = sameFacility(p.keyword, t);
      if (hit) return { ...p, overlap: t, overlapOn: hit, excluded: false, inStock: false };
    }
    return { ...p, overlap: null, overlapOn: null, excluded: false, inStock: false };
  });
}

// 승인 시 실제로 재고에 넣을 것들. 카드에 미리 보여준 것과 정확히 같아야 한다.
//
// 🔴 addTopics 의 matchLive(토큰 2개 겹침)를 쓰지 않는 이유:
//    주차 글은 '콘서트·대구·주차' 같은 단어가 흔히 겹쳐 다른 시설끼리도 score 2 가
//    나온다. 실제로 DGB대구은행파크가 엑스코 때문에, 올림픽공원이 고척스카이돔 때문에
//    차단됐다 — 둘 다 우연이다. 여기서는 그보다 정밀한 시설명 대조를 쓴다.
//    (같은 시설 중복은 위 flagOverlaps 가 이미 걸러낸 뒤다.)
export function addVetted(pool, proposals) {
  const have = new Set(pool.topics.map((t) => t.keyword));
  const now = new Date().toISOString();
  let added = 0;
  for (const p of proposals) {
    if (!p.keyword || have.has(p.keyword)) continue; // 완전히 같은 키워드만 중복 처리
    pool.topics.push({
      id: 't' + Math.abs([...p.keyword].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)).toString(36),
      keyword: p.keyword, tier: p.tier || 'evergreen', series: p.series || '', angle: p.angle || '',
      status: 'pending', slug: null, addedAt: now, lastProposedAt: null, metrics: null, source: 'agent',
    });
    have.add(p.keyword); added++;
  }
  return added;
}

function saveProposals(entry) {
  fs.mkdirSync(path.dirname(PROPOSALS), { recursive: true });
  let map = {};
  try { map = JSON.parse(fs.readFileSync(PROPOSALS, 'utf8')); } catch {}
  const id = 'c' + Date.now().toString(36);
  map[id] = entry;
  fs.writeFileSync(PROPOSALS, JSON.stringify(map, null, 1));
  return id;
}

// ── 본체 ──────────────────────────────────────────────────────────────
export async function runCurator({ dry = false } = {}) {
  const config = loadConfig();
  const pool = loadPool();
  if (!pool) throw new Error('재고(topics-pool.json)를 읽지 못했습니다');

  const days = perfDays();
  const mature = days >= PERF_MATURE_DAYS;
  const forecast = forecastInventory(pool, config);
  const parking = parkingFacilityState(pool);

  const resolved = await gsc.resolveSiteUrl(SITE_DOMAIN);
  let gaps = [], winners = [], queryTotal = 0;
  if (resolved.siteUrl) {
    try {
      const q = await queryGaps(resolved.siteUrl);
      gaps = q.gaps; winners = q.winners; queryTotal = q.total;
    } catch (e) { console.error('[curator] 검색어 조회 실패(계속):', e.message); }
  }

  const existing = [...pool.topics.map((t) => t.keyword), ...liveIndex().slice(0, 80).map((p) => p.title)];
  const prompt = buildPrompt({ mature, forecast, parking, gaps, winners, existing });

  let proposals = [];
  let llmError = null;
  try {
    const out = await runClaude(prompt, { cwd: os.tmpdir(), timeoutMs: (config.cliTimeoutSeconds || 240) * 1000, extraArgs: config.cliModel ? ['--model', config.cliModel] : [] });
    proposals = parseProposals(unwrapClaudeJSON(out).result);
  } catch (e) {
    llmError = e.message;
    console.error('[curator] 제안 생성 실패:', e.kind || 'error', e.message);
  }

  // 🔴 니치 밖 폐기를 '저장 전·중복판정 전'에 한다. 승인 콜백은 저장된 목록을 그대로
  //    addVetted 로 넣으므로, 여기서 거른 결과가 곧 사람이 카드에서 본 것이 된다(계약 §2).
  const { kept, offNiche } = splitByNiche(proposals);
  proposals = kept;

  // 중복 의심 표시 — 승인 전에 사람이 알아볼 수 있게.
  const publishedTitles = liveIndex().map((p) => p.title).filter(Boolean);
  // 재고 정확일치 판정용 — addVetted 의 have 와 같은 집합이어야 한다(계약 §2).
  const poolKeywords = new Set(pool.topics.map((t) => t.keyword));
  proposals = flagOverlaps(proposals, publishedTitles, poolKeywords);
  const clean = proposals.filter((p) => !p.overlap);
  const flagged = proposals.filter((p) => p.overlap);

  // ── 리포트 ──
  const L = [];
  L.push(`📚 콘텐츠 큐레이터 ${gsc.kstDaysAgo(0).slice(5)}`);
  L.push('주 1회 · 제안만 합니다. 재고 추가는 승인 후.');
  L.push('');

  L.push(`【데이터 성숙도】 성과 이력 ${days}일`);
  if (!mature) {
    L.push(`  ⚠️ 성과 근거 부족 (${PERF_MATURE_DAYS}일 이상 필요)`);
    L.push(`  → 추세 기반 제안은 하지 않습니다. 재고·시설·검색어 근거로만 제안합니다.`);
    L.push(`  → ${PERF_MATURE_DAYS - days}일 뒤부터 성과 기반 제안이 자동으로 켜집니다.`);
  } else {
    L.push(`  ✅ 성과 기반 제안 가능`);
  }

  L.push('');
  L.push('【재고 소진 예보】');
  for (const f of forecast) {
    const tag = f.autoReplenished ? '자동 보충됨' : (f.daysLeft <= 21 ? '⚠️ 자동 보충 없음' : '자동 보충 없음');
    L.push(`  ${f.tier.padEnd(9)} ${String(f.pending).padStart(3)}개 · 하루 ${f.perDay} → 약 ${f.daysLeft}일치 (${tag})`);
  }
  L.push(`  ※ science·evergreen 은 replenish 가 매일 자동 보충합니다(큐레이터 대상 아님).`);
  L.push(`  ※ 🅿️parking 은 자동 보충이 없습니다 — 고정 목록 확장 여지 ${parking.expandable}개 · 큐레이터가 유일한 공급원입니다.`);

  if (gaps.length) {
    L.push('');
    L.push(`【검색어 갭】 노출은 나는데 클릭 0 (최근 28일 · 검색어 ${queryTotal}개 중)`);
    for (const g of gaps.slice(0, 6)) L.push(`  · "${g.query}" 노출 ${g.impressions} · 순위 ${g.position}`);
  }

  L.push('');
  L.push(`【승인 시 반영될 내용】 추가 예정 ${clean.length}개`
    + (flagged.length ? ` · 자동 제외 ${flagged.length}개` : '')
    + (offNiche.length ? ` · 니치 밖 폐기 ${offNiche.length}개` : ''));
  L.push('');
  if (clean.length) {
    L.push(`💡 추가 예정 ${clean.length}개 (상한 ${WEEKLY_CAP})`);
    clean.forEach((p, i) => {
      L.push(`  ${i + 1}. [${p.tier}] ${p.keyword}`);
      if (p.angle) L.push(`     각도: ${p.angle}`);
      if (p.why) L.push(`     근거: ${p.why}`);
    });
    L.push('');
    L.push(`[📥 재고 추가]를 누르면 위 ${clean.length}개가 그대로 들어갑니다.`);
    L.push('추가돼도 발행은 아니고 브리핑 후보가 될 뿐이며, 발행은 [✅승인]이 따로 필요합니다.');
  }
  if (flagged.length) {
    L.push('');
    L.push(`🚫 자동 제외 ${flagged.length}개 — 이미 재고에 있거나, 같은 시설 글이 있거나, 제외 목록에 있음`);
    for (const p of flagged) {
      L.push(`  · ${p.keyword}`);
      if (p.inStock) {
        L.push(`    사유: 이미 재고에 있는 키워드 — 승인해도 중복으로 건너뜁니다`);
      } else {
        L.push(`    사유: "${p.overlapOn}" 이 겹침`);
        L.push(p.excluded ? `    제외 목록: ${p.overlap}` : `    기존: ${p.overlap.slice(0, 38)}`);
      }
    }
    L.push('  새로 쓰면 자기잠식입니다. 기존 글 개선은 SEO 감시 쪽에서 다룹니다.');
  }
  // 니치 밖이 계속 돌아오면 프롬프트가 안 먹히고 있다는 뜻 — 조용히 버리지 않고 수를 드러낸다.
  if (offNiche.length) {
    L.push('');
    L.push(`🚫 니치 밖 폐기 ${offNiche.length}개 — 주차·전기요금·세금 외 주제`);
    for (const p of offNiche) L.push(`  · ${p.keyword} [${p.tier}/${p.series || '-'}]`);
    L.push('  반복되면 프롬프트를 손보세요(config.niche.allow 가 판정 기준입니다).');
  }
  // 🔴 '없다'는 말은 정말 아무것도 없을 때만 한다. 예전에는 이 문장이 flagged 의 else 에
  //    붙어 있어서, 추가 예정 3개를 나열해 놓고 바로 아래에 "제안할 것이 없습니다"를
  //    같이 찍었다. 카드가 자기 말과 어긋나면 사람은 카드 전체를 믿지 않게 된다(계약 §2).
  if (!clean.length && !flagged.length && !offNiche.length) {
    L.push(llmError ? `❌ 제안 생성 실패: ${llmError}` : '제안할 것이 없습니다(근거가 분명한 주제 없음).');
  }

  const message = L.join('\n');
  let id = null;
  if (!dry && clean.length) {
    id = saveProposals({ ts: Date.now(), date: gsc.kstDaysAgo(0), proposals: clean, mature, perfDays: days });
  }
  if (!dry) {
    await sendMessage(
      process.env.TELEGRAM_CHAT_ID, message,
      clean.length ? inlineButtons([[
        { text: '📥 재고 추가', callback_data: 'curate:' + id },
        { text: '❌ 넘기기', callback_data: 'cancel:x' },
      ]]) : undefined
    );
  }
  return { ok: true, message, proposals: clean, flagged, offNiche, id, mature, days };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCurator({ dry: DRY })
    .then((r) => { console.log(r.message); if (DRY) console.log('\n(--dry-run: 전송·저장 안 함)'); })
    .catch(async (e) => {
      console.error('[curator] 실패:', e.message);
      if (!DRY) { try { await sendMessage(process.env.TELEGRAM_CHAT_ID, `❌ 큐레이터 실패: ${e.message}`); } catch {} }
      process.exit(1);
    });
}
