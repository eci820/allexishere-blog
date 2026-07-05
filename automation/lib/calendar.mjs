// 캘린더 레이더: data/calendar.json 반복 일정 중 D-14~D-3 구간(폭발 예정) 항목을 선점.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';

const DB = path.join(ROOT, 'data', 'calendar.json');
const DAY = 24 * 3600 * 1000;

// KST 자정 기준 오늘
function kstMidnight() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// month/day 의 '다음 발생일'까지 남은 일수(KST)
function daysUntil(month, day, todayMs) {
  const y = new Date(todayMs).getUTCFullYear();
  let ev = Date.UTC(y, month - 1, day);
  if (ev < todayMs) ev = Date.UTC(y + 1, month - 1, day); // 이미 지났으면 내년
  return Math.round((ev - todayMs) / DAY);
}

// D-14~D-3 항목 반환(가까운 순), 기본 최대 2개.
export function calendarRadar(limit = 2, minD = 3, maxD = 14) {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return [];
  }
  const today = kstMidnight();
  const hits = [];
  for (const e of db.events || []) {
    const d = daysUntil(e.month, e.day, today);
    if (d >= minD && d <= maxD) hits.push({ ...e, daysUntil: d });
  }
  hits.sort((a, b) => a.daysUntil - b.daysUntil);
  return hits.slice(0, limit).map((e) => ({
    keyword: e.keyword,
    source: 'calendar',
    gossip: false,
    label: e.label,
    daysUntil: e.daysUntil,
    note: e.window,
    updateTarget: e.updateTarget || null, // 📂갱신 대상 글 URL(있으면)
  }));
}
