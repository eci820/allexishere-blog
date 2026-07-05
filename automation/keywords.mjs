// 키워드 수집 — 스위치식(trend:5 / trend:3+evergreen:2 / evergreen:5).
// 기본: signal.bz 실시간 검색어 → (실패)구글 트렌드 KR → (실패)에버그린.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/env.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');

// 가십/연예성 신호(정보형 우선을 위해 후순위로 밀 때 사용)
const GOSSIP =
  /열애|결혼|이혼|사망|별세|부고|불륜|폭행|음주운전|마약|성추행|성폭행|논란|저격|디스|하차|복귀|임신|출산|열애설|파경|고백|폭로|사과|입장문|재판|구속|피소|고소/;

function existingTitles() {
  const set = [];
  if (!fs.existsSync(BLOG)) return set;
  for (const d of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, d, 'index.md');
    if (fs.existsSync(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/^title:\s*"?(.*?)"?\s*$/m);
      if (m) set.push(m[1]);
    }
  }
  return set;
}

async function fetchSignalBz() {
  const res = await fetch('https://api.signal.bz/news/realtime', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('signal.bz HTTP ' + res.status);
  const data = await res.json();
  const kws = (data.top10 || []).map((x) => x.keyword).filter(Boolean);
  if (!kws.length) throw new Error('signal.bz 파싱 결과 없음');
  return kws;
}

async function fetchGoogleTrendsKR() {
  const res = await fetch('https://trends.google.com/trending/rss?geo=KR');
  if (!res.ok) throw new Error('google-trends HTTP ' + res.status);
  const xml = await res.text();
  const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
    .map((m) => m[1].trim())
    .filter((t) => t && t !== 'Daily Search Trends');
  // 영문 중복(예: 한글 다음 줄의 romanization) 제거
  const kws = titles.filter((t) => /[가-힣]/.test(t));
  if (!kws.length) throw new Error('google-trends 파싱 결과 없음');
  return kws;
}

export async function collectTrend() {
  const errs = [];
  for (const [name, fn] of [
    ['signal.bz', fetchSignalBz],
    ['google-trends-KR', fetchGoogleTrendsKR],
  ]) {
    try {
      const kws = await fn();
      return { keywords: kws, source: name };
    } catch (e) {
      errs.push(`${name}: ${e.message}`);
    }
  }
  throw new Error('실시간 트렌드 수집 실패 — ' + errs.join(' | '));
}

// 에버그린 시드(주차3:세금1:건강1 재사용). 기존 글과 겹치면 건너뜀.
// 검색량이 실제로 잡히도록 '검색어 형태'(짧은 실검형)로. 생성 시드로도 충분.
const EVERGREEN = {
  parking: ['공영주차장 요금', '무료 주차장 찾기', '주차위반 과태료', '거주자 우선주차', '대형마트 주차'],
  tax: ['연말정산 환급', '자동차세 연납', '재산세 조회', '종합소득세 신고', '근로장려금 신청'],
  health: ['건강검진 항목', '독감 예방접종', '비타민D 권장량', '고혈압 식단', '수면의 질'],
};

function pickEvergreen(count, mix, exclude) {
  const out = [];
  const cats = Object.entries(mix); // [['parking',3],...]
  let i = 0;
  while (out.length < count && i < 50) {
    for (const [cat, weight] of cats) {
      const pool = (EVERGREEN[cat] || []).filter(
        (k) => !exclude.has(k) && !out.includes(k)
      );
      const take = Math.min(weight, pool.length);
      for (let j = 0; j < take && out.length < count; j++) {
        out.push(pool[(i + j) % pool.length]);
      }
    }
    i++;
  }
  return out.slice(0, count);
}

// config.source 스위치 → 최종 키워드 목록 + 메모(텔레그램 알림용)
export async function selectKeywords(config) {
  const spec = config.source || 'trend:5';
  const parts = { trend: 0, evergreen: 0 };
  for (const p of spec.split('+')) {
    const [k, v] = p.split(':');
    if (k && parts[k.trim()] !== undefined) parts[k.trim()] = parseInt(v) || 0;
  }
  const titles = existingTitles();
  const chosen = [];
  const seen = new Set();
  const notes = [];

  if (parts.trend > 0) {
    let trend = [];
    try {
      const t = await collectTrend();
      trend = t.keywords;
      notes.push(`실시간 소스: ${t.source} (${trend.length}개 수집)`);
    } catch (e) {
      notes.push('⚠️ ' + e.message + ' → 에버그린으로 대체');
      parts.evergreen += parts.trend;
      parts.trend = 0;
    }
    // 기존 글과 중복 배제
    trend = trend.filter((k) => {
      const dup = titles.some((t) => t.includes(k) || (k.length >= 4 && k.includes(t.slice(0, 5))));
      return !seen.has(k) && !dup;
    });
    // 정보형 우선(가십은 뒤로)
    trend.sort((a, b) => (GOSSIP.test(a) ? 1 : 0) - (GOSSIP.test(b) ? 1 : 0));
    for (const k of trend.slice(0, parts.trend)) {
      chosen.push({ keyword: k, source: 'trend', gossip: GOSSIP.test(k) });
      seen.add(k);
    }
  }

  if (parts.evergreen > 0) {
    const ev = pickEvergreen(parts.evergreen, config.evergreenMix || { parking: 3, tax: 1, health: 1 }, new Set(titles));
    for (const k of ev) {
      chosen.push({ keyword: k, source: 'evergreen', gossip: false });
      seen.add(k);
    }
  }

  return { keywords: chosen.slice(0, config.draftsPerRun || 5), notes };
}

// 브리핑용 후보 8~10개(실검+에버그린). 발행/기출(exclude) 제외, 가십 후순위.
export async function briefingCandidates(config, exclude = new Set()) {
  const titles = existingTitles();
  const isDup = (k) =>
    exclude.has(k) || titles.some((t) => t.includes(k) || (k.length >= 4 && k.includes(t.slice(0, 5))));
  const want = config.briefingCount || 9;
  const out = [];
  const seen = new Set();
  let source = null, note = '';
  try {
    const t = await collectTrend();
    source = t.source;
    let trend = t.keywords.filter((k) => !isDup(k) && !seen.has(k));
    trend.sort((a, b) => (GOSSIP.test(a) ? 1 : 0) - (GOSSIP.test(b) ? 1 : 0));
    for (const k of trend.slice(0, Math.min(6, want))) {
      out.push({ keyword: k, source: 'trend', gossip: GOSSIP.test(k) });
      seen.add(k);
    }
  } catch (e) {
    note = e.message;
  }
  const need = want - out.length;
  if (need > 0) {
    const ev = pickEvergreen(need, config.evergreenMix || { parking: 3, tax: 1, health: 1 }, new Set([...titles, ...exclude, ...seen]));
    for (const k of ev) {
      if (!seen.has(k) && !isDup(k)) {
        out.push({ keyword: k, source: 'evergreen', gossip: false });
        seen.add(k);
      }
    }
  }
  return { candidates: out.slice(0, want), source, note };
}
