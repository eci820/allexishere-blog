// 키워드 브리핑 v2.7: 에버그린 '원리+판단' 중심. 계급 균형 —
//   🔥실검 2(정보형만) / 🔬과학·생활원리 2 / 💪건강·영양·헬스 2 / 📅캘린더 2 / 🌲에버그린 2.
//   + 네이버 지표(검색량·문서수·비율) + 적합도 별점(★1~5·이유·경고). 캘린더는 글감 각도(판단형 우선)까지 제안.
// 버튼 탭 = 그 키워드로 초안 생성(bot.mjs 처리). 대원칙 불변: 게시는 사람 승인만. 발행/기출 주제 제외.
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR, loadConfig } from './lib/env.mjs';
import { briefingCandidates } from './keywords.mjs';
import { calendarRadar } from './lib/calendar.mjs';
import { enrichKeywords, statLine } from './lib/naver.mjs';
import { scoreKeyword, starBar, WARN_LABEL } from './lib/suitability.mjs';
import { hasExistingPost } from './lib/topics.mjs';
import { sendMessage, inlineButtons } from './lib/telegram.mjs';

const STATE = path.join(AUTO_DIR, 'state');
const BRIEFED = path.join(STATE, 'briefed.json'); // keyword -> ts (30일 보관)
const KWMAP = path.join(STATE, 'kwmap.json'); // id -> {keyword, source, gossip}

const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const icon = (src) =>
  src === 'calendar' ? '📅' : src === 'trend' ? '🔥' : src === 'science' ? '🔬' : src === 'health' ? '💪' : '🌲';
// 정렬 키: 검색량 내림차순(없으면 맨 뒤)
const volKey = (s) => (s && s.vol != null ? s.vol : -1);

export async function runBriefing({ chatId, config } = {}) {
  config = config || loadConfig();
  fs.mkdirSync(STATE, { recursive: true });

  const briefed = load(BRIEFED);
  const cut = Date.now() - 30 * 864e5;
  for (const k of Object.keys(briefed)) if (briefed[k] < cut) delete briefed[k];
  const exclude = new Set(Object.keys(briefed));

  // 1) 캘린더 레이더(D-14~D-3, 최대 2)
  const cal = calendarRadar(2).filter((c) => !exclude.has(c.keyword));
  for (const c of cal) exclude.add(c.keyword); // 실검/에버그린과 중복 방지

  // 2) 실검 + 에버그린(남은 슬롯)
  const remain = Math.max(0, (config.briefingCount || 9) - cal.length);
  const { candidates, source, note } = await briefingCandidates({ ...config, briefingCount: remain }, exclude);

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
  const byVol = (a, b) => volKey(stats[b.keyword]) - volKey(stats[a.keyword]);
  const tier = (src) => candidates.filter((c) => c.source === src);
  const trend = tier('trend'); // 순위 유지
  const science = tier('science').sort(byVol);
  const health = tier('health').sort(byVol);
  const ever = tier('evergreen').sort(byVol);
  const calSorted = cal.slice().sort((a, b) => a.daysUntil - b.daysUntil); // 임박순
  const ordered = [...trend, ...science, ...health, ...calSorted, ...ever];

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
    // 📅 캘린더: 글감 각도 제안(판단형 우선 → 없으면 지식형). 도그마: 원리→돈 드는 판단.
    if (c.source === 'calendar' && (c.angleJudgment || c.angleKnowledge)) {
      sub.push(c.angleJudgment ? `   ✍️ 판단형 각도: ${c.angleJudgment}` : `   ✍️ 지식형 각도: ${c.angleKnowledge}`);
    }
    if (sc.warn) sub.push(`   ${WARN_LABEL}`);
    lines.push(`${i}. ${icon(c.source)} ${title}${badge}\n` + sub.join('\n'));
    rows.push([{ text: `${icon(c.source)} ${(c.source === 'calendar' ? c.label : c.keyword).slice(0, 40)}`, callback_data: 'gen:' + id }]);
    i++;
  }
  fs.writeFileSync(KWMAP, JSON.stringify(kwmap, null, 1));
  fs.writeFileSync(BRIEFED, JSON.stringify(briefed));

  const header =
    `🗞 키워드 브리핑 v2.7 (${source || 'evergreen'}${note ? ', ⚠️' + note : ''})\n` +
    `탭 = 초안 생성(순차). 🔥실검 🔬과학·생활원리 💪건강 📅선점 🌲에버그린 · 지표=검색량·문서수·비율\n` +
    `★적합도 = 경쟁·비율·의도·수명·단가 종합(★5 적합↔★1 비추천). 게시는 사람 승인만.\n` +
    `✍️ 각도 = 원리 설명 → 돈 드는 판단(선택·비용·시기)으로 연결. 📂기존글 = '갱신 지시' 권장\n`;
  await sendMessage(chatId, header + '\n' + lines.join('\n\n'), inlineButtons(rows));
  return ordered.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv, requireSecrets } = await import('./lib/env.mjs');
  loadEnv();
  requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  await runBriefing({ chatId: process.env.TELEGRAM_CHAT_ID, config: loadConfig() });
}
