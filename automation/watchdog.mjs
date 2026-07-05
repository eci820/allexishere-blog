// 워치독(안전망): 하트비트가 끊기면 봇을 재시작하고, 그래도 죽어 있으면 텔레그램으로 경보.
// launchd 가 5분마다 이 스크립트를 실행합니다(봇과 독립된 별도 경로).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv, loadConfig, requireSecrets, AUTO_DIR } from './lib/env.mjs';
import { sendMessage } from './lib/telegram.mjs';

loadEnv();
requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const CFG = loadConfig();
const ME = process.env.TELEGRAM_CHAT_ID;
const HB = path.join(AUTO_DIR, 'state', 'heartbeat.json');
const ALERT = path.join(AUTO_DIR, 'state', 'watchdog-alerted.json');

const alertedRecently = () => {
  try {
    return Date.now() - JSON.parse(fs.readFileSync(ALERT, 'utf8')).ts < 3600 * 1000;
  } catch {
    return false;
  }
};

let ageSec = Infinity;
try {
  ageSec = (Date.now() - JSON.parse(fs.readFileSync(HB, 'utf8')).ts) / 1000;
} catch {}

if (ageSec > CFG.watchdogStaleSeconds) {
  // 1) 재시작 시도 (launchd KeepAlive 가 이미 살렸을 수도 있음)
  let restarted = false;
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.allexishere.bot`], { stdio: 'pipe' });
    restarted = true;
  } catch {}
  // 2) 1시간에 한 번만 경보(스팸 방지)
  if (!alertedRecently()) {
    try {
      await sendMessage(
        ME,
        `⚠️ 봇 무응답 (하트비트 ${Math.round(ageSec)}초 전).\n` +
          (restarted ? '→ 재시작을 시도했습니다.' : '→ 재시작 실패. 맥 상태를 확인하세요.')
      );
    } catch {}
    fs.mkdirSync(path.dirname(ALERT), { recursive: true });
    fs.writeFileSync(ALERT, JSON.stringify({ ts: Date.now() }));
  }
} else {
  // 살아있으면 경보 상태 해제(다음에 다시 죽으면 즉시 알림 가능)
  try {
    fs.rmSync(ALERT, { force: true });
  } catch {}
}
