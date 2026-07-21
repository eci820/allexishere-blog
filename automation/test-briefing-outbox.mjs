// 브리핑 전송 재시도·재전송 대기열 검증 — 실제 텔레그램을 건드리지 않는다.
// globalThis.fetch 를 갈아끼워 네트워크 성공/실패를 흉내낸다. 상태 파일은 실경로를
// 쓰되(실환경 동작 확인) 시작·끝에 없어야 통과로 본다.
import fs from 'node:fs';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'TEST:token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '123';

const { sendMessage } = await import('./lib/telegram.mjs');
const { stashPending, flushPending, PENDING_PATH } = await import('./lib/briefing-outbox.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { (cond ? pass++ : fail++); console.log(`${cond ? '✅' : '❌'} ${name}`); };

const netErr = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; return e; };
const okResp = () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) });
const apiErr = () => ({ json: async () => ({ ok: false, description: 'Unauthorized' }) });

// 안전장치: 시작 시 대기 파일이 남아있으면 테스트가 오염된다.
if (fs.existsSync(PENDING_PATH)) { console.error('중단: 기존 briefing-pending.json 존재 — 수동 확인 필요'); process.exit(2); }

// A) 네트워크 오류 → 재시도 후 성공 (2회 실패 뒤 성공, 총 3번 호출)
let calls = 0;
globalThis.fetch = async () => { calls++; if (calls <= 2) throw netErr(); return okResp(); };
await sendMessage('123', 'hi', { retries: 3, retryGapMs: 10 });
ok('네트워크 오류 2회 후 재시도로 성공 (fetch 3회)', calls === 3);

// B) API 오류(Unauthorized)는 재시도하지 않는다 (fetch 1회 만에 throw)
calls = 0;
globalThis.fetch = async () => { calls++; return apiErr(); };
let threw = false;
try { await sendMessage('123', 'hi', { retries: 3, retryGapMs: 10 }); } catch { threw = true; }
ok('API 오류는 즉시 throw·재시도 안 함 (fetch 1회)', threw && calls === 1);

// C) 전송 완전 실패 → stash 가 대기 파일을 남긴다
globalThis.fetch = async () => { throw netErr(); };
let stashThrew = false;
try { await sendMessage('123', 'card body', { retries: 0 }); } catch { stashThrew = true; }
ok('retries=0 네트워크 오류는 throw', stashThrew);
const id1 = stashPending({ text: 'card body', rows: [[{ text: 'x', callback_data: 'gen:1' }]] });
ok('stash 후 briefing-pending.json 생성', fs.existsSync(PENDING_PATH));
const stashed = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
ok('대기 카드 1건·본문 보존', stashed.length === 1 && stashed[0].text === 'card body');

// C-2) 같은 카드 재stash → 중복 안 쌓임
const id2 = stashPending({ text: 'card body', rows: [] });
ok('같은 카드 중복 방지(id 동일)', id1 === id2 && JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')).length === 1);

// D) 네트워크 회복 → flush 가 재전송하고 파일을 지운다
calls = 0;
globalThis.fetch = async () => { calls++; return okResp(); };
const res = await flushPending('123');
ok('flush 재전송 성공 1건', res.sent === 1 && res.kept === 0);
ok('전송 완료 → 대기 파일 삭제(=완료 플래그)', !fs.existsSync(PENDING_PATH));

// E) flush 중에도 실패하면 파일을 남긴다(tries 증가)
globalThis.fetch = async () => { throw netErr(); };
await sendMessage('123', 'card2', { retries: 0 }).catch(() => {});
stashPending({ text: 'card2', rows: [] });
const res2 = await flushPending('123');
ok('flush 실패분은 보존', res2.sent === 0 && res2.kept === 1);
const kept = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
ok('실패 시 tries 증가', kept[0].tries === 1);

// 정리
fs.rmSync(PENDING_PATH, { force: true });
ok('정리 완료 — 대기 파일 없음', !fs.existsSync(PENDING_PATH));

console.log(`\n${fail === 0 ? '🎉 전부 통과' : '⚠️ 실패 있음'} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
