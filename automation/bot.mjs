// 상주 텔레그램 봇 데몬 (24시간 롱폴링).
// - 발신자 화이트리스트(내 chat id만)
// - 명령: /help /status /brief /draft [키워드] /delete <슬러그> /unpublish <슬러그>
// - 하트비트 기록(워치독이 감시)
// - [✅승인]/[❌반려] 인라인 버튼 콜백 처리
// 게시는 오직 승인(→publish)으로만. 자동 게시 경로 없음.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadEnv, loadConfig, requireSecrets, AUTO_DIR, ROOT } from './lib/env.mjs';
import { getUpdates, sendMessage, sendDocument, answerCallback, inlineButtons, fetchFileBytes } from './lib/telegram.mjs';
import { parseCapture, isTooThin } from './lib/capture.mjs';

loadEnv();
requireSecrets(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
const CFG = loadConfig();
const ME = String(process.env.TELEGRAM_CHAT_ID);
const STATE = path.join(AUTO_DIR, 'state');
fs.mkdirSync(STATE, { recursive: true });
const HEARTBEAT = path.join(STATE, 'heartbeat.json');
const DRAFTS = path.join(STATE, 'drafts.json'); // 콜백 id → 슬러그 매핑
// 🔴 생성 큐 영속화(2026-07-19 사고).
//    genQueue 가 순수 메모리라, 워치독이 kickstart -k 로 강제 재시작하면 진행 중이던
//    생성과 대기 중인 것들이 통째로 사라졌다. 사람에게는 "초안 생성 중…"이라고
//    말해둔 뒤였는데 취소 통지도 없어서, 조용히 증발한 걸 한참 뒤에 알게 됐다
//    (카페인 반감기 초안). 무엇이 날아갔는지는 사람에게 반드시 알려야 한다.
const GENQUEUE = path.join(STATE, 'genqueue.json');

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
async function publishSlug(slug, title, keyword) {
  if (_publishImpl) return _publishImpl(slug, title, keyword);
  const { publish } = await import('./publish.mjs');
  return publish({ slug, title, keyword });
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
let genInflight = null; // 지금 생성 중인 항목 — 재시작 시 '무엇이 날아갔나'의 핵심

// 큐 상태를 디스크에 반영. 실패해도 생성은 계속한다(영속화는 보조 장치일 뿐).
function persistGenQueue() {
  try {
    fs.writeFileSync(GENQUEUE, JSON.stringify({
      inflight: genInflight, pending: genQueue, ts: Date.now(),
    }, null, 1));
  } catch (e) { console.error('[bot] 생성 큐 저장 실패:', e.message); }
}
const loadGenQueue = () => { try { return JSON.parse(fs.readFileSync(GENQUEUE, 'utf8')); } catch { return null; } };
const clearGenQueue = () => { try { fs.rmSync(GENQUEUE, { force: true }); } catch {} };

// 🔴 큐에 넣는 곳이 여러 군데라, 넣는 경로를 하나로 모아 영속화를 빠뜨리지 않게 한다.
function enqueueGen(entry) {
  genQueue.push(entry);
  persistGenQueue();
  drainQueue(); // 백그라운드(await 안 함) — 봇은 계속 응답
}

async function drainQueue() {
  if (genBusy) return;
  genBusy = true;
  while (genQueue.length) {
    const entry = genQueue.shift();
    genInflight = entry;
    persistGenQueue();
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
    genInflight = null;
    persistGenQueue();
  }
  genBusy = false;
  clearGenQueue(); // 큐가 비었으면 파일을 남기지 않는다
}

// ── 재시작 후 유실 통지 ───────────────────────────────────────────────
// 🔴 자동으로 재개하지 않는다. 두 가지 이유다:
//   ① 생성이 봇을 죽인 경우(행·메모리) 자동 재개는 그대로 재시작 루프가 된다.
//   ② 이 저장소의 원칙은 '생성은 사람이 버튼을 눌러야'다. 재시작이 그 원칙을
//      우회하는 경로가 되면 안 된다.
// 대신 무엇이 취소됐는지 알리고, 한 번만 누르면 되게 [🔄 다시 생성]을 붙인다
// (기존 gen: 콜백을 그대로 쓴다 — 새 경로를 만들지 않는다).
async function recoverGenQueue() {
  const st = loadGenQueue();
  if (!st) return;
  const orphans = [...(st.inflight ? [st.inflight] : []), ...(st.pending || [])]
    .filter((e) => e && e.keyword);
  if (!orphans.length) { clearGenQueue(); return; }

  const L = ['❌ 생성 취소됨(봇 재시작) — 다시 눌러주세요'];
  if (st.inflight?.keyword) L.push(`  · 진행 중이던 것: "${st.inflight.keyword}"`);
  const waiting = (st.pending || []).filter((e) => e?.keyword);
  if (waiting.length) L.push(`  · 대기 중이던 것 ${waiting.length}개: ${waiting.map((e) => e.keyword).join(', ')}`);
  L.push('');
  L.push('자동으로 다시 만들지 않습니다(재시작 루프 방지). 아래를 누르면 큐에 다시 들어갑니다.');

  const rows = orphans.slice(0, 6).map((e) => [
    { text: `🔄 ${e.keyword.slice(0, 18)}`, callback_data: 'gen:' + registerKw(e) },
  ]);
  try {
    await sendMessage(ME, L.join('\n'), inlineButtons(rows));
    clearGenQueue(); // 통지에 성공했을 때만 지운다
  } catch (e) {
    // 🔴 재시작 직후엔 네트워크가 아직 안 올라와 통지가 실패할 수 있다
    //    (절전에서 깬 직후가 정확히 그렇다). 그땐 파일을 남겨 다음 기동에 다시 알린다.
    //    다만 무한 반복은 막는다 — 3회 실패하면 포기하고 로그만 남긴다.
    const fails = (st.notifyFails || 0) + 1;
    console.error(`[bot] 유실 통지 실패(${fails}회):`, e.message);
    if (fails >= 3) { clearGenQueue(); console.error('[bot] 유실 통지 3회 실패 — 포기하고 큐를 비웁니다'); }
    else { try { fs.writeFileSync(GENQUEUE, JSON.stringify({ ...st, notifyFails: fails }, null, 1)); } catch {} }
  }
}

// ---- 📷 현장 캡처 발행 ----------------------------------------------------
// "/<주제> <정보>" + 사진 → 초안 → 기존 승인 큐. 게시는 여전히 [✅승인]으로만.
// 브리핑(v2.8)과는 완전히 별개 경로다 — 재고(topicsPool)를 건드리지 않는다.
const ALBUM_DEBOUNCE_MS = 2500;
const albums = new Map(); // media_group_id → 모으는 중인 앨범

// 사진 메시지에서 받을 file_id 하나를 고른다.
//  · msg.photo 는 해상도별 썸네일 배열 — 마지막이 가장 큰 것.
//  · '문서로 보내기'로 온 이미지(원본 EXIF 보존)도 받는다. 어차피 EXIF 는 우리가 지운다.
function pickFileId(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document && /^image\//.test(msg.document.mime_type || '')) return msg.document.file_id;
  return null;
}
const isPhotoMessage = (msg) => !!pickFileId(msg);

// 앨범은 한 덩어리가 아니라 개별 update 로 온다(같은 media_group_id).
// 마지막 사진 이후 2.5초간 조용하면 확정하고, message_id 순 = 내가 보낸 순서로 정렬한다.
// 캡션은 앨범의 첫 장에만 붙으므로 전체에서 찾는다.
function bufferPhoto(msg) {
  const gid = msg.media_group_id || `single:${msg.message_id}`;
  let a = albums.get(gid);
  if (!a) { a = { items: [], caption: '' }; albums.set(gid, a); }
  a.items.push({ fileId: pickFileId(msg), messageId: msg.message_id });
  const cap = (msg.caption || '').trim();
  if (cap && !a.caption) a.caption = cap;
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    albums.delete(gid);
    // 여기서 조용히 죽으면 사진만 보내고 아무 응답도 못 받는다 — 반드시 알린다.
    // (알림 자체가 실패하는 건 텔레그램이 죽은 경우뿐이라 그때는 로그만 남긴다.)
    onAlbumReady(a).catch(async (e) => {
      console.error('[capture] 앨범 처리 오류:', e);
      try {
        await sendMessage(ME, `❌ 사진 ${a.items.length}장 처리 중 오류: ${e?.message || e}\n다시 보내주세요.`);
      } catch (e2) {
        console.error('[capture] 오류 알림도 실패:', e2?.message || e2);
      }
    });
  }, ALBUM_DEBOUNCE_MS);
}

async function onAlbumReady(album) {
  const items = album.items.sort((x, y) => x.messageId - y.messageId); // 보낸 순서 유지
  const cap = parseCapture(album.caption);
  if (!cap) {
    return sendMessage(
      ME,
      album.caption
        ? `📷 사진 ${items.length}장을 받았지만 "${album.caption.slice(0, 30)}"는 캡처 명령이 아닙니다.\n사진 설명에 "/주차 코엑스 주차장"처럼 적어 주세요.`
        : `📷 사진 ${items.length}장을 받았지만 주제가 없습니다.\n사진 설명(캡션)에 "/주차 코엑스 주차장"처럼 적어서 다시 보내주세요.`
    );
  }
  captureQueue.push({ ...cap, fileIds: items.map((i) => i.fileId) });
  drainCaptures();
}

const captureQueue = [];
let captureBusy = false;
async function drainCaptures() {
  if (captureBusy) return;
  captureBusy = true;
  while (captureQueue.length) {
    const job = captureQueue.shift();
    try {
      await sendMessage(
        ME,
        `⏳ /${job.topic} 초안 생성 중…${job.fileIds.length ? ` (사진 ${job.fileIds.length}장 처리 포함)` : ''}`
      );
      const buffers = [];
      for (let i = 0; i < job.fileIds.length; i++) {
        try {
          buffers.push(await fetchFileBytes(job.fileIds[i]));
        } catch (e) {
          await sendMessage(ME, `⚠️ ${i + 1}번 사진을 받지 못했습니다: ${e.message}`);
        }
      }
      const { runCapture } = await import('./lib/capture.mjs');
      const r = await runCapture({ topic: job.topic, info: job.info, photoBuffers: buffers, chatId: ME, config: CFG });
      if (!r.ok) await sendMessage(ME, `❌ /${job.topic} ${r.error}`);
    } catch (e) {
      console.error('[capture] 실패:', e);
      await sendMessage(ME, `❌ /${job.topic} 오류: ${e.message}`);
    }
  }
  captureBusy = false;
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
// 발행 상한 게이트 — config.publishCap.enabled=false(기본)면 무제한.
// true 로 되돌리면 perDay 상한이 부활해 초과분 발행을 거부한다.
const capOn = () => CFG.publishCap?.enabled === true;
const capPerDay = () => CFG.publishCap?.perDay ?? 5;

// 실제 게시 실행 — 승인 = 즉시 1회 게시. 오직 사람 승인으로만 도달, 대기하는 항목 없음.
// 실패는 절대 조용히 넘어가지 않는다: 사유를 붙여 알리고 멈춘 뒤 [🔄 재발행]을 제공.
async function doPublish(entry, cbId) {
  try {
    const res = await publishSlug(entry.slug, entry.title, entry.keyword);
    if (res.ok) {
      const n = bumpPublishCount();
      await sendMessage(ME, `🚀 게시 완료 (오늘 ${n}편째)\n${res.url}`);
      return true;
    }
    // res.error 는 publish.mjs 가 분류·보장한 비어있지 않은 사유.
    const reason = res.error || '알 수 없는 오류(사유 미상 — 봇 로그 확인 필요)';
    console.error('[publish] 실패:', entry.slug, reason);
    await sendMessage(
      ME,
      `❌ 게시 실패: ${reason}\n\n📄 "${entry.title}"\n중단됨 — 초안은 그대로 남아 있습니다. 원인 해결 후 아래로 재시도하세요.`,
      cbId ? inlineButtons([[{ text: '🔄 재발행', callback_data: 'ok:' + cbId }]]) : undefined
    );
    return false;
  } catch (e) {
    const reason = e?.message || `알 수 없는 예외(${e})`;
    console.error('[publish] 예외:', entry.slug, e);
    await sendMessage(
      ME,
      `❌ 게시 실패: ${reason}\n\n📄 "${entry.title}"\n중단됨 — 초안은 그대로 남아 있습니다.`,
      cbId ? inlineButtons([[{ text: '🔄 재발행', callback_data: 'ok:' + cbId }]]) : undefined
    );
    return false;
  }
}

// 갱신 대기 레지스트리(진단→생성→반영). state/updates.json: id → {slug,title,backup,url}
function registerUpdate(entry) {
  const f = path.join(STATE, 'updates.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  let id, i = 0;
  do { id = 'u' + Math.abs(hash(entry.slug + '#u' + i)).toString(36); i++; } while (map[id]);
  map[id] = { ...entry, ts: Date.now() };
  fs.writeFileSync(f, JSON.stringify(map, null, 1));
  return id;
}
const loadUpdateMap = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'updates.json'), 'utf8')); } catch { return {}; } };
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

// 슬러그 하나의 상태를 읽는다 — /delete(초안 전용)와 /unpublish(발행글 전용)의 판정 근거.
// '발행됨' 판정은 두 신호를 모두 본다: draft:false 이고 git 이 추적 중.
// (draft:false 인데 아직 커밋 안 된 글은 사이트에 없으므로 /unpublish 대상이 아니다.)
function postState(slug) {
  const dir = path.join(ROOT, 'src/content/blog', slug);
  const f = path.join(dir, 'index.md');
  if (!fs.existsSync(f)) return { exists: false, published: false };
  const raw = fs.readFileSync(f, 'utf8');
  const isDraft = /^draft:\s*true/m.test(raw);
  let tracked = 0;
  try {
    const rel = path.relative(ROOT, dir);
    const out = execFileSync('git', ['ls-files', '--', rel], { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    tracked = out ? out.split('\n').filter(Boolean).length : 0;
  } catch { /* git 실패 시 추적 0 으로 간주 */ }
  const pick = (re) => (raw.match(re) || [])[1] || '';
  const title = pick(/^title:\s*"?(.*?)"?\s*$/m);
  const orig = pick(/^originalPath:\s*"?(.*?)"?\s*$/m);
  const url = orig
    ? 'https://allexishere.com' + encodeURI(orig)
    : 'https://allexishere.com/entry/' + encodeURIComponent(slug);
  let images = 0;
  try { images = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|webp|gif)$/i.test(n)).length; } catch {}
  return {
    exists: true,
    published: !isDraft && tracked > 0,
    isDraft, tracked, title,
    pubDate: pick(/^pubDate:\s*(.*?)\s*$/m).slice(0, 10),
    url, images,
  };
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
          '🤖 콘텐츠 봇 (v2.7 + 축2 재고)',
          '흐름: 하루 1회(10시) 브리핑 → 골라서 초안 → [✅승인] = 즉시 게시(예약 없음·발행 상한 없음).',
          '📂 갱신 후보는 탭하면 진단 먼저 → [갱신 초안 생성] → [✅갱신 반영](주소 불변).',
          '/brief — 지금 키워드 브리핑 받기(후보 버튼)',
          '/draft <주제> — 자유 주제로 1편(여러 단어·문장형 가능)',
          '/draft — 모드 기본동작(briefing=브리핑 / batch=일괄)',
          '/status — 상태 확인',
          '/delete <슬러그> — 초안 삭제(발행글은 거부됨)',
          '/unpublish <슬러그> — 발행글을 사이트에서 내림 (확인 카드 → [⚠️ 내리기])',
          '   · 주소가 사라지고 검색 유입도 끊깁니다. 내용이 틀린 거라면 갱신을 권합니다.',
          '',
          '📷 현장 캡처 발행 (수동 입력 — 브리핑과 별개)',
          '   "/<주제> <정보>" + 사진(여러 장 가능·선택)을 보내면 초안이 승인 큐로 옵니다.',
          '   예: /주차 코엑스 주차장  ·  /맛집 서초동 김밥천국 가성비 좋음',
          '       /스포츠용품 아디다스 F50 축구화  ·  /여행 강릉 안목해변',
          '   주제는 아무거나 됩니다(새 주제도 그대로 사용 가능).',
          '   사진은 자동으로: EXIF·GPS 제거 → 1200px 축소 → 글 폴더에 저장.',
          '   🔒 영수증·명함·티켓은 내용만 글에 쓰고 사진은 발행에서 뺍니다.',
          '   👤 얼굴이 뚜렷하면 보류 — [사진 포함하기]를 눌러야 들어갑니다(초상권).',
          '   ⚠️ 개인정보(카드·연락처 등)가 본문에 섞이면 자동 제거 후 알려줍니다.',
          '',
          `엔진: ${CFG.engine} · 모드: ${CFG.mode}`,
          '흐름: 브리핑 → 키워드 탭 → 초안 → (필요시 ✏️수정) → [✅승인] 눌러야만 게시(누르면 바로 게시).',
          '게시 실패 시 사유를 표시하고 멈춥니다 — 초안은 남아 있고 [🔄재발행]으로 재시도.',
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
            enqueueGen({ keyword: arg, source: 'manual', gossip: false });
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
      if (!arg) return sendMessage(ME, '사용법: /delete <슬러그>  (초안 전용)');
      const dir = path.join(ROOT, 'src/content/blog', arg);
      if (!fs.existsSync(dir)) return sendMessage(ME, `없는 슬러그: ${arg}`);
      // 🔒 발행글 차단. 예전엔 검사가 없어서 발행글도 지워졌는데, /delete 는 git 을
      //    건드리지 않으므로 "삭제됨"이라 답하면서 실제로는 사이트에 그대로 남았다.
      //    게다가 로컬 파일이 사라져 중복방어 인덱스에서 빠지는 부작용까지 있었다.
      const st = postState(arg);
      if (st.published) {
        await sendMessage(
          ME,
          `🔒 발행된 글입니다. /delete 는 초안 전용입니다.\n` +
            `📄 "${st.title || arg}"\n\n` +
            `내리려면 아래를 쓰세요(확인 단계가 있습니다):\n/unpublish ${arg}`
        );
        break;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      await sendMessage(ME, `🗑 초안 삭제됨: ${arg}`);
      break;
    }
    case '/unpublish': {
      if (!arg) return sendMessage(ME, '사용법: /unpublish <슬러그>  (발행글을 사이트에서 내림)');
      const st = postState(arg);
      if (!st.exists) return sendMessage(ME, `없는 슬러그: ${arg}`);
      if (!st.published) {
        return sendMessage(ME, `📄 초안입니다(사이트에 없음) — ${arg}\n초안은 /delete 로 지우세요.`);
      }
      // 2단계 확인 — 여기서는 절대 지우지 않는다. 카드의 [⚠️ 내리기]를 눌러야만 실행.
      const id = registerUpdate({ slug: arg, title: st.title, url: st.url });
      await sendMessage(
        ME,
        [
          `⚠️ 발행된 글을 내립니다 — 확인해 주세요`,
          ``,
          `📄 ${st.title || arg}`,
          `🔗 ${st.url}`,
          st.pubDate ? `📅 발행 ${st.pubDate}` : '',
          st.images ? `🖼 첨부 사진 ${st.images}장 함께 삭제` : '',
          ``,
          `지우면 이 주소가 사라집니다. 검색 결과에 남아 있던 유입도 끊깁니다.`,
          `⚠️ 내용이 틀린 거라면 삭제보다 갱신을 권합니다(📂 갱신 트랙 — 주소를 지키면서 고칩니다).`,
          ``,
          `[⚠️ 내리기]를 눌러야 실행됩니다.`,
        ].filter(Boolean).join('\n'),
        inlineButtons([[
          { text: '⚠️ 내리기', callback_data: 'unpub:' + id },
          { text: '❌ 취소', callback_data: 'cancel:x' },
        ]])
      );
      break;
    }
    default: {
      // 예약어가 아닌 /명령 = 현장 캡처 주제. 주제를 하드코딩하지 않으므로
      // /맛집 /여행 /스포츠용품 … 어떤 주제든 코드 수정 없이 바로 쓸 수 있다.
      const cap = parseCapture(text);
      if (!cap) {
        await sendMessage(ME, `모르는 명령: ${cmd}\n/help 로 확인하세요.`);
        break;
      }
      // 오타 가드: 사진도 없고 설명도 5자 미만이면 새 주제로 받지 않는다.
      // (/맛칩 같은 오타가 엉뚱한 주제 글로 발행되는 것 방지)
      if (isTooThin({ info: cap.info, photoCount: 0 })) {
        await sendMessage(
          ME,
          `모르는 명령입니다: ${cmd}\n` +
            `현장 캡처로 쓰려면 설명을 붙이거나 사진을 첨부하세요.\n` +
            `예: ${cmd} 코엑스 지하주차장 요금 (또는 사진 첨부)\n` +
            `/help 로 기존 명령을 확인할 수 있습니다.`
        );
        break;
      }
      captureQueue.push({ ...cap, fileIds: [] });
      drainCaptures();
      break;
    }
  }
}

async function handleCallback(cb) {
  const [action, id] = (cb.data || '').split(':');

  // 키워드 브리핑/재시도/계속 버튼 탭 → 생성 큐에 추가(순차 처리)
  if (action === 'gen') {
    const kw = loadKwMap()[id];
    await answerCallback(cb.id, kw ? `대기열 추가: ${kw.keyword.slice(0, 20)}` : '만료된 버튼');
    if (!kw) return;
    enqueueGen(kw); // 영속화 포함(재시작 시 무엇이 날아갔는지 알리기 위해)
    return;
  }
  if (action === 'cancel') {
    await answerCallback(cb.id, '취소됨');
    return sendMessage(ME, '취소했습니다.');
  }

  // 📥 큐레이터 제안을 재고에 추가 — [📥 재고 추가] 를 눌렀을 때만 도달한다.
  // 발행이 아니라 '브리핑 후보'로 넣는 것뿐이고, addTopics 가 발행글 강매칭·중복을
  // 그대로 걸러낸다. source:'agent' 로 표시해 나중에 사람이 낸 주제와 구분할 수 있게 한다.
  if (action === 'curate') {
    await answerCallback(cb.id, '재고에 추가 중…');
    try {
      const f = path.join(STATE, 'curator-proposals.json');
      const map = JSON.parse(fs.readFileSync(f, 'utf8'));
      const entry = map[id];
      if (!entry) return sendMessage(ME, '만료된 제안입니다(큐레이터를 다시 실행하세요).');
      if (entry.addedAt) return sendMessage(ME, `이미 추가된 제안입니다(${entry.addedAt}).`);

      // 🔴 addTopics 대신 addVetted 를 쓴다. addTopics 의 matchLive(토큰 2개 겹침)는
      //    주차 글에서 '콘서트·대구·주차' 같은 흔한 단어로 다른 시설끼리도 걸려,
      //    카드에 '추가 예정'이라 보여준 것이 실제로는 빠지는 일이 생긴다.
      //    큐레이터가 이미 시설명 단위로 더 정밀하게 걸렀으므로 그 결과를 그대로 반영한다.
      const { loadPool, savePool } = await import('./lib/topicsPool.mjs');
      const { addVetted } = await import('./curator.mjs');
      const pool = loadPool();
      if (!pool) return sendMessage(ME, '❌ 재고를 읽지 못했습니다.');
      const added = addVetted(pool, entry.proposals);
      if (added) savePool(pool);

      entry.addedAt = new Date().toISOString();
      entry.addedCount = added;
      fs.writeFileSync(f, JSON.stringify(map, null, 1));

      const skipped = entry.proposals.length - added;
      return sendMessage(ME, [
        `📥 재고 추가 완료 — ${added}/${entry.proposals.length}개`,
        skipped ? `  (${skipped}개는 이미 같은 키워드가 재고에 있어 제외)` : '  카드에 보여드린 그대로 반영됐습니다.',
        '',
        '다음 브리핑부터 후보로 나옵니다. 발행은 여전히 [✅승인]을 눌러야 합니다.',
      ].filter(Boolean).join('\n'));
    } catch (e) {
      return sendMessage(ME, `❌ 재고 추가 오류: ${e.message}`);
    }
  }

  // 🗑 발행 취소 확정 — /unpublish 카드의 [⚠️ 내리기] 를 눌렀을 때만 도달한다.
  if (action === 'unpub') {
    const u = loadUpdateMap()[id];
    await answerCallback(cb.id, u ? '내리는 중…' : '만료된 버튼');
    if (!u) return sendMessage(ME, '만료된 요청입니다(봇 재시작됨). /unpublish 를 다시 실행하세요.');
    await sendMessage(ME, `⏳ "${(u.title || u.slug).slice(0, 30)}" 내리는 중… (커밋·배포 반영까지 1~3분)`);
    try {
      const { unpublishPost } = await import('./publish.mjs');
      const res = await unpublishPost({ slug: u.slug, title: u.title });
      if (!res.ok) return sendMessage(ME, `❌ 발행 취소 실패: ${res.error}`);
      return sendMessage(
        ME,
        [
          `🗑 내려졌습니다 (파일 ${res.removed}개 제거)`,
          `🔗 ${res.url}`,
          `→ 재배포가 끝나면 이 주소는 사라집니다(404).`,
          `🔎 검색엔진에는 90초 뒤 자동 통보 — 색인에서 빠지는 데는 며칠 걸릴 수 있습니다.`,
          res.revived ? `♻️ 재고 되살림: "${res.revived}" (다시 제안될 수 있음)` : '',
        ].filter(Boolean).join('\n')
      );
    } catch (e) {
      return sendMessage(ME, `❌ 발행 취소 오류: ${e.message}`);
    }
  }

  // 👤 보류된 사진(얼굴·분류실패) 포함하기 — 기본은 제외, 사람이 눌러야 들어간다.
  if (action === 'face') {
    await answerCallback(cb.id, '사진 포함 중…');
    try {
      const { includeHeldPhotos } = await import('./lib/capture.mjs');
      const r = await includeHeldPhotos(id, ME);
      if (!r.ok) return sendMessage(ME, `❌ ${r.error}`);
    } catch (e) {
      return sendMessage(ME, `❌ 사진 포함 오류: ${e.message}`);
    }
    return;
  }

  // 📂 갱신 진단(즉시 생성 아님) — 무엇이 낡았는지 먼저 보여주고 [갱신 초안 생성] 버튼 제공.
  if (action === 'updiag') {
    const u = loadKwMap()[id];
    await answerCallback(cb.id, u ? '갱신 진단 중…' : '만료된 버튼');
    if (!u || u.type !== 'update') return sendMessage(ME, '만료된 갱신 후보입니다(브리핑 재수신 필요).');
    const { diagnose } = await import('./lib/updateTrack.mjs');
    const dg = diagnose(u.slug);
    if (!dg.ok) return sendMessage(ME, `❌ ${dg.error}`);
    const gid = registerUpdate({ slug: u.slug, title: u.title, url: u.url });
    const msg = [
      `📂 갱신 진단: ${dg.title}`,
      `🔗 ${dg.url}  ·  본문 ${dg.len}자`,
      `🔧 낡은 신호:`,
      ...dg.reasons.map((r) => `  • ${r}`),
      dg.lastUpdated ? `🕒 마지막 갱신: ${new Date(dg.lastUpdated).toLocaleDateString('ko-KR')}` : '',
      '',
      '표준: 주소 불변 · 공식출처·기준일 · [D]가드 · FAQ 2~3개 보강. 최종 반영은 [✅]만.',
      '아래를 눌러야 갱신 초안을 생성합니다(즉시 생성 아님).',
    ].filter(Boolean).join('\n');
    return sendMessage(ME, msg, inlineButtons([[
      { text: '🔧 갱신 초안 생성', callback_data: 'upgen:' + gid },
      { text: '❌ 취소', callback_data: 'cancel:x' },
    ]]));
  }
  // 🔧 갱신 초안 생성 → 발행글 제자리 최신화(백업). 반영은 다음 카드의 [✅]에서만.
  if (action === 'upgen') {
    const u = loadUpdateMap()[id];
    await answerCallback(cb.id, u ? '갱신 생성 중…' : '만료');
    if (!u) return sendMessage(ME, '만료된 갱신 요청입니다.');
    await sendMessage(ME, `⏳ "${u.title.slice(0, 24)}" 갱신 초안 생성 중… (1~3분)`);
    try {
      const { refreshPublished } = await import('./generate.mjs');
      const r = await refreshPublished(u.slug, CFG, ME);
      if (!r.ok) return sendMessage(ME, `❌ ${r.error}`);
      const aid = registerUpdate({ slug: r.slug, title: r.title, backup: r.backup });
      return sendMessage(ME, [
        `📝 갱신 초안 완성: ${r.title}`,
        `길이 ${r.oldLen}→${r.newLen}자. 발행글이 로컬에서 교체됐습니다(아직 미반영·주소 불변).`,
        '[전문] 확인 후 [✅ 갱신 반영]을 눌러야 커밋·배포됩니다. 취소하면 원본 복원.',
      ].join('\n'), inlineButtons([[
        { text: '📖 전문', callback_data: 'upview:' + aid },
        { text: '✅ 갱신 반영', callback_data: 'upok:' + aid },
        { text: '❌ 취소(복원)', callback_data: 'upno:' + aid },
      ]]));
    } catch (e) { return sendMessage(ME, `❌ 갱신 오류: ${e.message}`); }
  }
  if (action === 'upview' || action === 'upok' || action === 'upno') {
    const u = loadUpdateMap()[id];
    await answerCallback(cb.id, action === 'upview' ? '전문 전송' : action === 'upok' ? '반영 중…' : '복원 중…');
    if (!u) return sendMessage(ME, '만료된 갱신 요청입니다.');
    const f = path.join(ROOT, 'src/content/blog', u.slug, 'index.md');
    if (action === 'upview') {
      if (!fs.existsSync(f)) return sendMessage(ME, '파일 없음');
      return sendMessage(ME, `📖 ${u.title}\n\n${fs.readFileSync(f, 'utf8')}`);
    }
    if (action === 'upno') { // 원본 복원
      try { if (u.backup && fs.existsSync(u.backup)) fs.copyFileSync(u.backup, f); } catch (e) { return sendMessage(ME, `❌ 복원 실패: ${e.message}`); }
      return sendMessage(ME, `↩️ 갱신 취소 — 원본 복원됨: ${u.slug}`);
    }
    // upok: 쿨다운 기록 → 커밋·배포
    try {
      const { recordUpdated } = await import('./lib/updateTrack.mjs');
      recordUpdated(u.slug);
      const { commitUpdate } = await import('./publish.mjs');
      const res = await commitUpdate({ slug: u.slug, title: u.title });
      if (res.ok) return sendMessage(ME, `🚀 갱신 반영 완료(주소 불변)\n${res.url}`);
      return sendMessage(ME, `❌ 갱신 반영 실패: ${res.error}`);
    } catch (e) { return sendMessage(ME, `❌ 갱신 반영 오류: ${e.message}`); }
  }

  const map = loadDraftMap();
  const entry = map[id];
  await answerCallback(
    cb.id,
    action === 'ok' ? '게시 중…' : action === 'view' ? '전문 전송 중…' : action === 'edit' ? '수정 안내 전송' : action === 'hold' ? '보류' : '반려됨'
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
    // 승인 = 즉시 1회 게시(대원칙 불변). 예약·대기 없음.
    if (capOn() && todayPublishCount() >= capPerDay()) {
      // 게이트가 켜져 있을 때만 도달. 기본(enabled:false)에선 절대 막지 않는다.
      await sendMessage(ME, `🛑 오늘 발행이 상한(${capPerDay()}편)에 찼습니다 — "${entry.title}" 게시 안 함.\n무제한으로 돌리려면 config.json 의 publishCap.enabled 를 false 로.`);
      return;
    }
    await doPublish(entry, id);
  } else if (action === 'hold') {
    await sendMessage(ME, `🗓 보류(재고 유지): "${entry.title}"\n다음 브리핑 카드에서 다시 ✅ 승인하면 즉시 게시됩니다.`);
  } else if (action === 'no') {
    // 반려 = 재고 skipped(재제안 금지, 되살림 가능). 재고 주제일 때만 소진.
    try { const { markSkipped } = await import('./lib/topicsPool.mjs'); if (entry.keyword) markSkipped(entry.keyword); } catch {}
    await sendMessage(ME, `↩️ 반려: ${entry.slug} (재고는 skipped 처리)\n삭제하려면 /delete ${entry.slug}`);
  }
}

// 보류 사진 임시 폴더 정리 — 3일 지난 건 버린다(state/ 는 gitignore 라 저장소엔 안 들어감).
function sweepCaptureStaging() {
  const base = path.join(STATE, 'capture');
  if (!fs.existsSync(base)) return;
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 정리 실패는 무시 */ }
  }
}

async function main() {
  writeHeartbeat({ status: 'starting', lastPollOk: Date.now(), lastPollError: null, loopFails: 0 });
  sweepCaptureStaging();
  await sendMessage(ME, '🤖 봇 시작됨. /help');
  // 직전 기동에서 강제 종료로 날아간 생성이 있으면 알린다(자동 재개는 하지 않는다).
  await recoverGenQueue();
  // 전송 못 하고 대기 중인 브리핑 카드가 있으면 재전송한다(절전에서 깬 직후 등).
  try {
    const { flushPending } = await import('./lib/briefing-outbox.mjs');
    const f = await flushPending(ME);
    if (f.sent) console.log(`[bot] 미전송 브리핑 ${f.sent}건 재전송`);
  } catch (e) { console.error('[bot] 브리핑 재전송 확인 실패:', e.message); }
  let offset = 0;
  let lastBeat = 0;
  let loopFails = 0; // 연속 폴링 실패 — 침묵 방지용
  // 🔴 폴링이 '마지막으로 성공한' 시각. 하트비트가 뛰는 것과 폴링이 되는 것은 별개다.
  //    2026-07-19: 토큰이 폐기돼 9시간 동안 getUpdates 가 전부 실패했는데도
  //    하트비트는 정상이라 /status 는 멀쩡해 보였고 워치독도 못 잡았다.
  //    워치독이 이 값을 보게 해서 '살아는 있지만 아무것도 못 받는' 상태를 잡는다.
  let lastPollOk = Date.now();
  let lastPollError = null;
  for (;;) {
    try {
      const updates = await getUpdates(offset, CFG.pollTimeoutSeconds);
      loopFails = 0;
      lastPollOk = Date.now();
      lastPollError = null;
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
        } else if (msg && isPhotoMessage(msg)) {
          // 📷 사진(앨범이면 여러 update 로 나뉘어 온다) → 버퍼에 모아 2.5초 후 확정.
          bufferPhoto(msg);
        } else if (cb) await handleCallback(cb);
      }
    } catch (e) {
      // 네트워크 오류 등 → 잠깐 쉬고 계속(데몬은 죽지 않음). 삼키더라도 흔적은 남긴다.
      console.error('[bot] 폴링 오류:', e?.message || e);
      loopFails++;
      lastPollError = String(e?.message || e).slice(0, 200);
      // 실패 중에도 하트비트는 갱신한다 — 대신 lastPollOk 가 낡아가므로 워치독이 알아챈다.
      writeHeartbeat({ status: 'poll-failing', offset, lastPollOk, lastPollError, loopFails });
      // 연속 실패가 길어지면 침묵하지 않고 1회 알린다(복구 시 loopFails 리셋 → 재발 시 다시 알림).
      if (loopFails === 20) {
        try { await sendMessage(ME, `⚠️ 봇 폴링 연속 실패 ${loopFails}회: ${e?.message || e}\n네트워크·토큰을 확인하세요(봇은 계속 재시도 중).`); } catch {}
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (Date.now() - lastBeat > CFG.heartbeatSeconds * 1000) {
      writeHeartbeat({ status: 'polling', offset, lastPollOk, lastPollError, loopFails });
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
export { persistGenQueue, loadGenQueue, clearGenQueue, enqueueGen, recoverGenQueue, GENQUEUE };
