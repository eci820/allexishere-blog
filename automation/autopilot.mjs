#!/usr/bin/env node
// 🤖 autopilot — 하루 N편 자동 작성·검증·발행 (2026-11-25 신설, 사용자 지시).
//
// 사용자 지시: "하루 5개씩 니가 알아서 업로드까지. 내가 선택하지 않고."
//              "다만 AI 가 양산해서 저품질이 되지 않도록 철저하게(시기·방식·종류)."
//
// 🔴 이 파일은 운영 원칙 §7('자동 게시 경로는 없다')을 사용자 지시로 바꾼 유일한 예외 경로다.
//    그래서 사람 대신 '품질 관문(lib/harness.passesGate)'이 승인 역할을 한다. 관문을 못 넘은 글은
//    버리지 않고 기존 초안 카드로 보내 사람이 판단한다(손실 없음). 발행은 기존 publish() 로만 한다(계약 §3).
//
// 양산 방지 장치:
//   · 한 번 실행 = 최대 1편. launchd 가 하루 5개 시각(config.autopilot.slots)에 부르고, 매번 0~jitter 분
//     더 기다린다 → 발행 시각이 매일 같지 않고 한꺼번에 몰리지 않는다.
//   · ramp: 2→3→5편/일. 🔴 2026-07-18~19 이틀 34편 발행 직후 사이트 전체 노출이 0이 됐다(GSC 실측).
//   · 분야 순환: 직전 2편과 같은 series 는 피한다. 🅿️ 주차는 하루 1편까지(도어웨이 신호 방지).
//   · YMYL(건강·금융·부동산)·실검은 자동 대상에서 제외(config.autopilot.excludeTiers).
//   · 같은 키워드는 30일 안에 다시 시도하지 않는다(보류된 초안이 매 슬롯 재생성되는 것 방지).
//
// 멈춤: 텔레그램 /autopause · 재개 /autoresume · 상태 /autostatus (bot.mjs) — 또는 config.autopilot.enabled=false.
//
// 사용:
//   node automation/autopilot.mjs            # 정상 실행(지터 대기 포함)
//   node automation/autopilot.mjs --now      # 지터 없이 즉시
//   node automation/autopilot.mjs --dry-run  # 주제 선택까지만 출력(생성·발행·전송 없음)
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, loadConfig, AUTO_DIR } from './lib/env.mjs';

loadEnv();
const STATE = path.join(AUTO_DIR, 'state');
const FILE = path.join(STATE, 'autopilot.json');
const LOCK = path.join(STATE, 'autopilot.lock');
const ME = process.env.TELEGRAM_CHAT_ID; // 🇰🇷 한국 봇 채팅. 호주(au-*)와 섞지 않는다.
const DRY = process.argv.includes('--dry-run');
const NOW = process.argv.includes('--now') || DRY;
const DAY = 24 * 3600 * 1000;

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export function loadState() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { paused: false, runs: [] }; }
}
export function saveState(s) {
  s.runs = (s.runs || []).slice(-400);
  fs.writeFileSync(FILE, JSON.stringify(s, null, 1));
}
export function perDayFor(ap, day = kstToday()) {
  const ramp = ap.ramp || [];
  let n = ramp.length ? ramp[0].perDay : ap.targetPerDay || 5; // 램프 시작 전엔 가장 낮은 단계
  for (const r of ramp) if (r.from <= day) n = r.perDay;
  if (ramp.length && ramp[ramp.length - 1].from <= day) n = Math.min(n, ap.targetPerDay || n);
  return n;
}

function acquireLock() {
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 50 * 60 * 1000) return false; // 50분 안 된 잠금 = 다른 실행 중
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };

// ── 주제 선택 ──
async function pickTopic(cfg, state) {
  const { loadPool, savePool, nicheAllows, liveDupe } = await import('./lib/topicsPool.mjs');
  const ap = cfg.autopilot;
  const pool = loadPool();
  const today = kstToday();
  const todays = state.runs.filter((r) => r.day === today && r.result === 'published');
  const parkingToday = todays.some((r) => r.tier === 'parking' || r.series === 'parking');
  const lastSeries = state.runs.filter((r) => r.result === 'published').slice(-2).map((r) => r.series);
  const tried = new Set(state.runs.filter((r) => Date.now() - Date.parse(r.ts) < 30 * DAY).map((r) => r.keyword));
  const now = Date.now();

  const cand = pool.topics.filter((t) =>
    t.status === 'pending' &&
    !(ap.excludeTiers || []).includes(t.tier) &&
    nicheAllows(t, cfg) &&
    !tried.has(t.keyword) &&
    !(parkingToday && (t.tier === 'parking' || t.series === 'parking')) &&
    !lastSeries.includes(t.series || t.tier)
  );
  const fresh = (t) => t.origin === 'scout' && now - Date.parse(t.addedAt) < 14 * DAY;
  cand.sort((a, b) =>
    (fresh(b) - fresh(a)) ||
    ((b.metrics?.stars || 0) - (a.metrics?.stars || 0)) ||
    (Date.parse(a.addedAt || 0) - Date.parse(b.addedAt || 0))
  );
  let dirty = false;
  for (const t of cand) {
    const m = liveDupe(t.keyword, t.tier);
    if (m) { t.status = 'published'; t.slug = m.slug; t.publishedNote = 'live-match'; dirty = true; continue; }
    if (dirty) savePool(pool);
    return { topic: t, freshLeft: cand.filter(fresh).length };
  }
  if (dirty) savePool(pool);
  return { topic: null, freshLeft: 0 };
}

export async function runAutopilot() {
  const cfg = loadConfig();
  const ap = cfg.autopilot || {};
  if (!ap.enabled) return console.log('[autopilot] config.autopilot.enabled=false — 건너뜀');
  const state = loadState();
  if (state.paused) return console.log('[autopilot] /autopause 상태 — 건너뜀');
  // 🔴 구독 한도 백오프(2026-11-27 실측: 한도에 걸린 CLI 가 '종료코드 1'만 남겨 매 시도가 연쇄 실패)
  if (state.backoffUntil && Date.now() < Date.parse(state.backoffUntil)) return console.log('[autopilot] 한도 백오프 중 — ' + state.backoffUntil);
  if (!acquireLock()) return console.log('[autopilot] 다른 실행이 진행 중 — 건너뜀');
  const { sendMessage } = await import('./lib/telegram.mjs');
  try {
    if (!NOW) {
      const wait = Math.floor(Math.random() * ((ap.jitterMinutes ?? 25) + 1));
      console.log(`[autopilot] 지터 ${wait}분 대기`);
      await new Promise((r) => setTimeout(r, wait * 60 * 1000));
      fs.utimesSync(LOCK, new Date(), new Date()); // 잠금 갱신
    }
    // 한 슬롯에서 관문 불통과·생성 실패면 다른 주제로 한 번 더(기본 2회). 품질 기준을 낮추는 대신
    // 시도 횟수로 하루 목표를 채운다 — 1회 시도는 생성+검증+수정+재채점으로 약 10분.
    const tries = Math.max(1, ap.attemptsPerSlot ?? 2);
    for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) { Object.assign(state, loadState()); fs.utimesSync(LOCK, new Date(), new Date()); console.log(`[autopilot] 재시도 ${attempt}/${tries}`); }
    if (state.paused) return console.log('[autopilot] /autopause 상태 — 재시도 중단');
    const today = kstToday();
    const perDay = perDayFor(ap, today);
    const done = state.runs.filter((r) => r.day === today && r.result === 'published').length;
    const attempts = state.runs.filter((r) => r.day === today).length;
    if (done >= perDay) return console.log(`[autopilot] 오늘 목표 달성 ${done}/${perDay}`);
    if (attempts >= (ap.maxAttemptsPerDay || perDay * 3)) return console.log(`[autopilot] 오늘 시도 상한(${attempts}) — 구독 사용량 보호`);

    // 📈 성과 학습 — 교훈이 7일 넘게 묵었으면 다시 만든다(주 1회 CLI 1호출, 계약 §5).
    if (!DRY && attempt === 1) {
      try {
        const { lessonsStale, buildLessons } = await import('./lib/lessons.mjs');
        if (lessonsStale(7)) { const L = await buildLessons(cfg); console.log('[autopilot] 교훈 갱신:', L.note); }
      } catch (e) { console.error('[autopilot] 교훈 갱신 실패:', e.message); }
    }

    // 화제 재고가 마르면 하루 1회 스카우트
    let { topic, freshLeft } = await pickTopic(cfg, state);
    if ((freshLeft < 3 || !topic) && state.lastScout !== today && !DRY) {
      const { runScout } = await import('./lib/scout.mjs');
      const s = await runScout(cfg);
      state.lastScout = today;
      state.lastScoutNote = s.note; // 알림은 밤 요약에 묶는다
      saveState(state);
      console.log('[autopilot]', s.note);
      ({ topic } = await pickTopic(cfg, state));
    }
    if (!topic) {
      if (ME && !DRY) await sendMessage(ME, '🤖 자동 발행: 고를 주제가 없습니다(재고 소진·중복 제외). 스카우트는 내일 다시 돕니다.');
      return console.log('[autopilot] 주제 없음');
    }
    console.log(`[autopilot] 주제: ${topic.keyword} (${topic.tier}/${topic.series || '-'}) · 오늘 ${done}/${perDay}`);
    if (DRY) return;

    const run = { ts: new Date().toISOString(), day: today, keyword: topic.keyword, tier: topic.tier, series: topic.series || topic.tier };
    state.runs.push({ ...run, result: 'started' });
    saveState(state);

    const { generateOne, sendFailure } = await import('./generate.mjs');
    const r = await generateOne(topic.keyword, { source: topic.tier, series: topic.series, angle: topic.angle, auto: true }, cfg, ME);
    const st = loadState(); // 생성 중 /autopause 등이 바뀌었을 수 있다
    const rec = st.runs.findLast((x) => x.ts === run.ts) || run;
    // 🔴 2026-11-26 사용자 지시: "승인하는 방식으로 쓰고 싶지 않다. 모든 걸 자동화."
    //    → 사람 카드를 보내지 않는다. 관문(품질)은 그대로 두고, 불통과 초안은 사이트 밖(state/rejected)으로
    //      옮겨 버린 뒤 다른 주제로 다시 쓴다. 저품질 글이 사람 없이도 나가지 않게 하는 마지막 장치다.
    //      버린 초안은 lessons(성과 학습)의 '왜 떨어졌나' 근거로 남긴다.
    if (!r.ok) {
      Object.assign(rec, { result: 'failed', why: r.message || r.reason });
      saveState(st);
      if (/종료코드 1|limit|한도/.test(String(r.message || '')) || r.reason === 'limit') {
        st.backoffUntil = new Date(Date.now() + 90 * 60000).toISOString(); saveState(st);
        console.log('[autopilot] claude 실패(한도 추정) → 90분 백오프'); return;
      }
      if (r.reason === 'limit' || r.reason === 'auth') { // 한도·인증은 사람이 알아야 하고, 재시도해도 같다
        if (ME) await sendFailure(ME, { keyword: topic.keyword, source: topic.tier }, r);
        return;
      }
      continue;
    }
    rec.slug = r.slug;
    if (st.paused || !r.gate || !r.gate.pass) {
      const why = st.paused ? ['생성 중 /autopause'] : r.gate ? r.gate.why : ['하네스 꺼짐 — 자동 발행은 하네스 관문이 필수'];
      Object.assign(rec, { result: 'discarded', why, archived: archiveDraft(r.slug) });
      if (why.some((w) => /종료코드 1/.test(w))) { st.backoffUntil = new Date(Date.now() + 90 * 60000).toISOString(); saveState(st); console.log('[autopilot] 하네스 중 claude 실패(한도 추정) → 90분 백오프'); return; }
      saveState(st);
      console.log(`[autopilot] 관문 불통과 → 폐기: ${r.title} — ${why.join(' / ')}`);
      if (st.paused) return;
      continue; // 다른 주제로 재시도
    }
    const { publish } = await import('./publish.mjs');
    const p = await publish({ slug: r.slug, title: r.title, keyword: topic.keyword });
    if (!p.ok) { // git·배포 문제 — 운영 장애라 알린다(글은 초안으로 남아 다음 슬롯에서 다시 쓰지 않는다)
      Object.assign(rec, { result: 'publish-failed', why: p.error, archived: archiveDraft(r.slug) });
      saveState(st);
      if (ME) await sendMessage(ME, `🤖 자동 발행 실패(배포 문제): ${r.title}\n${p.error}`);
      return;
    }
    Object.assign(rec, { result: 'published', url: p.url });
    saveState(st);
    const n = st.runs.filter((x) => x.day === today && x.result === 'published').length;
    if (ME)
      await sendMessage(ME,
        `🤖 자동 발행 (오늘 ${n}/${perDay})\n📝 ${r.title}\n🔑 ${topic.keyword}\n🔗 ${p.url}\n` +
        `${r.cardOpts.harnessLine || ''}\n\n내리려면: /unpublish ${r.slug}\n멈추려면: /autopause`);
    return; // 이 슬롯 몫(1편) 완료
    } // for attempt
  } catch (e) {
    console.error('[autopilot] 오류:', e);
    if (ME) await sendMessage(ME, `🤖 자동 발행 오류: ${String(e.message).slice(0, 150)}`).catch(() => {});
  } finally {
    try { await maybeDailySummary(ap, sendMessage); } catch (e) { console.error('[autopilot] 요약 실패:', e.message); }
    releaseLock();
  }
}

// 관문 불통과 초안을 사이트 밖으로 옮긴다(삭제 아님 — lessons 가 '왜 떨어졌나'를 본다).
function archiveDraft(slug) {
  try {
    const src = path.join(path.dirname(AUTO_DIR), 'src', 'content', 'blog', slug);
    if (!fs.existsSync(src)) return null;
    const dst = path.join(STATE, 'rejected', slug);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    return path.relative(AUTO_DIR, dst);
  } catch (e) { console.error('[autopilot] 초안 보관 실패:', e.message); return null; }
}

// 하루 1통 요약 — 목표 달성 시 또는 22시 이후 마지막 슬롯에서. 개별 실패는 알리지 않는다(사용자 지시: 손 떼기).
async function maybeDailySummary(ap, sendMessage) {
  const s = loadState();
  const today = kstToday();
  const hm = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
  const runs = s.runs.filter((r) => r.day === today);
  const pub = runs.filter((r) => r.result === 'published');
  const perDay = perDayFor(ap, today);
  if (s.summarySent === today || DRY || !ME) return;
  if (pub.length < perDay && hm < '22:00') return;
  const cnt = (k) => runs.filter((r) => r.result === k).length;
  await sendMessage(ME,
    `🤖 오늘 자동 발행 요약 (${today})\n✅ 발행 ${pub.length}/${perDay}\n` +
    pub.map((r, i) => `${i + 1}. ${r.keyword}\n   ${r.url || ''}`).join('\n') +
    `\n🗑 관문 불통과로 폐기 ${cnt('discarded')} · ❌ 생성 실패 ${cnt('failed')}` +
    (s.lastScoutNote && s.lastScout === today ? `\n${s.lastScoutNote}` : '') +
    `\n\n멈추려면 /autopause · 상태 /autostatus`);
  s.summarySent = today;
  saveState(s);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runAutopilot();
}
