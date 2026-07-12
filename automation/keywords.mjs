// 키워드 수집 — 스위치식(trend:5 / trend:3+evergreen:2 / evergreen:5).
// 기본: signal.bz 실시간 검색어 → (실패)구글 트렌드 KR → (실패)에버그린.
// v2.7: 브리핑은 계급 균형(🔥실검·🔬과학·💪건강·🌲에버그린 각 2)으로 후보를 뽑는다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/env.mjs';
import { INFO, RISK } from './lib/suitability.mjs';

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

// 에버그린 시드(주차·세금 등 생활정보). 기존 글과 겹치면 건너뜀.
// 검색량이 실제로 잡히도록 '검색어 형태'(짧은 실검형)로. 생성 시드로도 충분.
// health 풀은 v2.7에서 💪 계급(HEALTH_SEEDS)으로 분리 — 에버그린 tier에는 넣지 않음.
const EVERGREEN = {
  parking: ['공영주차장 요금', '무료 주차장 찾기', '주차위반 과태료', '거주자 우선주차', '대형마트 주차'],
  tax: ['연말정산 환급', '자동차세 연납', '재산세 조회', '종합소득세 신고', '근로장려금 신청'],
};

// 🔬 과학·생활원리 / 💪 건강·영양·헬스 시드풀은 축2에서 data/topics-pool.json 으로 이전됨
// (automation/lib/topicsPool.mjs 의 SEED_TOPICS). 브리핑은 재고에서 status·쿨다운·발행매칭으로 픽한다.
// 아래 EVERGREEN 은 batch 모드(selectKeywords) 하위호환용으로만 유지.

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
    const ev = pickEvergreen(parts.evergreen, config.evergreenMix || { parking: 3, tax: 2 }, new Set(titles));
    for (const k of ev) {
      chosen.push({ keyword: k, source: 'evergreen', gossip: false });
      seen.add(k);
    }
  }

  return { keywords: chosen.slice(0, config.draftsPerRun || 5), notes };
}

// 브리핑용 후보 — v2.7 계급 균형 + 축2 재고: 🔥실검(정보형만·라이브)·🔬과학·💪건강·🌲에버그린(재고).
// (📅캘린더는 briefing.mjs에서 별도로 앞에 붙는다.) 재고 픽은 3중 방어(status·30일 쿨다운·발행매칭) 적용.
export async function briefingCandidates(config, exclude = new Set()) {
  const counts = config.tierCounts || { trend: 2, science: 2, health: 2, evergreen: 2 };
  const out = [];
  let source = null, note = '';

  // 🔥 실검 — 라이브 수집, '정보형만'(가십·인물 신변·정치 완전 제외 후 정보형 우선).
  const titles = existingTitles();
  const isDup = (k) => exclude.has(k) || titles.some((t) => t.includes(k) || (k.length >= 4 && k.includes(t.slice(0, 5))));
  try {
    const t = await collectTrend();
    source = t.source;
    let trend = t.keywords.filter((k) => !isDup(k) && !GOSSIP.test(k) && !RISK.test(k));
    trend.sort((a, b) => (INFO.test(b) ? 1 : 0) - (INFO.test(a) ? 1 : 0));
    for (const k of trend.slice(0, counts.trend)) out.push({ keyword: k, source: 'trend', gossip: false });
  } catch (e) {
    note = e.message;
  }

  // 🔬·💪·🌲 — 주제 재고(topics-pool.json)에서 픽. pickForBrief가 markProposed·auto-published 처리.
  const { seedPoolIfEmpty, pickForBrief } = await import('./lib/topicsPool.mjs');
  const pool = seedPoolIfEmpty();
  for (const tier of ['science', 'health', 'evergreen']) {
    for (const p of pickForBrief(pool, tier, counts[tier], exclude)) {
      out.push({
        keyword: p.keyword, source: p.source, gossip: false, id: p.id,
        angle: p.source === 'science' ? p.series : undefined, // 별점·생성용(life/knowledge)
        poolAngle: p.angle, // 판단 각도(표시용)
      });
    }
  }

  return { candidates: out, source, note };
}
