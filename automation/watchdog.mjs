// 워치독(안전망). launchd 가 5분마다 실행 — 봇과 독립된 별도 경로.
//
// 두 가지 고장을 구분해서 잡는다:
//  ① 프로세스 죽음      — 하트비트가 아예 안 뛴다 → 재시작 + 텔레그램 경보
//  ② 살아있지만 먹통    — 하트비트는 뛰는데 폴링이 계속 실패한다 (lastPollOk 가 낡음)
//
// ②를 따로 잡는 이유(2026-07-19 실제 사고):
//   봇 토큰이 폐기돼 getUpdates 가 9시간 동안 전부 Unauthorized 였는데,
//   하트비트는 정상이라 /status 는 멀쩡해 보였고 워치독도 못 잡았다. 그동안
//   아침 브리핑이 전송 실패로 사라졌다(재고 10개는 쿨다운으로 소진된 채).
//
// 🔴 ②는 텔레그램으로 알릴 수 없다 — 텔레그램이 안 되는 게 고장 원인이기 때문이다.
//    그래서 대체 경로로 알린다: 전용 로그 파일 + macOS 알림(osascript).
//    인증 오류일 땐 재시작해도 소용없으므로 재시작하지 않는다(무의미한 반복 방지).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv, loadConfig, AUTO_DIR } from './lib/env.mjs';
import { sendMessage } from './lib/telegram.mjs';

loadEnv();
const CFG = loadConfig();
const ME = process.env.TELEGRAM_CHAT_ID;
const HB = path.join(AUTO_DIR, 'state', 'heartbeat.json');
const ALERT = path.join(AUTO_DIR, 'state', 'watchdog-alerted.json');
// 절전 때문에 재시작을 미룬 횟수. 무한 유예를 막는 상한이 필요해서 파일로 센다.
const DEFER = path.join(AUTO_DIR, 'state', 'watchdog-defer.json');
// 눈에 띄는 전용 로그 — 텔레그램이 죽었을 때 사람이 볼 수 있는 곳.
const ALARM_LOG = path.join(AUTO_DIR, 'logs', 'ALARM.log');

// 폴링이 이 시간 이상 성공하지 못하면 '먹통'으로 본다.
// 롱폴링 1회가 pollTimeoutSeconds(50초)이므로 넉넉히 10분.
const POLL_STALE_SECONDS = Number(CFG.pollStaleSeconds || 600);

// ── 절전 구간 구분(2026-07-19 사고) ───────────────────────────────────
// 뚜껑을 닫아 클램셸 슬립에 들어가면 네트워크가 끊겨 getaddrinfo 가 실패하고,
// 잠든 동안 launchd 가 워치독을 띄우지 않는다. 깨어나면 폴링 실패 구간이 통째로
// 밀려 있어 '51분째 먹통'처럼 보이지만, 실제로는 봇이 스스로 회복하는 경우가 많다.
// 그런데 워치독이 즉시 kickstart -k 로 죽여버려서, 진행 중이던 초안 생성이 함께
// 날아갔다(카페인 반감기). → 깬 직후에는 짧게 유예해 스스로 회복할 기회를 준다.
//
// 🔴 무한 유예는 위험하다. 절전 중에는 DarkWake 가 수 분 간격으로 반복되고
//    (실측 21:26·21:31·21:49·21:50·21:55·22:13), kern.waketime 은 그때마다 갱신된다.
//    "방금 깼으니 유예"만 두면 진짜 먹통일 때 영영 재시작되지 않는다.
//    그래서 연속 유예 횟수에 상한을 둔다 — 상한을 넘으면 평소대로 재시작한다.
const WAKE_GRACE_SECONDS = Number(CFG.wakeGraceSeconds || 180);
const MAX_DEFERS = Number(CFG.watchdogMaxDefers || 3);

// 마지막 시스템 깨어남 시각(ms). macOS 전용이라 실패하면 null → 기존 동작(즉시 재시작).
function lastWakeMs() {
  try {
    const raw = execFileSync('sysctl', ['-n', 'kern.waketime'], { encoding: 'utf8', timeout: 3000 });
    const m = raw.match(/sec\s*=\s*(\d+)/);
    return m ? Number(m[1]) * 1000 : null;
  } catch { return null; }
}
const readDefers = () => { try { return JSON.parse(fs.readFileSync(DEFER, 'utf8')).count || 0; } catch { return 0; } };
const writeDefers = (count) => {
  try {
    fs.mkdirSync(path.dirname(DEFER), { recursive: true });
    fs.writeFileSync(DEFER, JSON.stringify({ count, ts: Date.now() }));
  } catch {}
};
const clearDefers = () => { try { fs.rmSync(DEFER, { force: true }); } catch {} };

const readHB = () => { try { return JSON.parse(fs.readFileSync(HB, 'utf8')); } catch { return null; } };
const alertedRecently = (key) => {
  try {
    const a = JSON.parse(fs.readFileSync(ALERT, 'utf8'));
    return a.key === key && Date.now() - a.ts < 3600 * 1000;
  } catch { return false; }
};
const markAlerted = (key) => {
  fs.mkdirSync(path.dirname(ALERT), { recursive: true });
  fs.writeFileSync(ALERT, JSON.stringify({ key, ts: Date.now() }));
};
const clearAlert = () => { try { fs.rmSync(ALERT, { force: true }); } catch {} };

// 텔레그램을 못 쓸 때의 대체 알림 경로.
function alarm(title, body) {
  const line = `[${new Date().toISOString()}] ${title} — ${body}`;
  try {
    fs.mkdirSync(path.dirname(ALARM_LOG), { recursive: true });
    fs.appendFileSync(ALARM_LOG, line + '\n');
  } catch {}
  console.error('[watchdog] ' + line);
  // macOS 알림 센터. 실패해도 무시(헤드리스·권한 없음 등).
  try {
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&').slice(0, 200);
    execFileSync('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], { stdio: 'pipe', timeout: 5000 });
  } catch {}
}

const hb = readHB();
const now = Date.now();
const beatAge = hb?.ts ? (now - hb.ts) / 1000 : Infinity;
const pollAge = hb?.lastPollOk ? (now - hb.lastPollOk) / 1000 : null;

// ── ① 프로세스가 죽었나 ────────────────────────────────────────────────
if (beatAge > CFG.watchdogStaleSeconds) {
  let restarted = false;
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.allexishere.bot`], { stdio: 'pipe' });
    restarted = true;
  } catch {}
  if (!alertedRecently('dead')) {
    const body = `하트비트 ${Math.round(beatAge)}초 전. ${restarted ? '재시작 시도함' : '재시작 실패'}`;
    alarm('🤖 봇 무응답', body); // 텔레그램이 될지 모르니 대체 경로에도 남긴다
    try { await sendMessage(ME, `⚠️ 봇 무응답 (하트비트 ${Math.round(beatAge)}초 전).\n` + (restarted ? '→ 재시작을 시도했습니다.' : '→ 재시작 실패. 맥 상태를 확인하세요.')); } catch {}
    markAlerted('dead');
  }
}
// ── ② 살아있지만 폴링이 먹통인가 ──────────────────────────────────────
else if (pollAge !== null && pollAge > POLL_STALE_SECONDS) {
  const err = hb.lastPollError || '(사유 미상)';
  // 인증 오류는 재시작으로 안 고쳐진다 — 토큰을 사람이 갈아야 한다.
  const isAuth = /unauthorized|forbidden|invalid token|401|403/i.test(err);

  // ── 절전으로 설명되는 실패인가 ──
  // 인증 오류는 절전과 무관하므로 유예 대상이 아니다(깨어나도 안 고쳐진다).
  const wake = lastWakeMs();
  const wakeAge = wake ? (now - wake) / 1000 : null;
  const justWoke = !isAuth && wakeAge !== null && wakeAge < WAKE_GRACE_SECONDS;
  const defers = readDefers();

  if (justWoke && defers < MAX_DEFERS) {
    // 🔴 경보도 재시작도 하지 않는다. 뚜껑을 여닫을 때마다 경보가 뜨면
    //    사람이 ALARM.log 자체를 무시하게 된다 — 그게 가장 큰 손실이다.
    writeDefers(defers + 1);
    console.error(
      `[watchdog] 절전에서 깬 직후(${Math.round(wakeAge)}초 전) — 폴링 ${Math.round(pollAge / 60)}분 지연은 ` +
      `절전으로 설명됨. 재시작을 미루고 자가 회복을 기다립니다 (유예 ${defers + 1}/${MAX_DEFERS}).`
    );
  } else {
    if (justWoke) {
      // 유예를 다 썼는데도 회복이 안 됐다 — 절전 탓이 아니다. 평소대로 처리한다.
      console.error(`[watchdog] 절전 유예 ${MAX_DEFERS}회 소진 — 자가 회복 실패로 보고 재시작합니다.`);
    }
    if (!alertedRecently('mute')) {
      const mins = Math.round(pollAge / 60);
      alarm(
        isAuth ? '🔐 봇 토큰 문제 — 메시지 수신 불가' : '🔇 봇 폴링 먹통',
        `${mins}분째 폴링 실패. 사유: ${err}` +
          (isAuth ? ' / BotFather에서 토큰 확인 후 automation/.env 교체 필요(재시작으로 안 고쳐짐)' : '')
      );
      // 텔레그램도 시도는 한다 — 네트워크 일시 장애였다면 이건 도착한다.
      if (!isAuth) {
        try { await sendMessage(ME, `⚠️ 봇이 ${mins}분째 메시지를 받지 못하고 있습니다.\n사유: ${err}`); } catch {}
      }
      markAlerted('mute');
    }
    // 인증 문제가 아니면(네트워크 등) 재시작이 도움이 될 수 있다.
    if (!isAuth) {
      try { execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.allexishere.bot`], { stdio: 'pipe' }); } catch {}
    }
    clearDefers(); // 재시작했으면 유예 카운터를 리셋한다
  }
}
// ── 정상 ──────────────────────────────────────────────────────────────
else {
  clearAlert(); // 다음에 죽으면 즉시 알릴 수 있게 해제
  clearDefers(); // 회복됐으니 유예 카운터도 리셋 — 다음 절전에 다시 3회를 쓴다
}
