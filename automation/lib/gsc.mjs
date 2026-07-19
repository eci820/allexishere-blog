// Google Search Console API — 서비스 계정 인증 + 성과 조회. 외부 의존성 없음.
//
// 왜 google-auth-library 를 안 쓰나: 필요한 건 JWT 하나 서명해 액세스 토큰으로
// 바꾸는 것뿐이고, Node 내장 crypto 로 충분하다. 라이브러리를 넣으면 패키지 30개가
// 딸려온다. 이 저장소의 telegram.mjs·indexnow.mjs 도 같은 이유로 무의존성이다.
//
// 🔴 키 파일(automation/secrets/gsc-key.json)은 절대 로그·에러 메시지에 싣지 않는다.
//    private_key 가 한 번이라도 로그에 남으면 그 키는 폐기해야 한다.
//
// ⚠️ GSC 데이터는 2~3일 지연된다(공식 문서). '어제' 조회는 대부분 빈 값이다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUTO_DIR } from './env.mjs';

const KEY_PATH = process.env.GSC_KEY_PATH || path.join(AUTO_DIR, 'secrets', 'gsc-key.json');
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://searchconsole.googleapis.com/webmasters/v3';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 키 로드. 실패 사유를 사람이 읽을 수 있게 바꾸되 키 내용은 노출하지 않는다.
export function loadKey(keyPath = KEY_PATH) {
  if (!fs.existsSync(keyPath)) {
    throw Object.assign(new Error(`GSC 키 파일이 없습니다: ${keyPath}`), { kind: 'nokey' });
  }
  let k;
  try {
    k = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    throw Object.assign(new Error('GSC 키 파일이 올바른 JSON 이 아닙니다'), { kind: 'badkey' });
  }
  for (const f of ['client_email', 'private_key', 'token_uri']) {
    if (!k[f]) throw Object.assign(new Error(`GSC 키에 ${f} 가 없습니다`), { kind: 'badkey' });
  }
  return k;
}

// 서비스 계정 JWT → 액세스 토큰. 토큰은 1시간짜리라 프로세스 내에서 캐시한다.
let _token = null; // { value, expiresAt }
export async function getAccessToken(keyPath = KEY_PATH) {
  if (_token && Date.now() < _token.expiresAt - 60_000) return _token.value;
  const key = loadKey(keyPath);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(key.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // data.error_description 에는 키가 실리지 않는다(구글이 사유만 보냄).
    throw Object.assign(
      new Error(`토큰 발급 실패(HTTP ${res.status}): ${data.error_description || data.error || '사유 미상'}`),
      { kind: 'auth' }
    );
  }
  _token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return _token.value;
}

async function call(url, init = {}, keyPath = KEY_PATH) {
  const token = await getAccessToken(keyPath);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const kind =
      res.status === 403 ? 'forbidden'   // 서비스 계정이 그 속성 사용자로 추가 안 됨 / API 미활성
      : res.status === 404 ? 'notfound'  // 속성 URL 형식이 틀림
      : res.status === 401 ? 'auth'
      : 'error';
    throw Object.assign(new Error(msg), { kind, status: res.status });
  }
  return data;
}

// 이 서비스 계정이 볼 수 있는 속성 목록 — 속성 URL 형식을 여기서 확정한다.
// (sc-domain:example.com 인지 https://example.com/ 인지는 추측하지 말고 이걸로 확인)
export async function listSites(keyPath = KEY_PATH) {
  const data = await call(`${API}/sites`, {}, keyPath);
  return (data.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
}

// 도메인에 해당하는 속성을 골라준다. 도메인 속성(sc-domain:)을 우선한다 —
// http/https·www 를 모두 합산해 주므로 추세 보기에 적합하다.
export async function resolveSiteUrl(domain, keyPath = KEY_PATH) {
  const sites = await listSites(keyPath);
  if (!sites.length) return { siteUrl: null, sites, reason: 'no-sites' };
  const bare = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const cand =
    sites.find((s) => s.siteUrl === `sc-domain:${bare}`) ||
    sites.find((s) => s.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') === bare) ||
    null;
  return { siteUrl: cand?.siteUrl || null, permission: cand?.permission, sites };
}

// 성과 조회. dimensions 예: [] (합계) | ['date'] | ['page'] | ['query']
export async function searchAnalytics(siteUrl, { startDate, endDate, dimensions = [], rowLimit = 1000 }, keyPath = KEY_PATH) {
  const url = `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const data = await call(url, {
    method: 'POST',
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }),
  }, keyPath);
  return data.rows || [];
}

// 기간 합계(노출·클릭·CTR·평균순위). dimensions 없이 부르면 1행이 온다.
export async function totals(siteUrl, startDate, endDate, keyPath = KEY_PATH) {
  const rows = await searchAnalytics(siteUrl, { startDate, endDate, dimensions: [] }, keyPath);
  const r = rows[0];
  if (!r) return { impressions: 0, clicks: 0, ctr: 0, position: null, empty: true };
  return { impressions: r.impressions || 0, clicks: r.clicks || 0, ctr: r.ctr || 0, position: r.position ?? null, empty: false };
}

// ── 사이트맵 상태 ─────────────────────────────────────────────────────
// ⚠️ contents[].indexed 는 항상 "0" 이다(구글이 폐기한 필드). 색인 수로 쓰면 안 된다.
//    쓸 수 있는 건 submitted(제출 URL 수)·errors·warnings·lastDownloaded 다.
export async function sitemaps(siteUrl, keyPath = KEY_PATH) {
  const data = await call(`${API}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {}, keyPath);
  return (data.sitemap || []).map((s) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted || null,
    lastDownloaded: s.lastDownloaded || null,
    errors: Number(s.errors || 0),
    warnings: Number(s.warnings || 0),
    isPending: !!s.isPending,
    submitted: Number(s.contents?.[0]?.submitted || 0),
  }));
}

// ── URL 색인 상태 검사 ────────────────────────────────────────────────
// 색인 커버리지 리포트는 API 가 없다. 페이지별 상태를 알려면 이 API 뿐이다.
// 할당량: 사이트당 하루 2,000회 / 분당 600회. 발행글 150편이면 주 1회 전수 검사가 넉넉히 들어간다.
//
// 🔴 inspectionUrl 은 GSC 가 아는 주소와 정확히 같아야 한다. 폴더명으로 조립하면
//    이관글(originalPath 가 다름)은 "알려지지 않은 URL"로 나온다 — 실제로 겪었다.
const INSPECT_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
export async function inspectUrl(siteUrl, inspectionUrl, keyPath = KEY_PATH) {
  const data = await call(INSPECT_API, {
    method: 'POST',
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: 'ko' }),
  }, keyPath);
  const r = data.inspectionResult?.indexStatusResult || {};
  return {
    url: inspectionUrl,
    verdict: r.verdict || 'UNKNOWN',            // PASS | NEUTRAL | FAIL
    coverageState: r.coverageState || '',        // "제출되고 색인이 생성되었습니다." 등
    robotsTxtState: r.robotsTxtState || '',
    indexingState: r.indexingState || '',
    pageFetchState: r.pageFetchState || '',
    lastCrawlTime: r.lastCrawlTime || null,
    googleCanonical: r.googleCanonical || '',
    userCanonical: r.userCanonical || '',
  };
}

// 여러 URL 을 순차·소량 병렬로 검사. 분당 600회 한도를 넉넉히 밑돌게 조절한다.
// 실측: 1건당 응답이 수 초~수십 초로 느리다(144편 · 동시 4 → 17분).
// 분당 600회 한도이므로 동시 8은 여유롭다(초당 8건 ≪ 초당 10건).
export async function inspectMany(siteUrl, urls, { concurrency = 8, onProgress } = {}, keyPath = KEY_PATH) {
  const out = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((u) =>
      inspectUrl(siteUrl, u, keyPath).catch((e) => ({ url: u, verdict: 'ERROR', error: e.message }))
    ));
    out.push(...res);
    if (onProgress) onProgress(out.length, urls.length);
    await new Promise((r) => setTimeout(r, 250)); // 분당 한도 여유
  }
  return out;
}

// KST 기준 날짜 문자열(YYYY-MM-DD). GSC 는 속성 시간대 기준이라 대략치로 충분하다.
export function kstDaysAgo(n) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - n * 86400_000);
  return d.toISOString().slice(0, 10);
}
