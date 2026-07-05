// 상주 텔레그램 봇 데몬 (24시간 롱폴링).
// - 발신자 화이트리스트(내 chat id만)
// - 명령: /help /status /draft [키워드] /delete <슬러그>
// - 하트비트 기록(워치독이 감시)
// - [✅승인]/[❌반려] 인라인 버튼 콜백 처리
// 게시는 오직 승인(→publish)으로만. 자동 게시 경로 없음.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEnv, loadConfig, requireSecrets, AUTO_DIR, ROOT } from './lib/env.mjs';
import { getUpdates, sendMessage, sendDocument, answerCallback } from './lib/telegram.mjs';

loadEnv();
requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const CFG = loadConfig();
const ME = String(process.env.TELEGRAM_CHAT_ID);
const STATE = path.join(AUTO_DIR, 'state');
fs.mkdirSync(STATE, { recursive: true });
const HEARTBEAT = path.join(STATE, 'heartbeat.json');
const DRAFTS = path.join(STATE, 'drafts.json'); // 콜백 id → 슬러그 매핑

function writeHeartbeat(extra = {}) {
  fs.writeFileSync(
    HEARTBEAT,
    JSON.stringify({ ts: Date.now(), pid: process.pid, ...extra })
  );
}
function loadDraftMap() {
  try {
    return JSON.parse(fs.readFileSync(DRAFTS, 'utf8'));
  } catch {
    return {};
  }
}

// ---- 지연 로딩(무거운 모듈은 필요할 때만) ----
async function generate(keyword) {
  const { runGenerate } = await import('./generate.mjs');
  return runGenerate({ keyword, chatId: ME, config: CFG });
}
async function publishSlug(slug, title) {
  const { publish } = await import('./publish.mjs');
  return publish({ slug, title });
}
async function runBriefing() {
  const { runBriefing } = await import('./briefing.mjs');
  return runBriefing({ chatId: ME, config: CFG });
}
async function genOne(entry) {
  const { generateOne } = await import('./generate.mjs');
  return generateOne(entry.keyword, entry, CFG, ME);
}
function loadKwMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, 'kwmap.json'), 'utf8'));
  } catch {
    return {};
  }
}

// 키워드 탭 → 순차 생성 큐(여러 개 탭해도 하나씩 처리)
const genQueue = [];
let genBusy = false;
async function drainQueue() {
  if (genBusy) return;
  genBusy = true;
  while (genQueue.length) {
    const entry = genQueue.shift();
    await sendMessage(ME, `⏳ "${entry.keyword}" 초안 생성 중… (남은 대기 ${genQueue.length})`);
    try {
      const r = await genOne(entry);
      if (!r.ok) {
        if (r.reason === 'limit') await sendMessage(ME, `⏳ "${entry.keyword}" 한도/오류 — 나중에 재시도하세요.`);
        else if (r.reason === 'refusal') await sendMessage(ME, `⛔ "${entry.keyword}" 안전상 거절(건너뜀).`);
        else await sendMessage(ME, `❌ "${entry.keyword}" 실패: ${r.message}`);
      }
    } catch (e) {
      await sendMessage(ME, `❌ "${entry.keyword}" 오류: ${e.message}`);
    }
  }
  genBusy = false;
}

// ---- 상태 ----
function statusText() {
  let last = '없음';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(STATE, 'last-run.json'), 'utf8'));
    last = new Date(s.ts).toLocaleString('ko-KR');
  } catch {}
  const drafts = fs.existsSync(path.join(ROOT, 'src/content/blog'))
    ? fs
        .readdirSync(path.join(ROOT, 'src/content/blog'), { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            !d.name.startsWith('_') &&
            !d.name.startsWith('.') &&
            (() => {
              const f = path.join(ROOT, 'src/content/blog', d.name, 'index.md');
              return fs.existsSync(f) && /^draft:\s*true/m.test(fs.readFileSync(f, 'utf8'));
            })()
        ).length
    : 0;
  const load = os.loadavg().map((n) => n.toFixed(2)).join(' ');
  const mem = `${Math.round(os.freemem() / 1e9)}GB free / ${Math.round(os.totalmem() / 1e9)}GB`;
  return [
    '📊 상태',
    `• 마지막 생성: ${last}`,
    `• 대기 초안(draft): ${drafts}편`,
    `• 부하(1/5/15m): ${load}`,
    `• 메모리: ${mem}`,
    `• 봇 PID: ${process.pid}`,
  ].join('\n');
}

async function handleCommand(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case '/start':
    case '/help':
      await sendMessage(
        ME,
        [
          '🤖 트렌드 초안 봇 (v2.1)',
          '/brief — 지금 키워드 브리핑 받기(후보 버튼)',
          '/draft <키워드> — 지정 키워드로 1편 즉시',
          '/draft — 모드 기본동작(briefing=브리핑 / batch=일괄)',
          '/status — 상태 확인',
          '/delete <슬러그> — 초안 삭제',
          '',
          `엔진: ${CFG.engine} · 모드: ${CFG.mode}`,
          '흐름: 브리핑 → 키워드 탭 → 초안 → [✅승인] 눌러야만 게시.',
        ].join('\n')
      );
      break;
    case '/status':
      await sendMessage(ME, statusText());
      break;
    case '/brief':
      await sendMessage(ME, '🗞 브리핑 준비 중…');
      try {
        await runBriefing();
      } catch (e) {
        await sendMessage(ME, `❌ 브리핑 실패: ${e.message}`);
      }
      break;
    case '/draft':
      try {
        if (arg) {
          await sendMessage(ME, `⏳ "${arg}" 초안 생성 중…`);
          await genOne({ keyword: arg, source: 'manual', gossip: false });
        } else if (CFG.mode === 'batch') {
          await sendMessage(ME, '⏳ 일괄(batch) 생성 중…');
          await generate(null);
        } else {
          await runBriefing(); // briefing 모드 기본: 브리핑 전송
        }
      } catch (e) {
        await sendMessage(ME, `❌ 실패: ${e.message}`);
      }
      break;
    case '/delete': {
      if (!arg) return sendMessage(ME, '사용법: /delete <슬러그>');
      const dir = path.join(ROOT, 'src/content/blog', arg);
      if (!fs.existsSync(dir)) return sendMessage(ME, `없는 슬러그: ${arg}`);
      fs.rmSync(dir, { recursive: true, force: true });
      await sendMessage(ME, `🗑 삭제됨: ${arg}`);
      break;
    }
    default:
      await sendMessage(ME, `모르는 명령: ${cmd}\n/help 로 확인하세요.`);
  }
}

async function handleCallback(cb) {
  const [action, id] = (cb.data || '').split(':');

  // 키워드 브리핑 버튼 탭 → 생성 큐에 추가(순차 처리)
  if (action === 'gen') {
    const kw = loadKwMap()[id];
    await answerCallback(cb.id, kw ? `대기열 추가: ${kw.keyword.slice(0, 20)}` : '만료된 버튼');
    if (!kw) return;
    genQueue.push(kw);
    drainQueue(); // 백그라운드(await 안 함) — 봇은 계속 응답
    return;
  }

  const map = loadDraftMap();
  const entry = map[id];
  await answerCallback(
    cb.id,
    action === 'ok' ? '게시 처리 중…' : action === 'view' ? '전문 전송 중…' : '반려됨'
  );
  if (!entry) return sendMessage(ME, '만료된 초안입니다(봇 재시작됨).');
  const f = path.join(ROOT, 'src/content/blog', entry.slug, 'index.md');

  if (action === 'view') {
    if (!fs.existsSync(f)) return sendMessage(ME, `파일 없음: ${entry.slug}`);
    // .md 문서 첨부는 텔레그램 미리보기에서 한글이 깨져 → 텍스트 메시지로 분할 전송(자동 분할)
    const md = fs.readFileSync(f, 'utf8');
    await sendMessage(ME, `📖 ${entry.title}\n\n${md}`);
  } else if (action === 'ok') {
    try {
      const res = await publishSlug(entry.slug, entry.title);
      await sendMessage(ME, res.ok ? `🚀 게시 완료\n${res.url}` : `❌ 게시 실패: ${res.error}`);
    } catch (e) {
      await sendMessage(ME, `❌ 게시 오류: ${e.message}`);
    }
  } else if (action === 'no') {
    await sendMessage(ME, `↩️ 반려(초안 보관): ${entry.slug}\n삭제하려면 /delete ${entry.slug}`);
  }
}

async function main() {
  writeHeartbeat({ status: 'starting' });
  await sendMessage(ME, '🤖 봇 시작됨. /help');
  let offset = 0;
  let lastBeat = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset, CFG.pollTimeoutSeconds);
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        const cb = u.callback_query;
        const fromId = String(msg?.from?.id || cb?.from?.id || '');
        if (fromId !== ME) continue; // 화이트리스트: 나만
        if (msg?.text) await handleCommand(msg.text);
        else if (cb) await handleCallback(cb);
      }
    } catch (e) {
      // 네트워크 오류 등 → 잠깐 쉬고 계속(데몬은 죽지 않음)
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (Date.now() - lastBeat > CFG.heartbeatSeconds * 1000) {
      writeHeartbeat({ status: 'polling', offset });
      lastBeat = Date.now();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
