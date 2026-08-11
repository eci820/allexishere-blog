// 키워드 브리핑 v2.7 + 축2(주제 재고). 🔴 2026-08-11 니치 축소 — 주차 + 전기요금 + 세금·환급.
//   배분: 🅿️주차 2 / 🔬전기요금(science/life) 1 / 🌲세금·주차일반(evergreen/tax·parking) 2 / 📅캘린더 1 / 📂갱신 1 = 5.
//   🔥실검·💪건강은 폐지(tierCounts 0 + backfillOrder 제외 + niche.allow 제외 — 셋 다 해야 실제로 안 나온다).
//   재고 픽은 4중 방어(status·30일 쿨다운·발행매칭·니치)로. 재고 부족 시 자동 보충(니치 안만 카운트).
//   + 📂 갱신 후보(다시 게시할 가치 있는 글) 1~2개를 사유와 함께 별도 노출(탭 시 '갱신 진단' 먼저).
// 하루 1회(오전 10시경) 발송. 버튼 탭 = 초안 생성(bot.mjs). 대원칙 불변: 게시는 사람 승인만.
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR, ROOT, loadConfig } from './lib/env.mjs';
import { briefingCandidates } from './keywords.mjs';
import { calendarRadar } from './lib/calendar.mjs';
import { enrichKeywords, statLine } from './lib/naver.mjs';
import { scoreKeyword, starBar, WARN_LABEL } from './lib/suitability.mjs';
import { hasExistingPost } from './lib/topics.mjs';
import { updateCandidates } from './lib/updateTrack.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';
import { stashPending, flushPending } from './lib/briefing-outbox.mjs';

const STATE = path.join(AUTO_DIR, 'state');
const BRIEFED = path.join(STATE, 'briefed.json'); // keyword -> ts (30일 보관)
const KWMAP = path.join(STATE, 'kwmap.json'); // id -> {keyword, source, gossip}

const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const icon = (src) =>
  src === 'calendar' ? '📅' : src === 'parking' ? '🅿️' : src === 'trend' ? '🔥' : src === 'finance' ? '💰'
  : src === 'realestate' ? '🏠' : src === 'science' ? '🔬' : src === 'health' ? '💪' : '🌲';
// 정렬 키: 검색량 내림차순(없으면 맨 뒤)
const volKey = (s) => (s && s.vol != null ? s.vol : -1);

// 신규 계급(🔬과학·💪건강·🌲에버그린) 배분 — 목표 need 를 맞추도록 base 에서 가감.
//  · 부족분은 에버그린→과학 순으로 보충(니치 안 재고가 깊은 순).
//  · 초과분(need<base)은 에버그린→과학→건강 순으로 감축.
//  · trend(실검)는 항상 0 — 폐지된 계급.
export function distributeNewTier(need, base) {
  const c = { trend: 0, science: base.science ?? 2, health: base.health ?? 2, evergreen: base.evergreen ?? 1 };
  let cur = c.science + c.health + c.evergreen;
  // 🔴 base 가 0 인 계급은 add 대상에서 뺀다 — 안 그러면 폐지한 계급이 여기서 되살아난다.
  //    예전 add = ['health','science'] 는 tierCounts.health=0 이어도 need > base합 인 날
  //    health 를 +1 해서 '껐는데 계속 나오는' 상태를 만들었다(읽기전용 시뮬 2026-08-11 실측).
  //    add 가 비어 need 를 못 채우면 §2.5 백필로 넘어간다 — 우아한 저하가 의도된 동작이다.
  const add = ['evergreen', 'science', 'health'].filter((t) => (base[t] ?? 0) > 0);
  for (let k = 0; cur < need && add.length; k++, cur++) c[add[k % add.length]]++;
  const trim = ['evergreen', 'science', 'health'];
  for (let k = 0; cur > need && k < 999; k++) {
    const t = trim[k % trim.length];
    if (c[t] > 0) { c[t]--; cur--; }
  }
  return c;
}

// dryRun: 전송·이력저장·재고소진·LLM 보충 없이 '오늘 나올 카드'만 화면에 찍는다.
//   🔴 재고 소진(pickForBrief 가 찍는 lastProposedAt)까지 되돌려야 진짜 무해하다 — 안 그러면
//      '확인만 했는데 오늘 글감이 30일 쿨다운에 잠기는' 사고가 난다. 그래서 pool 을 스냅샷 후 복원한다.
//   🔴 다른 에이전트(analyst·seo-watch·curator·quality)와 달리 브리핑에만 없던 플래그다 —
//      설정을 바꾼 뒤 '내일 뭐가 나올지'를 실제 코드로 확인할 방법이 없었다(2026-08-11 추가).
export async function runBriefing(opts = {}) {
  if (!opts.dryRun) return _runBriefing(opts);
  const POOL = path.join(ROOT, 'data', 'topics-pool.json');
  const snapshot = fs.readFileSync(POOL, 'utf8');
  try {
    return await _runBriefing(opts);
  } finally {
    fs.writeFileSync(POOL, snapshot); // 소진·주입 원복(실패해도 반드시)
    console.log('\n(--dry-run: 전송·이력저장 안 함 · 재고 소진 원복 완료 · 재고 보충 LLM 호출 건너뜀)');
  }
}

async function _runBriefing({ chatId, config, dryRun = false } = {}) {
  config = config || loadConfig();
  fs.mkdirSync(STATE, { recursive: true });
  const say = dryRun ? async (_c, text) => console.log('\n[알림] ' + text) : sendMessage;

  // 0') 지난 실행에서 전송 못 한 카드가 있으면 먼저 재전송한다(오늘 카드로 kwmap 을
  //     덮어쓰기 전에 — 지난 카드의 버튼 id 가 아직 kwmap 에 유효할 때).
  if (chatId && !dryRun) {
    try {
      const f = await flushPending(chatId);
      if (f.sent) console.log(`[briefing] 미전송 카드 ${f.sent}건 재전송 성공`);
    } catch (e) { console.error('[briefing] 재전송 확인 실패:', e.message); }
  }

  const briefed = load(BRIEFED);
  const cut = Date.now() - 30 * 864e5;
  for (const k of Object.keys(briefed)) if (briefed[k] < cut) delete briefed[k];
  const exclude = new Set(Object.keys(briefed));

  // 0) 재고 자동 보충(니치 안 제안가능 < 30이면 claude-cli로 20개 보충). 실패해도 브리핑은 계속.
  //    dry-run 은 건너뛴다 — 확인 한 번에 LLM 비용이 붙고 재고가 늘어 '오늘 카드'가 달라진다.
  if (dryRun) {
    const { loadPool, eligibleCount } = await import('./lib/topicsPool.mjs');
    const p = loadPool();
    console.log(`[dry] 재고 보충 건너뜀 — 니치 안 제안가능 ${eligibleCount(p, null, { niche: true })}개(임계 30) · ` +
      `🌲세금 ${eligibleCount(p, 'evergreen', { series: 'tax' })}(하한 8) · 🔬전기요금 ${eligibleCount(p, 'science', { series: 'life' })}(하한 5)`);
  } else {
    try {
      const { replenishIfLow } = await import('./lib/replenish.mjs');
      const rep = await replenishIfLow(config);
      if (rep && rep.note && chatId) await sendMessage(chatId, rep.note);
    } catch (e) {
      console.error('[briefing] 재고 보충 실패:', e.message);
    }
  }

  // 1) 캘린더 레이더(D-14~D-3, 최대 config.calendarCount — 기본 2)
  //    🔴 배분 인자는 config 한 곳에서만 조정한다. 하드코딩 2 였던 시절, briefingCount 만
  //    낮춰도 캘린더가 줄지 않아 '총수를 줄였는데 안 줄어드는' 오해가 실제로 났다.
  const cal = calendarRadar(config.calendarCount ?? 2).filter((c) => !exclude.has(c.keyword));
  for (const c of cal) exclude.add(c.keyword); // 주차/에버그린과 중복 방지

  // 1.5) 🅿️ 주차 슬롯(v2.8 상시·모디파이어) — 재고 주입 후 오늘치 '최대 count'개 픽(있는 만큼만).
  //      부족분은 억지로 안 채우고 아래 신규 배분이 12까지 메운다(우아한 폴백).
  const { seedParkingTopics, parkingSlotState, pickParking, parkingStock } = await import('./lib/parking.mjs');
  const pState = parkingSlotState(config);
  let parking = [];
  if (pState.active) {
    try {
      seedParkingTopics(config); // v2.8: base 은퇴 + 모디파이어 주입(멱등). 발행글 강매칭분 자동 제외
      const { loadPool, eligibleCount } = await import('./lib/topicsPool.mjs');
      const pool = loadPool();
      parking = pickParking(pool, pState.count, exclude);
      for (const p of parking) exclude.add(p.keyword);
      // 재고 부족 알림 — 🔴 pending 이 아니라 '제안 가능(eligible)' 수를 봐야 한다.
      // pickForBrief 는 30일 제안 쿨다운으로 한 번 더 걸러내므로 pending 이 많아도 0개가 나올 수 있다.
      // 실측(2026-07-25): pending 33 / 제안가능 0 인데 임계 10 을 넘어 알림이 침묵했고,
      // 주력인 주차가 3주간 조용히 0개로 나오는 상태를 아무도 몰랐다. 두 숫자를 함께 알린다.
      const threshold = config.parkingSlots?.lowStockThreshold ?? 10;
      const fresh = eligibleCount(pool, 'parking');
      const stock = parkingStock(pool);
      if (chatId && fresh < threshold) {
        await say(chatId, `🔔 주차 재고 부족 — 제안 가능 ${fresh}개(전체 pending ${stock}개, 임계 ${threshold}).${stock > fresh ? ` 차이 ${stock - fresh}개는 30일 제안 쿨다운 중입니다.` : ''}\nlib/parking.mjs PARKING_TOPICS 에 새 시설을 추가하세요.`);
      }
    } catch (e) { console.error('[briefing] 주차 슬롯 실패:', e.message); }
  }

  // 1.6) 📂 갱신 후보를 미리 계산(개수가 신규 배분을 좌우). 표시는 섹션 6에서. updateCandidates는 읽기전용.
  let updates = [];
  try { updates = updateCandidates(Math.min(2, config.updateCount ?? 2)); }
  catch (e) { console.error('[briefing] 갱신 후보 계산 실패:', e.message); }

  // 2) 신규 배분: 총 briefingCount = 주차 + 갱신 + 캘린더 + 신규(🔬·🌲).
  //    갱신/캘린더/주차가 모자란 날은 부족분을 신규(config.backfillOrder 순)로 메워 총수를 유지한다.
  const TOTAL = config.briefingCount || 12;
  const need = Math.max(0, TOTAL - parking.length - updates.length - cal.length);
  const counts = distributeNewTier(need, config.tierCounts || { science: 2, health: 2, evergreen: 1 });
  const { candidates, source, note } = await briefingCandidates(config, exclude, counts);

  // 2.5) 총수 보증 — 캘린더 공백·재고 쿨다운으로 신규가 목표에 못 미치면 config.backfillOrder 순으로 보충.
  //     재고가 정말 마른 날은 총수 미만으로 우아하게 저하(replenishIfLow가 앞에서 보충 시도).
  let short = TOTAL - parking.length - updates.length - cal.length - candidates.length;
  if (short > 0) {
    try {
      const { seedPoolIfEmpty, pickForBrief } = await import('./lib/topicsPool.mjs');
      const pool = seedPoolIfEmpty();
      const ex2 = new Set([...exclude, ...parking.map((p) => p.keyword), ...cal.map((c) => c.keyword), ...candidates.map((c) => c.keyword)]);
      // 🔴 백필 순서는 config 한 곳에서 정한다. 하드코딩 ['health','science','evergreen'] 이던 시절
      //    health 가 맨 앞이라 tierCounts.health=0 이어도 부족분이 전부 health 로 흘렀다 —
      //    계급을 '끄는' 실질은 tierCounts 가 아니라 이 목록에서 빼는 것이다.
      for (const t of (config.backfillOrder || ['evergreen', 'science'])) {
        if (short <= 0) break;
        for (const p of pickForBrief(pool, t, short, ex2)) {
          candidates.push({ keyword: p.keyword, source: p.source, gossip: false, id: p.id, angle: p.source === 'science' ? p.series : undefined, poolAngle: p.angle });
          ex2.add(p.keyword); short--;
        }
      }
    } catch (e) { console.error('[briefing] 12개 보충 실패:', e.message); }
  }

  const all = [...parking, ...cal, ...candidates];
  if (!all.length) {
    if (chatId) await say(chatId, '🗞 브리핑: 새 후보가 없습니다(모두 발행/기출).');
    return 0;
  }

  // 3) 네이버 지표(검색량·문서수·비율) — 24h 캐시, 키 부재/오류 시 우아한 저하
  let stats = {};
  try {
    stats = await enrichKeywords(all.map((c) => c.keyword));
  } catch (e) {
    console.error('[briefing] 지표 실패:', e.message);
  }

  // 4) 계급별 정렬 + 표시 순서(🅿️주차 → 🔬과학 → 💪건강 → 📅캘린더 → 🌲에버그린).
  //    🔥실검은 폐지(tierCounts.trend=0). 🅿️주차 = 우선순위(삽입) 순 / 🔬·💪·🌲 = 검색량 내림차순 /
  //    📅캘린더 = D-day 임박순(선점). 💰금융·🏠부동산은 격리(quarantined)로 후보에 없음.
  const byVol = (a, b) => volKey(stats[b.keyword]) - volKey(stats[a.keyword]);
  const tier = (src) => candidates.filter((c) => c.source === src).sort(byVol);
  const calSorted = cal.slice().sort((a, b) => a.daysUntil - b.daysUntil); // 임박순
  const ordered = [...parking, ...tier('science'), ...tier('health'), ...calSorted, ...tier('evergreen')];

  // 5) 메시지 + 버튼 + kwmap
  const kwmap = load(KWMAP);
  let n = Object.keys(kwmap).length;
  const lines = [];
  const rows = [];
  let i = 1;
  for (const c of ordered) {
    const id = 'k' + Math.abs(hash(c.keyword)).toString(36) + '_' + n++;
    kwmap[id] = { keyword: c.keyword, source: c.source, gossip: !!c.gossip, ...(c.angle ? { angle: c.angle } : {}), ...(c.poolAngle ? { poolAngle: c.poolAngle } : {}) };
    briefed[c.keyword] = Date.now();
    const title = c.source === 'calendar' ? `${c.label} (최적 발행 D-${c.daysUntil})` : c.keyword;
    const st = statLine(stats[c.keyword]);
    const badge = c.updateTarget || hasExistingPost(c.keyword) ? ' 📂기존글' : '';
    const sc = scoreKeyword(c, stats[c.keyword]); // 적합도 별점·이유·경고
    const sub = [`   ${starBar(sc.stars)} ${sc.reason}`];
    if (st) sub.push(`   ${st}`);
    // 글감 각도(판단형 우선). 📅캘린더 = calendar.json angles / 🔬·💪 = 재고 poolAngle.
    if (c.source === 'calendar' && (c.angleJudgment || c.angleKnowledge)) {
      sub.push(c.angleJudgment ? `   ✍️ 판단형 각도: ${c.angleJudgment}` : `   ✍️ 지식형 각도: ${c.angleKnowledge}`);
    } else if ((c.source === 'science' || c.source === 'health' || c.source === 'parking') && c.poolAngle) {
      sub.push(`   ✍️ 판단 각도: ${c.poolAngle}`);
    }
    if (sc.warn) sub.push(`   ${WARN_LABEL}`);
    lines.push(`${i}. ${icon(c.source)} ${title}${badge}\n` + sub.join('\n'));
    rows.push([{ text: `${icon(c.source)} ${(c.source === 'calendar' ? c.label : c.keyword).slice(0, 40)}`, callback_data: 'gen:' + id }]);
    i++;
  }

  // 6) 📂 갱신 후보 — 1.6에서 미리 계산한 updates(하루 상한 2) 를 표시. 초과분은 다음날 다시 후보.
  let upCount = 0;
  for (const u of updates) {
    const id = 'u' + Math.abs(hash(u.slug)).toString(36) + '_' + n++;
    kwmap[id] = { type: 'update', slug: u.slug, title: u.title, url: u.url };
    lines.push(`${i}. 📂 갱신: ${u.title}\n   🔧 사유: ${u.reasons.join(' · ')}`);
    rows.push([{ text: `📂 갱신 진단: ${u.title.slice(0, 34)}`, callback_data: 'updiag:' + id }]);
    i++; upCount++;
  }

  if (!dryRun) {
    fs.writeFileSync(KWMAP, JSON.stringify(kwmap, null, 1));
    fs.writeFileSync(BRIEFED, JSON.stringify(briefed));
  }

  const parkNote = pState.active
    ? `🅿️주차 ${parking.length}칸${parking.length < pState.count ? '(재고만큼)' : ''} `
    : (config.parkingSlots?.enabled ? `🅿️주차 만료(원복) ` : '');
  const header =
    `🗞 키워드 브리핑 v2.7 (${source || 'evergreen'}${note ? ', ⚠️' + note : ''})\n` +
    `탭 = 초안 생성(순차). ${parkNote}🔬전기요금 🌲세금·환급 📅선점 · 지표=검색량·문서수·비율\n` +
    `★적합도 = 경쟁·비율·의도·수명·단가 종합(★5 적합↔★1 비추천). 게시는 사람 승인만.\n` +
    `✍️ 각도 = 원리 → 돈 드는 판단(선택·비용·시기)으로 연결.` +
    (upCount ? ` 📂갱신 = 탭하면 '갱신 진단' 먼저(즉시 생성 아님).\n` : `\n`);
  // 선정·kwmap 은 위에서 이미 persist 됐다. 전송만 실패하면 카드를 대기열에 남겨
  // 다음 실행/봇 기동에서 재전송한다 — 크래시하지 않는다(선정 결과를 지키기 위해).
  const cardText = header + '\n' + lines.join('\n\n');
  if (dryRun) {
    console.log('\n' + '='.repeat(70) + '\n' + cardText + '\n' + '='.repeat(70));
    return ordered.length + upCount;
  }
  try {
    await sendMessage(chatId, cardText, inlineButtons(rows));
  } catch (e) {
    const id = stashPending({ text: cardText, rows });
    console.error(`[briefing] 최종 전송 실패 — 재전송 대기에 저장(${id}): ${e.message}`);
  }
  return ordered.length + upCount;
}

// 사용:
//   node automation/briefing.mjs              # 실제 발송
//   node automation/briefing.mjs --dry-run    # 화면 출력만(전송·이력저장·재고소진·LLM 보충 없음)
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const { loadEnv, requireSecrets } = await import('./lib/env.mjs');
  loadEnv();
  if (!dryRun) requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  await runBriefing({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig(), dryRun });
}
