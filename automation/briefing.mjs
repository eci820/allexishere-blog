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

const STATE = path.join(AUTO_DIR, 'state');
const BRIEFED = path.join(STATE, 'briefed.json'); // keyword -> ts (30일 보관)
const KWMAP = path.join(STATE, 'kwmap.json'); // id -> {keyword, source, gossip}

const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const icon = (src) =>
  src === 'calendar' ? '📅' : src === 'trend' ? '🔥' : src === 'finance' ? '💰' : src === 'realestate' ? '🏠'
  : src === 'science' ? '🔬' : src === 'health' ? '💪' : '🌲';
// 정렬 키: 검색량 내림차순(없으면 맨 뒤)
const volKey = (s) => (s && s.vol != null ? s.vol : -1);

export async function runBriefing({ chatId, config } = {}) {
  config = config || loadConfig();
  fs.mkdirSync(STATE, { recursive: true });

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
  for (const c of cal) exclude.add(c.keyword); // 실검/에버그린과 중복 방지

  // 2) 실검(라이브) + 🔬·💪·🌲(재고). 계급별 개수는 tierCounts. 캘린더 키워드는 exclude로 중복 방지.
  const { candidates, source, note } = await briefingCandidates(config, exclude);

  const all = [...cal, ...candidates];
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

  // 4) 계급별 정렬 + 표시 순서(🔥실검 → 🔬과학 → 💪건강 → 📅캘린더 → 🌲에버그린).
  //    🔥실검 = 원래 순위 유지 / 🔬·💪·🌲 = 검색량 내림차순 / 📅캘린더 = D-day 임박순(선점).
  //    💰금융·🏠부동산은 격리(quarantined)로 후보에 없음.
  const byVol = (a, b) => volKey(stats[b.keyword]) - volKey(stats[a.keyword]);
  const tier = (src) => candidates.filter((c) => c.source === src).sort(byVol);
  const trend = candidates.filter((c) => c.source === 'trend'); // 순위 유지
  const calSorted = cal.slice().sort((a, b) => a.daysUntil - b.daysUntil); // 임박순
  const ordered = [...trend, ...tier('science'), ...tier('health'), ...calSorted, ...tier('evergreen')];

  // 5) 메시지 + 버튼 + kwmap
  const kwmap = load(KWMAP);
  let n = Object.keys(kwmap).length;
  const lines = [];
  const rows = [];
  let i = 1;
  for (const c of ordered) {
    const id = 'k' + Math.abs(hash(c.keyword)).toString(36) + '_' + n++;
    kwmap[id] = { keyword: c.keyword, source: c.source, gossip: !!c.gossip, ...(c.angle ? { angle: c.angle } : {}) };
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
    } else if ((c.source === 'science' || c.source === 'health') && c.poolAngle) {
      sub.push(`   ✍️ 판단 각도: ${c.poolAngle}`);
    }
    if (sc.warn) sub.push(`   ${WARN_LABEL}`);
    lines.push(`${i}. ${icon(c.source)} ${title}${badge}\n` + sub.join('\n'));
    rows.push([{ text: `${icon(c.source)} ${(c.source === 'calendar' ? c.label : c.keyword).slice(0, 40)}`, callback_data: 'gen:' + id }]);
    i++;
  }

  // 6) 📂 갱신 후보(다시 게시할 가치 있는 글) — 사유 1줄 + [갱신] 버튼(탭 시 진단 먼저, 즉시 생성 아님)
  let upCount = 0;
  try {
    for (const u of updateCandidates(config.updateCount ?? 3)) {
      const id = 'u' + Math.abs(hash(u.slug)).toString(36) + '_' + n++;
      kwmap[id] = { type: 'update', slug: u.slug, title: u.title, url: u.url };
      lines.push(`${i}. 📂 갱신: ${u.title}\n   🔧 사유: ${u.reasons.join(' · ')}`);
      rows.push([{ text: `📂 갱신 진단: ${u.title.slice(0, 34)}`, callback_data: 'updiag:' + id }]);
      i++; upCount++;
    }
  } catch (e) {
    console.error('[briefing] 갱신 후보 계산 실패:', e.message);
  }

  fs.writeFileSync(KWMAP, JSON.stringify(kwmap, null, 1));
  fs.writeFileSync(BRIEFED, JSON.stringify(briefed));

  const header =
    `🗞 키워드 브리핑 v2.7 (${source || 'evergreen'}${note ? ', ⚠️' + note : ''})\n` +
    `탭 = 초안 생성(순차). 🔥실검 🔬과학·생활원리 💪건강 📅선점 🌲에버그린 · 지표=검색량·문서수·비율\n` +
    `★적합도 = 경쟁·비율·의도·수명·단가 종합(★5 적합↔★1 비추천). 게시는 사람 승인만.\n` +
    `✍️ 각도 = 원리 → 돈 드는 판단(선택·비용·시기)으로 연결.` +
    (upCount ? ` 📂갱신 = 탭하면 '갱신 진단' 먼저(즉시 생성 아님).\n` : `\n`);
  await sendMessage(chatId, header + '\n' + lines.join('\n\n'), inlineButtons(rows));
  return ordered.length + upCount;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, requireSecrets } = await import('./lib/env.mjs');
  loadEnv();
  requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  await runBriefing({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig() });
}
