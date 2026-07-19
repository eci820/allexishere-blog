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
//  · replenish.mjs       — 이미 자동으로 science/health/evergreen 재고를 채운다.
//    ⚠️ 큐레이터는 이걸 중복하지 않는다. 그 계급은 '자동 보충 중'이라고 알리기만 한다.
//    큐레이터가 실제로 메우는 건 replenish 가 손대지 않는 곳이다:
//      ① 🅿️ 주차 — parking.mjs 의 고정 시설 목록(36개)에서만 나온다. 소진되면 보충 없음.
//      ② GSC 검색어 갭 — 노출은 나는데 우리 글이 약한 검색어.
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
import { loadPool, liveIndex } from './lib/topicsPool.mjs';
import { PARKING_TOPICS } from './lib/parking.mjs';

loadEnv();

const DRY = process.argv.includes('--dry-run');
const SITE_DOMAIN = 'allexishere.com';
const PERF = path.join(ROOT, 'data', 'perf-history.json');
const PROPOSALS = path.join(AUTO_DIR, 'state', 'curator-proposals.json');

// 성과 기반 제안을 켜는 최소 이력 길이. 이 아래면 "근거 부족"을 명시한다.
const PERF_MATURE_DAYS = 7;
// 주간 제안 상한 — 브리핑 12개 구성을 흔들지 않도록 소량만.
const WEEKLY_CAP = 5;
// replenish.mjs 가 자동으로 채우는 계급(큐레이터는 손대지 않는다)
const AUTO_REPLENISHED = new Set(['science', 'health', 'evergreen']);

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
  return { known: [...known], knownCount: known.size, pendingParking, publishedParking };
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
function buildPrompt({ mature, forecast, parking, gaps, winners, existing }) {
  const tight = forecast.filter((f) => !f.autoReplenished && f.daysLeft <= 21);
  return `당신은 한국어 정보 블로그의 '주제 기획자'입니다. 아래 근거만 보고 새 주제를 제안하세요.

[제안 상한] 최대 ${WEEKLY_CAP}개. 억지로 채우지 말고 근거가 분명한 것만 내세요.

[근거 1 — 재고 소진 예보]
${forecast.map((f) => `- ${f.tier}: 재고 ${f.pending}개, 하루 ${f.perDay}개 소비 → 약 ${f.daysLeft}일치${f.autoReplenished ? ' (자동 보충 대상 — 제안하지 마세요)' : ' ⚠️ 자동 보충 없음'}`).join('\n')}
${tight.length ? `→ 우선 보강 대상: ${tight.map((f) => f.tier).join(', ')}` : '→ 급한 계급 없음'}

[근거 2 — 🅿️ 주차 시설 현황]
이미 목록에 있는 시설(${parking.knownCount}개, 여기 있는 건 절대 다시 제안하지 마세요):
${parking.known.join(', ')}

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

[출력 형식] JSON 배열 하나만(코드펜스·설명 금지):
[{"keyword":"검색어 형태 6~16자","tier":"parking|science|health|evergreen","series":"","angle":"어떤 각도로 쓸지 한 줄","why":"이 제안의 근거를 위 [근거 N] 중 무엇에 기대는지 한 줄"}]`;
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
      tier: ['parking', 'science', 'health', 'evergreen'].includes(x.tier) ? x.tier : 'evergreen',
      series: String(x.series || ''),
      angle: String(x.angle || '').slice(0, 80),
      why: String(x.why || '').slice(0, 80),
    }));
}

// 🔴 프롬프트만 믿지 않는다. 모델은 근거 데이터에 이끌려 '이미 글이 있는 대상'을
//    제안하는 경향이 있다(실제로 킨텍스·세텍을 제안했다). addTopics 의 matchLive 도
//    표기 변형에는 약하다 — 발행글이 "학여울역 SETEC"인데 제안이 "세텍 주차장"이면
//    토큰이 하나도 안 겹쳐 그대로 통과한다.
//    그래서 여기서 한 번 더 거른다: 제안어의 글자 조각이 발행글 제목에 들어있으면 의심.
// 수식어 — 시설명이 아니다. 이것만 겹치는 건 중복이 아니다.
// 첫 판에서 '콘서트+주차', '대구+주차' 처럼 주차 글이면 흔히 겹치는 단어 2개로
// 멀쩡한 새 시설(DGB대구은행파크)이 차단됐다. 시설명 단위로만 본다.
const MODIFIER = new Set([
  '주차', '주차장', '주차요금', '요금', '무료', '근처', '경기일', '콘서트', '공연', '행사',
  '총정리', '가이드', '완벽', '얼마', '기준', '조건', '정리', '방법', '위치', '비교', '최신',
  '할인', '팁', '꿀팁', '대안', '입구', '시간', '정산', '예약', '만차', '혼잡',
]);
// 표기 변형 — 한글↔영문 쌍. 발행글이 "학여울역 SETEC"인데 제안이 "세텍"이면
// 토큰이 하나도 안 겹쳐 그냥은 못 잡는다.
const ALIAS = new Map([['세텍', 'setec'], ['코엑스', 'coex'], ['디디피', 'ddp'], ['케이스포돔', 'kspo'], ['케이스포', 'kspo']]);

const facTokens = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^가-힣a-z0-9]/g, ' ')
  .split(/\s+/)
  .filter((w) => w.length >= 2 && !MODIFIER.has(w) && !/^\d+$/.test(w))
  .map((w) => ALIAS.get(w) || w);

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

// 🔴 프롬프트만 믿지 않는다. 모델은 근거 데이터에 이끌려 '이미 글이 있는 대상'을
//    제안하는 경향이 있다(실제로 킨텍스·세텍·올림픽공원을 제안했다).
export function flagOverlaps(proposals, publishedTitles) {
  return proposals.map((p) => {
    for (const t of publishedTitles) {
      const hit = sameFacility(p.keyword, t);
      if (hit) return { ...p, overlap: t, overlapOn: hit };
    }
    return { ...p, overlap: null, overlapOn: null };
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

  // 중복 의심 표시 — 승인 전에 사람이 알아볼 수 있게.
  const publishedTitles = liveIndex().map((p) => p.title).filter(Boolean);
  proposals = flagOverlaps(proposals, publishedTitles);
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
  L.push(`  ※ science·health·evergreen 은 replenish 가 매일 자동 보충합니다(큐레이터 대상 아님).`);

  if (gaps.length) {
    L.push('');
    L.push(`【검색어 갭】 노출은 나는데 클릭 0 (최근 28일 · 검색어 ${queryTotal}개 중)`);
    for (const g of gaps.slice(0, 6)) L.push(`  · "${g.query}" 노출 ${g.impressions} · 순위 ${g.position}`);
  }

  L.push('');
  L.push(`【승인 시 반영될 내용】 추가 예정 ${clean.length}개` + (flagged.length ? ` · 자동 제외 ${flagged.length}개` : ''));
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
    L.push(`🚫 자동 제외 ${flagged.length}개 — 이미 같은 시설 글이 있음`);
    for (const p of flagged) {
      L.push(`  · ${p.keyword}`);
      L.push(`    사유: "${p.overlapOn}" 이 겹침`);
      L.push(`    기존: ${p.overlap.slice(0, 38)}`);
    }
    L.push('  새로 쓰면 자기잠식입니다. 기존 글 개선은 SEO 감시 쪽에서 다룹니다.');
  } else {
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
  return { ok: true, message, proposals: clean, flagged, id, mature, days };
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
