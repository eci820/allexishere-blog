// IndexNow 통보 — 발행/갱신 시 URL을 검색엔진(Bing·Naver·Yandex·Seznam 등)에 브로드캐스트.
//  · 키는 환경변수 INDEXNOW_KEY 에서만 읽음(소스 하드코딩 금지). 미설정이면 우아하게 no-op.
//  · push 직후 setTimeout(90초) 후 1회 POST — Cloudflare 배포(보통 1~3분) 완료를 대부분 커버. await 하지 않음.
//  · 실패는 삼키고 로그만 — 발행 흐름을 절대 막지 않는다.
//  · 요청 URL·응답코드를 console + state/indexnow-log.jsonl 에 기록(사후 "정말 쏘고 있나" 확인·집계용).
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR } from './env.mjs';

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const HOST = 'allexishere.com';
const DELAY_MS = 90_000; // push 후 배포 완료 대기(즉시 통보 시 신규 URL 404 레이스 완화)
const LOG = path.join(AUTO_DIR, 'state', 'indexnow-log.jsonl');

// 집계용 로그 1줄 적재(텔레그램 데일리 리포트가 나중에 성공/실패 카운트에 사용).
function record(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* 로그 실패는 무시 */ }
}

async function post(payloadUrls, key, tag) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: HOST,
        key,
        keyLocation: `https://${HOST}/${key}.txt`,
        urlList: payloadUrls,
      }),
    });
    const first = payloadUrls[0] + (payloadUrls.length > 1 ? ` 외 ${payloadUrls.length - 1}건` : '');
    console.log(`[indexnow] ${res.status} ${tag} ${first}`); // 요구[5]: 요청 URL + 응답코드 기록
    record({ tag, count: payloadUrls.length, url: payloadUrls[0], status: res.status, ok: res.ok });
    return res.status;
  } catch (e) {
    console.error(`[indexnow] 실패(무시) ${tag}: ${e.message}`);
    record({ tag, count: payloadUrls.length, url: payloadUrls[0], ok: false, error: e.message });
  }
}

// 발행/갱신 지점에서 호출(fire-and-forget). 90초 지연 후 1회 POST. ⚠️ await 하지 말 것.
export function submitIndexNow(url) {
  const key = process.env.INDEXNOW_KEY;
  if (!key) { console.log(`[indexnow] skip(INDEXNOW_KEY 미설정): ${url}`); record({ tag: 'single', url, skipped: 'no-key' }); return; }
  if (!url) return;
  setTimeout(() => { post([url], key, 'single'); }, DELAY_MS);
}

// 일괄/테스트 제출(즉시 POST, 지연 없음). 스크립트·검증에서 사용. 반환: HTTP status(또는 undefined).
export async function submitIndexNowBatch(urls, key = process.env.INDEXNOW_KEY) {
  if (!key) { console.error('[indexnow] batch skip: INDEXNOW_KEY 미설정'); return; }
  if (!urls || !urls.length) return;
  return post(urls, key, 'batch');
}
