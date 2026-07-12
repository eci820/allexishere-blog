// 띄엄띄엄 발행 큐 — 오전 브리핑에서 승인한 글을 하루 3~5개로 시간차 발행.
//  · 승인 = 발행 동의(대원칙 불변). 다만 즉시가 아니라 예약 슬롯에 넣고 봇 루프가 때가 되면 발행.
//  · 슬롯: startHour~endHour(KST) 사이 gapMinutes 간격. 창을 넘치면 다음 날 startHour로.
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR } from './env.mjs';

const QF = path.join(AUTO_DIR, 'state', 'publish-queue.json');
const KST = 9 * 3600 * 1000;
const HOUR = 3600 * 1000;

export const loadQueue = () => { try { return JSON.parse(fs.readFileSync(QF, 'utf8')); } catch { return []; } };
const saveQueue = (q) => { fs.mkdirSync(path.dirname(QF), { recursive: true }); fs.writeFileSync(QF, JSON.stringify(q, null, 1)); };

// UTC epoch(ms) → KST 날짜 문자열
export const kstDateStr = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
// KST 날짜+시각 → UTC epoch(ms)
function kstEpoch(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour, 0, 0) - KST;
}

const cfgOf = (config) => {
  const s = (config && config.publishStagger) || {};
  return { startHour: s.startHour ?? 11, endHour: s.endHour ?? 22, gap: (s.gapMinutes ?? 150) * 60000, perDay: config?.maxSameDayPublish || 5 };
};

// 오늘(KST) 이미 발행 + 예약된 수 → 상한 판정용
export function scheduledTodayCount(publishedToday = 0) {
  const now = Date.now();
  const today = kstDateStr(now);
  const q = loadQueue().filter((x) => kstDateStr(Date.parse(x.at)) === today);
  return publishedToday + q.length;
}

// 승인 글을 다음 슬롯에 예약. 반환: { at(ISO), rolled(내일로 밀림), position }
export function enqueue(entry, config) {
  const { startHour, endHour, gap } = cfgOf(config);
  const now = Date.now();
  const q = loadQueue();
  const today = kstDateStr(now);
  const winStart = kstEpoch(today, startHour);
  const winEnd = kstEpoch(today, endHour);
  const todaySlots = q.filter((x) => kstDateStr(Date.parse(x.at)) === today).map((x) => Date.parse(x.at));

  let at = todaySlots.length ? Math.max(...todaySlots) + gap : Math.max(now, winStart);
  if (at < winStart) at = winStart;
  let rolled = false;
  if (at > winEnd) { // 오늘 창 넘침 → 다음 날 시작
    const tomorrow = kstDateStr(now + 24 * HOUR);
    at = kstEpoch(tomorrow, startHour) + todaySlots.length * 0; // 내일 첫 슬롯
    // 내일 이미 잡힌 게 있으면 그 뒤로
    const tmSlots = q.filter((x) => kstDateStr(Date.parse(x.at)) === tomorrow).map((x) => Date.parse(x.at));
    if (tmSlots.length) at = Math.max(...tmSlots) + gap;
    rolled = true;
  }
  const item = { slug: entry.slug, title: entry.title, keyword: entry.keyword || '', at: new Date(at).toISOString() };
  q.push(item);
  saveQueue(q);
  const position = q.filter((x) => kstDateStr(Date.parse(x.at)) === kstDateStr(at)).length;
  return { at, rolled, position };
}

// 지금 발행할 때가 된 항목들(시간 도래분)을 큐에서 꺼내 반환(제거). 상한 초과분은 남겨둠.
export function popDue(publishedToday, perDay) {
  const now = Date.now();
  const q = loadQueue();
  const today = kstDateStr(now);
  let room = Math.max(0, (perDay || 5) - publishedToday);
  const due = [];
  const rest = [];
  for (const x of q) {
    if (room > 0 && Date.parse(x.at) <= now && kstDateStr(Date.parse(x.at)) <= today) {
      due.push(x); room--;
    } else rest.push(x);
  }
  if (due.length) saveQueue(rest);
  return due;
}

// 슬롯 시각을 KST HH:MM 로 표시
export function kstHM(at) {
  const d = new Date((typeof at === 'number' ? at : Date.parse(at)) + KST);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
