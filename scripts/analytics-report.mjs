#!/usr/bin/env node
// Cloudflare Web Analytics(RUM) → 텔레그램 일일 리포트.
// CI(GitHub Actions)에서 실행: 시크릿은 process.env로만 읽는다(automation/.env 미사용).
// 실행: node scripts/analytics-report.mjs [--dry-run]
// 의존성 없음(내장 fetch/fs/path만).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const HISTORY_PATH = join(REPO_ROOT, 'data', 'analytics-history.json');
const CF_API = 'https://api.cloudflare.com/client/v4';
const DRY_RUN = process.argv.includes('--dry-run');

// ── env ─────────────────────────────────────────────
const CF_TOKEN = process.env.CF_ANALYTICS_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.ANALYTICS_CHAT_ID || '5970810811';
const DOMAIN = process.env.ANALYTICS_DOMAIN || 'hrinsight4u.com';
let ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
let SITE_TAG = process.env.CF_SITE_TAG || '';

function requireEnv(name, val) {
  if (!val) throw new Error(`환경변수 ${name} 누락 — 설정 후 다시 실행`);
}

// ── util ────────────────────────────────────────────
const log = (...a) => console.log('[analytics]', ...a);
const num = (n) => Number(n || 0).toLocaleString('en-US');

// KST(UTC+9) 어제 날짜와 UTC 조회창을 계산.
// KST 00:00~다음날 00:00 == UTC (date-1)15:00Z ~ (date)15:00Z.
function kstYesterdayWindow() {
  const now = Date.now();
  const kstNow = new Date(now + 9 * 3600 * 1000); // UTC기준 시각에 +9h
  // KST '오늘'의 자정(=KST 00:00)을 UTC로: kstNow의 Y/M/D 사용
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  // KST 어제 00:00 = KST 오늘 00:00 - 24h. KST자정의 UTC = 그 KST벽시각 - 9h.
  const kstTodayMidnightUTC = Date.UTC(y, m, d, 0, 0, 0) - 9 * 3600 * 1000;
  const startUTC = new Date(kstTodayMidnightUTC - 24 * 3600 * 1000); // 어제 KST 00:00
  const endUTC = new Date(kstTodayMidnightUTC); // 오늘 KST 00:00
  // 표시용 KST 어제 날짜(YYYY-MM-DD): startUTC + 9h 의 날짜
  const kstYd = new Date(startUTC.getTime() + 9 * 3600 * 1000);
  const dateStr = `${kstYd.getUTCFullYear()}-${String(kstYd.getUTCMonth() + 1).padStart(2, '0')}-${String(kstYd.getUTCDate()).padStart(2, '0')}`;
  return {
    dateStr,
    geq: startUTC.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    leq: endUTC.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

// ── Cloudflare REST(자동 발견) ──────────────────────
async function cfGet(path) {
  const res = await fetch(`${CF_API}${path}`, {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`CF GET ${path} 실패: ${msg}`);
  }
  return data.result;
}

async function discoverAccountId() {
  if (ACCOUNT_ID) return ACCOUNT_ID;
  const accounts = await cfGet('/accounts');
  if (!accounts?.length) throw new Error('접근 가능한 Cloudflare 계정이 없음');
  if (accounts.length > 1) {
    log('여러 계정 발견:', accounts.map((a) => `${a.name}(${a.id})`).join(', '));
  }
  ACCOUNT_ID = accounts[0].id;
  log(`계정 선택: ${accounts[0].name} (${ACCOUNT_ID})`);
  return ACCOUNT_ID;
}

async function discoverSiteTag() {
  if (SITE_TAG) return SITE_TAG;
  const sites = await cfGet(`/accounts/${ACCOUNT_ID}/rum/site_info/list`);
  const list = Array.isArray(sites) ? sites : [];
  const match = list.find((s) => (s.host || s.ruleset?.zone_name) === DOMAIN);
  if (!match) {
    const hosts = list.map((s) => s.host || s.ruleset?.zone_name || '?').join(', ');
    throw new Error(`Web Analytics 사이트 중 ${DOMAIN} 없음. 사용 가능 host: ${hosts || '(없음)'}`);
  }
  SITE_TAG = match.site_tag;
  log(`사이트 태그: ${SITE_TAG} (host=${DOMAIN})`);
  return SITE_TAG;
}

// ── GraphQL 조회 ────────────────────────────────────
const GQL = `
query ($accountTag: string!, $siteTag: string!, $geq: string!, $leq: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $geq, datetime_leq: $leq }
        limit: 1
      ) {
        count
        sum { visits }
      }
      pages: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $geq, datetime_leq: $leq }
        limit: 5
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestPath }
      }
      referers: rumPageloadEventsAdaptiveGroups(
        filter: { siteTag: $siteTag, datetime_geq: $geq, datetime_leq: $leq }
        limit: 8
        orderBy: [count_DESC]
      ) {
        count
        dimensions { refererHost }
      }
    }
  }
}`;

async function queryAnalytics(win) {
  const res = await fetch(`${CF_API}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: GQL,
      variables: { accountTag: ACCOUNT_ID, siteTag: SITE_TAG, geq: win.geq, leq: win.leq },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.errors?.length) {
    throw new Error(`GraphQL 오류: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const acc = data?.data?.viewer?.accounts?.[0] || {};
  const pageviews = acc.total?.[0]?.count || 0;
  const visitors = acc.total?.[0]?.sum?.visits || 0;
  const pages = (acc.pages || [])
    .map((g) => ({ path: g.dimensions?.requestPath || '/', count: g.count || 0 }))
    .filter((p) => p.count > 0)
    .slice(0, 5);
  const referers = (acc.referers || [])
    .map((g) => ({ host: g.dimensions?.refererHost || '', count: g.count || 0 }))
    .filter((r) => r.host && r.host !== DOMAIN) // 빈 값·자기 호스트 제외
    .slice(0, 5);
  return { pageviews, visitors, pages, referers };
}

// ── 누적 영속화 ─────────────────────────────────────
function loadHistory() {
  if (!existsSync(HISTORY_PATH)) {
    return {
      _note:
        '일별 Cloudflare Web Analytics 적재. GitHub Action이 매일 갱신·커밋(영속화). date 키는 KST 어제.',
      days: {},
      updatedAt: null,
    };
  }
  try {
    const h = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
    if (!h.days) h.days = {};
    return h;
  } catch {
    log('history 파싱 실패 — 새로 시작');
    return { _note: '일별 Cloudflare Web Analytics 적재.', days: {}, updatedAt: null };
  }
}

function upsertHistory(history, dateStr, stats) {
  // 멱등: 같은 날짜 재실행 시 덮어씀(중복 합산 방지)
  history.days[dateStr] = { visitors: stats.visitors, pageviews: stats.pageviews };
  history.updatedAt = new Date().toISOString();
  const cum = Object.values(history.days).reduce(
    (a, d) => ({
      visitors: a.visitors + (d.visitors || 0),
      pageviews: a.pageviews + (d.pageviews || 0),
    }),
    { visitors: 0, pageviews: 0 }
  );
  return cum;
}

function writeHistory(history) {
  const dir = dirname(HISTORY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 1) + '\n', 'utf8');
}

// ── 메시지 구성 ─────────────────────────────────────
function composeMessage(dateStr, stats, cum) {
  const popular = stats.pages.length
    ? stats.pages.map((p) => `${p.path} (${p.count})`).join(', ')
    : '—';
  const inflow = stats.referers.length
    ? stats.referers.map((r) => `${r.host} (${r.count})`).join(', ')
    : '직접·앱 유입';
  return (
    `📈 ${DOMAIN} | 어제(${dateStr})\n` +
    `방문자 ${num(stats.visitors)} (누적 ${num(cum.visitors)}) · 페이지뷰 ${num(stats.pageviews)} (누적 ${num(cum.pageviews)})\n` +
    `인기: ${popular}\n` +
    `유입: ${inflow}`
  );
}

// ── 텔레그램 전송(자립형) ───────────────────────────
async function tgSend(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram 전송 실패: ${data.description || res.status}`);
  return data.result;
}

// ── main ────────────────────────────────────────────
async function main() {
  requireEnv('CF_ANALYTICS_TOKEN', CF_TOKEN);
  requireEnv('TELEGRAM_BOT_TOKEN', TG_TOKEN);

  const win = kstYesterdayWindow();
  log(`대상일(KST): ${win.dateStr} | UTC창: ${win.geq} ~ ${win.leq}`);

  await discoverAccountId();
  await discoverSiteTag();

  const stats = await queryAnalytics(win);
  log(`조회결과: 방문자=${stats.visitors} 페이지뷰=${stats.pageviews} 인기=${stats.pages.length} 유입=${stats.referers.length}`);

  const history = loadHistory();
  const cum = upsertHistory(history, win.dateStr, stats);
  const message = composeMessage(win.dateStr, stats, cum);

  if (DRY_RUN) {
    log('--dry-run: 전송 생략. 구성된 메시지 ↓\n' + message);
    log('누적:', JSON.stringify(cum));
    log('history(미기록, dry-run):\n' + JSON.stringify(history, null, 1));
    return;
  }

  writeHistory(history);
  log(`history 기록: ${HISTORY_PATH}`);
  await tgSend(message);
  log(`텔레그램 전송 완료 → chat ${CHAT_ID}`);
}

main().catch(async (err) => {
  console.error('[analytics] 실패:', err.message);
  // 실패해도 짧은 알림은 시도(토큰이 있으면)
  if (TG_TOKEN && !DRY_RUN) {
    try {
      await tgSend(`⚠️ ${DOMAIN} 리포트 실패: ${err.message}`);
    } catch (e2) {
      console.error('[analytics] 실패 알림도 실패:', e2.message);
    }
  }
  process.exit(1);
});
