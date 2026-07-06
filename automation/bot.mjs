// 상주 텔레그램 봇 데몬 (24시간 롱폴링).
// - 발신자 화이트리스트(내 chat id만)
// - 명령: /help /status /draft [키워드] /delete <슬러그>
// - 하트비트 기록(워치독이 감시)
// - [✅승인]/[❌반려] 인라인 버튼 콜백 처리
// 게시는 오직 승인(→publish)으로만. 자동 게시 경로 없음.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadEnv, loadConfig, requireSecrets, AUTO_DIR, ROOT } from './lib/env.mjs';
import { getUpdates, sendMessage, sendDocument, answerCallback, inlineButtons } from './lib/telegram.mjs';

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
let _publishImpl = null; // 테스트 주입용 seam(프로덕션 경로엔 영향 없음)
export function __setPublishImpl(fn) { _publishImpl = fn; }
async function publishSlug(slug, title) {
  if (_publishImpl) return _publishImpl(slug, title);
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
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
// kwmap 에 키워드 등록 → gen:<id> 콜백으로 재사용(재시도·/draft 계속)
function registerKw(entry) {
  const f = path.join(STATE, 'kwmap.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  let id, i = 0;
  do { id = 'k' + Math.abs(hash(entry.keyword + '#d' + i)).toString(36); i++; } while (map[id]);
  map[id] = { keyword: entry.keyword, source: entry.source || 'manual', gossip: !!entry.gossip };
  fs.writeFileSync(f, JSON.stringify(map, null, 1));
  return id;
}
async function existingTopic(keyword) {
  const { existingMatch } = await import('./lib/topics.mjs');
  return existingMatch(keyword);
}

// ── 전문보기용 GFM 표 → 모노스페이스 정렬 ──
function extractTables(md) {
  const L = md.split('\n'), out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');
  for (let i = 0; i < L.length; i++) {
    if (isRow(L[i]) && isSep(L[i + 1] || '')) {
      const rows = []; let j = i;
      while (j < L.length && isRow(L[j])) { rows.push(L[j]); j++; }
      out.push(rows); i = j - 1;
    }
  }
  return out;
}
const dispW = (s) => [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
function alignTable(rows) {
  const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const data = cells.filter((_, idx) => idx !== 1); // 구분행 제거
  const ncol = Math.max(...data.map((r) => r.length));
  const w = Array.from({ length: ncol }, (_, c) => Math.max(...data.map((r) => dispW(r[c] || ''))));
  const pad = (s, w2) => s + ' '.repeat(Math.max(0, w2 - dispW(s)));
  return data
    .map((r, ri) => {
      const line = r.map((c, ci) => pad(c || '', w[ci])).join('  ');
      return ri === 0 ? line + '\n' + w.map((x) => '─'.repeat(x)).join('  ') : line;
    })
    .join('\n');
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
        const { sendFailure } = await import('./generate.mjs');
        await sendFailure(ME, entry, r); // 구분형 오류(한도/인증) + [🔄재시도]
      }
    } catch (e) {
      await sendMessage(ME, `❌ "${entry.keyword}" 오류: ${e.message}`);
    }
  }
  genBusy = false;
}

// ---- 초안 수정(발행 전) : [✏️수정] → 답장 지시 → 부분수정 ----
const EDITS = path.join(STATE, 'edits.json');
const loadEditPending = () => {
  try { return JSON.parse(fs.readFileSync(EDITS, 'utf8')); } catch { return {}; }
};
function saveEditPending(msgId, entry) {
  const m = loadEditPending();
  m[msgId] = { ...entry, ts: Date.now() };
  fs.writeFileSync(EDITS, JSON.stringify(m));
}
function clearEditPending(msgId) {
  const m = loadEditPending();
  delete m[msgId];
  fs.writeFileSync(EDITS, JSON.stringify(m));
}
// D-6: 당일 발행 수 카운트(오늘 것만 유지).
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜
}
// 오늘 이미 발행한 편수(읽기 전용) — 상한 판정에 사용.
function todayPublishCount() {
  const f = path.join(STATE, 'publish-days.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8'))[kstToday()] || 0; } catch { return 0; }
}
// 발행 성공 시 호출해 카운트 +1.
function bumpPublishCount() {
  const f = path.join(STATE, 'publish-days.json');
  const today = kstToday();
  let m = {};
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  m = { [today]: (m[today] || 0) + 1 }; // 과거 날짜는 정리
  fs.writeFileSync(f, JSON.stringify(m));
  return m[today];
}
// 실제 게시 실행(상한 이하 승인 · 상한 재확인 후 공용). 오직 사람 승인으로만 도달.
async function doPublish(entry) {
  try {
    const res = await publishSlug(entry.slug, entry.title);
    if (res.ok) {
      const n = bumpPublishCount();
      const cap = CFG.maxSameDayPublish || 3;
      let msg = `🚀 게시 완료\n${res.url}`;
      if (n >= cap) {
        msg += `\n\n📊 오늘 ${n}편 발행(상한 ${cap}편). 신생 사이트는 분산 발행을 권장합니다. 남은 초안은 내일 승인해도 재고로 유지됩니다.`;
      }
      await sendMessage(ME, msg);
    } else {
      await sendMessage(ME, `❌ 게시 실패: ${res.error}`);
    }
  } catch (e) {
    await sendMessage(ME, `❌ 게시 오류: ${e.message}`);
  }
}
async function handleEdit(pending, instruction, replyId) {
  clearEditPending(replyId);
  await sendMessage(ME, `⏳ "${pending.title.slice(0, 24)}" 수정 중…`);
  try {
    const { editDraft } = await import('./generate.mjs');
    const r = await editDraft(pending.slug, instruction, CFG, ME);
    if (!r.ok) {
      if (r.error === 'published') await sendMessage(ME, '🔒 발행된 글은 여기서 수정 불가(편집기·별도 지시로).');
      else await sendMessage(ME, `❌ 수정 실패: ${r.error}`);
    }
    // 성공 시 editDraft 가 수정된 카드를 다시 보냄
  } catch (e) {
    await sendMessage(ME, `❌ 수정 오류: ${e.message}`);
  }
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
          '🤖 트렌드 초안 봇 (v2.4)',
          '/brief — 지금 키워드 브리핑 받기(후보 버튼)',
          '/draft <주제> — 자유 주제로 1편(여러 단어·문장형 가능)',
          '/draft — 모드 기본동작(briefing=브리핑 / batch=일괄)',
          '/status — 상태 확인',
          '/delete <슬러그> — 초안 삭제',
          '',
          `엔진: ${CFG.engine} · 모드: ${CFG.mode}`,
          '흐름: 브리핑 → 키워드 탭 → 초안 → (필요시 ✏️수정) → [✅승인] 눌러야만 게시.',
          '',
          '✏️ 수정(발행 전만): 초안 카드의 [✏️수정] → 안내에 답장으로 지시.',
          '   • "제목: 새 제목" → 제목·주소 교체',
          '   • "첫 문단 쉽게 / 표에 ○○행 추가 / 끝에 주의 한 줄" → AI 부분수정.',
          '   여러 번 수정 가능. 표·이미지 정밀 편집은 편집기(npm run write) 권장.',
          '   발행된 글은 여기서 수정 불가 → 편집기 또는 별도 지시.',
          '📂 표시(기존 글 보유): 같은 주제 글이 이미 있다는 신호.',
          '   → 새로 만들지(탭하지) 말고, 그 글을 "갱신"하도록 지시하세요.',
          '🔄 재시도: 생성 실패 시 원터치 재생성. 🔐인증오류=점검, ⏳한도=리셋 후.',
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
          // 기존 글과 주제 겹치면 경고 후 진행 여부를 물음
          const m = await existingTopic(arg);
          if (m && m.score >= 1) {
            const id = registerKw({ keyword: arg, source: 'manual', gossip: false });
            await sendMessage(
              ME,
              `⚠️ 유사 발행글이 있습니다:\n📂 "${m.title}"\n\n새 초안을 만들면 주제가 겹칩니다. 기존 글 '갱신'을 권장합니다. 그래도 새로 만들까요?`,
              inlineButtons([[
                { text: '✅ 계속(새 초안)', callback_data: 'gen:' + id },
                { text: '❌ 취소', callback_data: 'cancel:x' },
              ]])
            );
          } else {
            await sendMessage(ME, `⏳ "${arg}" 초안 생성 중…`);
            genQueue.push({ keyword: arg, source: 'manual', gossip: false });
            drainQueue();
          }
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

  // 키워드 브리핑/재시도/계속 버튼 탭 → 생성 큐에 추가(순차 처리)
  if (action === 'gen') {
    const kw = loadKwMap()[id];
    await answerCallback(cb.id, kw ? `대기열 추가: ${kw.keyword.slice(0, 20)}` : '만료된 버튼');
    if (!kw) return;
    genQueue.push(kw);
    drainQueue(); // 백그라운드(await 안 함) — 봇은 계속 응답
    return;
  }
  if (action === 'cancel') {
    await answerCallback(cb.id, '취소됨');
    return sendMessage(ME, '취소했습니다.');
  }

  const map = loadDraftMap();
  const entry = map[id];
  await answerCallback(
    cb.id,
    action === 'ok' || action === 'okforce' ? '처리 중…' : action === 'view' ? '전문 전송 중…' : action === 'edit' ? '수정 안내 전송' : action === 'hold' ? '보류' : '반려됨'
  );
  if (!entry) return sendMessage(ME, '만료된 초안입니다(봇 재시작됨).');
  const f = path.join(ROOT, 'src/content/blog', entry.slug, 'index.md');

  if (action === 'edit') {
    // 안전장치: 발행된(draft:false) 글은 수정 차단
    if (fs.existsSync(f) && !/^draft:\s*true/m.test(fs.readFileSync(f, 'utf8'))) {
      return sendMessage(
        ME,
        `🔒 "${entry.title}"는 이미 발행된 글이라 여기서 수정할 수 없습니다.\n편집기(npm run write)에서 열거나, 재산세 갱신처럼 별도 지시로 고쳐주세요.`
      );
    }
    const sent = await sendMessage(
      ME,
      [
        `✏️ "${entry.title}"`,
        '무엇을 고칠까요? 이 메시지에 답장(reply)으로 지시해 주세요.',
        '',
        '예시:',
        '• 제목: 새로운 제목',
        '• 첫 문단을 더 쉽게 풀어줘',
        '• 표에 9월분 행을 추가해줘',
        '• 마지막에 주의사항 한 줄 추가',
        '',
        '표·이미지 정밀 편집은 편집기(npm run write)를 권장합니다.',
      ].join('\n')
    );
    saveEditPending(sent.message_id, { slug: entry.slug, title: entry.title });
    return;
  }
  if (action === 'view') {
    if (!fs.existsSync(f)) return sendMessage(ME, `파일 없음: ${entry.slug}`);
    // 문서 첨부는 한글 미리보기가 깨져 → 텍스트로 분할 전송(자동 분할)
    const md = fs.readFileSync(f, 'utf8');
    await sendMessage(ME, `📖 ${entry.title}\n\n${md}`);
    // 표가 있으면 모노스페이스 정렬로 다시 보여줌(게시 화면은 깔끔하게 렌더)
    const tables = extractTables(md);
    if (tables.length) {
      await sendMessage(ME, '📊 아래 표는 게시 화면에서 깔끔한 표로 렌더됩니다 (여기선 정렬 미리보기):');
      for (const rows of tables) {
        const esc = alignTable(rows).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
        await sendMessage(ME, '```\n' + esc + '\n```', { parse_mode: 'MarkdownV2' });
      }
    }
  } else if (action === 'ok') {
    const cap = CFG.maxSameDayPublish || 3;
    const already = todayPublishCount();
    if (already >= cap) {
      // 상한 도달 — 차단하지 않고 사람이 한 번 더 확인하도록 재확인 단계를 둔다.
      // (대원칙: 게시는 오직 사람의 명시적 승인으로만. 여기선 '재확인'이 그 승인.)
      await sendMessage(
        ME,
        [
          `🛑 오늘 발행 상한(${cap}편) 도달 — 내일 발행을 권장합니다.`,
          `이 초안은 재고로 남아 내일 그대로 승인·발행할 수 있어요.`,
          '',
          `그래도 지금 "${entry.title}"를 발행하려면 아래에서 한 번 더 확인해 주세요.`,
        ].join('\n'),
        inlineButtons([[
          { text: `⚠️ 상한 무시하고 지금 발행`, callback_data: 'okforce:' + id },
          { text: '🗓 내일로 보류', callback_data: 'hold:' + id },
        ]])
      );
      return;
    }
    await doPublish(entry);
  } else if (action === 'okforce') {
    // 상한 재확인 통과 — 사람이 명시적으로 한 번 더 확인함.
    await doPublish(entry);
  } else if (action === 'hold') {
    await sendMessage(ME, `🗓 보류(재고 유지): "${entry.title}"\n내일 카드에서 다시 ✅ 승인하면 발행됩니다.`);
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
        if (msg?.text) {
          let replyId = msg.reply_to_message?.message_id;
          const pendings = loadEditPending();
          let pending = replyId ? pendings[replyId] : null;
          // 답장이 아니어도, 15분 내 대기 중 수정요청이 있으면 가장 최근 것에 적용(폴백)
          if (!pending && !msg.text.startsWith('/')) {
            const keys = Object.keys(pendings).sort((a, b) => (pendings[b].ts || 0) - (pendings[a].ts || 0));
            if (keys.length && Date.now() - (pendings[keys[0]].ts || 0) < 15 * 60 * 1000) {
              pending = pendings[keys[0]];
              replyId = keys[0];
            }
          }
          if (pending) await handleEdit(pending, msg.text, replyId);
          else if (msg.text.startsWith('/')) await handleCommand(msg.text);
          else await sendMessage(ME, '명령은 /help, 초안 수정은 카드의 [✏️수정]을 누른 뒤 지시하세요.');
        } else if (cb) await handleCallback(cb);
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

// 직접 실행(node bot.mjs)일 때만 데몬 기동. import(테스트 등) 시엔 기동 안 함.
const runDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// 테스트 전용 export
export { handleCallback, todayPublishCount, bumpPublishCount, doPublish };
