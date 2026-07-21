// 키워드 브리핑 v2.7 + 축2(주제 재고): 에버그린 '원리+판단' 중심. 계급 균형 —
//   🔥실검 2(정보형만) / 🔬과학·생활원리 2 / 💪건강·영양·헬스 2 / 📅캘린더 2 / 🌲에버그린 2.
//   🔬·💪·🌲는 재고(topics-pool.json)에서 3중 방어(status·30일 쿨다운·발행매칭)로 픽. 재고 부족 시 자동 보충.
//   + 📂 갱신 후보(다시 게시할 가치 있는 글) 1~2개를 사유와 함께 별도 노출(탭 시 '갱신 진단' 먼저).
// 하루 1회(오전 10시경) 발송. 버튼 탭 = 초안 생성(bot.mjs). 대원칙 불변: 게시는 사람 승인만.
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR, loadConfig } from './lib/env.mjs';
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
//  · 부족분은 건강→과학 순으로 보충(둘 다 +1.25 고단가 계급, 재고도 깊음).
//  · 초과분(need<base)은 에버그린→과학→건강 순으로 감축(에버그린 재고가 가장 얕음).
//  · trend(실검)는 항상 0 — 폐지된 계급.
export function distributeNewTier(need, base) {
  const c = { trend: 0, science: base.science ?? 2, health: base.health ?? 2, evergreen: base.evergreen ?? 1 };
  let cur = c.science + c.health + c.evergreen;
  const add = ['health', 'science'];
  for (let k = 0; cur < need; k++, cur++) c[add[k % add.length]]++;
  const trim = ['evergreen', 'science', 'health'];
  for (let k = 0; cur > need && k < 999; k++) {
    const t = trim[k % trim.length];
    if (c[t] > 0) { c[t]--; cur--; }
  }
  return c;
}

export async function runBriefing({ chatId, config } = {}) {
  config = config || loadConfig();
  fs.mkdirSync(STATE, { recursive: true });

  // 0') 지난 실행에서 전송 못 한 카드가 있으면 먼저 재전송한다(오늘 카드로 kwmap 을
  //     덮어쓰기 전에 — 지난 카드의 버튼 id 가 아직 kwmap 에 유효할 때).
  if (chatId) {
    try {
      const f = await flushPending(chatId);
      if (f.sent) console.log(`[briefing] 미전송 카드 ${f.sent}건 재전송 성공`);
    } catch (e) { console.error('[briefing] 재전송 확인 실패:', e.message); }
  }

  const briefed = load(BRIEFED);
  const cut = Date.now() - 30 * 864e5;
  for (const k of Object.keys(briefed)) if (briefed[k] < cut) delete briefed[k];
  const exclude = new Set(Object.keys(briefed));

  // 0) 재고 자동 보충(pending < 30이면 claude-cli로 20개 보충). 실패해도 브리핑은 계속.
  try {
    const { replenishIfLow } = await import('./lib/replenish.mjs');
    const rep = await replenishIfLow(config);
    if (rep && rep.note && chatId) await sendMessage(chatId, rep.note);
  } catch (e) {
    console.error('[briefing] 재고 보충 실패:', e.message);
  }

  // 1) 캘린더 레이더(D-14~D-3, 최대 2)
  const cal = calendarRadar(2).filter((c) => !exclude.has(c.keyword));
  for (const c of cal) exclude.add(c.keyword); // 주차/에버그린과 중복 방지

  // 1.5) 🅿️ 주차 슬롯(v2.8 상시·모디파이어) — 재고 주입 후 오늘치 '최대 count'개 픽(있는 만큼만).
  //      부족분은 억지로 안 채우고 아래 신규 배분이 12까지 메운다(우아한 폴백).
  const { seedParkingTopics, parkingSlotState, pickParking, parkingStock } = await import('./lib/parking.mjs');
  const pState = parkingSlotState(config);
  let parking = [];
  if (pState.active) {
    try {
      seedParkingTopics(config); // v2.8: base 은퇴 + 모디파이어 주입(멱등). 발행글 강매칭분 자동 제외
      const { loadPool } = await import('./lib/topicsPool.mjs');
      const pool = loadPool();
      parking = pickParking(pool, pState.count, exclude);
      for (const p of parking) exclude.add(p.keyword);
      // 재고 부족 알림: 미발행 주차 주제가 임계 미만이면 텔레그램으로 새 시설 추가 요청
      const threshold = config.parkingSlots?.lowStockThreshold ?? 10;
      const stock = parkingStock(loadPool());
      if (chatId && stock < threshold) {
        await sendMessage(chatId, `🔔 주차 재고 부족 — 미발행 주차 주제 ${stock}개(임계 ${threshold}). lib/parking.mjs PARKING_TOPICS 에 새 시설을 추가하세요.`);
      }
    } catch (e) { console.error('[briefing] 주차 슬롯 실패:', e.message); }
  }

  // 1.6) 📂 갱신 후보를 미리 계산(개수가 신규 배분을 좌우). 표시는 섹션 6에서. updateCandidates는 읽기전용.
  let updates = [];
  try { updates = updateCandidates(Math.min(2, config.updateCount ?? 2)); }
  catch (e) { console.error('[briefing] 갱신 후보 계산 실패:', e.message); }

  // 2) 신규 배분: 총 12 = 주차 + 갱신 + 캘린더 + (🔬과학·💪건강·🌲에버그린).
  //    갱신/캘린더/주차가 모자란 날은 부족분을 신규(건강→과학)로 메워 12를 유지한다.
  const TOTAL = config.briefingCount || 12;
  const need = Math.max(0, TOTAL - parking.length - updates.length - cal.length);
  const counts = distributeNewTier(need, config.tierCounts || { science: 2, health: 2, evergreen: 1 });
  const { candidates, source, note } = await briefingCandidates(config, exclude, counts);

  // 2.5) 12개 보증 — 캘린더 공백·재고 쿨다운으로 신규가 목표에 못 미치면 부족분을 깊은 재고(건강→과학→에버그린)에서 보충.
  //     재고가 정말 마른 날은 12 미만으로 우아하게 저하(replenishIfLow가 앞에서 보충 시도).
  let short = TOTAL - parking.length - updates.length - cal.length - candidates.length;
  if (short > 0) {
    try {
      const { seedPoolIfEmpty, pickForBrief } = await import('./lib/topicsPool.mjs');
      const pool = seedPoolIfEmpty();
      const ex2 = new Set([...exclude, ...parking.map((p) => p.keyword), ...cal.map((c) => c.keyword), ...candidates.map((c) => c.keyword)]);
      for (const t of ['health', 'science', 'evergreen']) {
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
    if (chatId) await sendMessage(chatId, '🗞 브리핑: 새 후보가 없습니다(모두 발행/기출).');
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

  fs.writeFileSync(KWMAP, JSON.stringify(kwmap, null, 1));
  fs.writeFileSync(BRIEFED, JSON.stringify(briefed));

  const parkNote = pState.active
    ? `🅿️주차 ${parking.length}칸${parking.length < pState.count ? '(재고만큼)' : ''} `
    : (config.parkingSlots?.enabled ? `🅿️주차 만료(원복) ` : '');
  const header =
    `🗞 키워드 브리핑 v2.7 (${source || 'evergreen'}${note ? ', ⚠️' + note : ''})\n` +
    `탭 = 초안 생성(순차). ${parkNote}🔬과학·생활원리 💪건강 📅선점 🌲에버그린 · 지표=검색량·문서수·비율\n` +
    `★적합도 = 경쟁·비율·의도·수명·단가 종합(★5 적합↔★1 비추천). 게시는 사람 승인만.\n` +
    `✍️ 각도 = 원리 → 돈 드는 판단(선택·비용·시기)으로 연결.` +
    (upCount ? ` 📂갱신 = 탭하면 '갱신 진단' 먼저(즉시 생성 아님).\n` : `\n`);
  // 선정·kwmap 은 위에서 이미 persist 됐다. 전송만 실패하면 카드를 대기열에 남겨
  // 다음 실행/봇 기동에서 재전송한다 — 크래시하지 않는다(선정 결과를 지키기 위해).
  const cardText = header + '\n' + lines.join('\n\n');
  try {
    await sendMessage(chatId, cardText, inlineButtons(rows));
  } catch (e) {
    const id = stashPending({ text: cardText, rows });
    console.error(`[briefing] 최종 전송 실패 — 재전송 대기에 저장(${id}): ${e.message}`);
  }
  return ordered.length + upCount;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, requireSecrets } = await import('./lib/env.mjs');
  loadEnv();
  requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  await runBriefing({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig() });
}
