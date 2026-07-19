// 사이트맵을 '발행 URL의 정본'으로 읽는다. 외부 의존성 없음.
//
// 왜 필요한가 (2026-07-19 사고):
//   발행 URL 을 폴더명으로 추측했더니 틀렸다. Astro 는 새 글의 슬러그를 소문자로
//   변환해 서빙하는데(이관글은 originalPath 를 그대로 씀), 추측 코드는 폴더명의
//   대문자를 그대로 썼다. 결과적으로 404 주소를 GSC 에 검사시켜
//   "Google 이 모르는 URL" 이라는 거짓 미색인 판정이 났다(최소 2편 오진).
//
//   추측을 없애는 게 유일한 근본 해결이다. 사이트맵은 매 배포마다 Astro 가
//   실제 서빙 주소로 생성하므로, 그걸 정본으로 삼으면 대소문자·인코딩 차이가
//   원리적으로 발생하지 않는다.
const DEFAULT_ORIGIN = 'https://allexishere.com';

// 비교용 정규화 키 — 디코드 + 소문자 + 끝슬래시 제거.
// URL 을 '만들' 때는 절대 쓰지 않는다. 오직 로컬 글 ↔ 사이트맵 URL 을 이어붙일 때만.
export function urlKey(u) {
  let s = String(u || '');
  s = s.replace(/^https?:\/\/[^/]+/, '');   // pathname 만
  s = s.split('#')[0].split('?')[0];
  try { s = decodeURIComponent(s); } catch { /* 깨진 인코딩은 원문 유지 */ }
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s.toLowerCase();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`사이트맵 요청 실패(HTTP ${res.status}): ${url}`);
  return res.text();
}
const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

// 사이트맵 인덱스를 따라가 모든 URL 을 모은다.
// 반환: { urls: string[], byKey: Map<key, url> }
let _cache = null; // { ts, data } — 한 프로세스 안에서 재사용(10분)
export async function fetchSitemapUrls(origin = DEFAULT_ORIGIN, { maxAgeMs = 600_000 } = {}) {
  if (_cache && Date.now() - _cache.ts < maxAgeMs) return _cache.data;

  const indexUrl = `${origin}/sitemap-index.xml`;
  const xml = await fetchText(indexUrl);
  let urls = [];
  const children = locsOf(xml).filter((u) => /sitemap[-\w]*\.xml$/i.test(u));
  if (children.length) {
    for (const c of children) urls.push(...locsOf(await fetchText(c)));
  } else {
    urls = locsOf(xml); // 인덱스가 아니라 단일 사이트맵인 경우
  }

  const byKey = new Map();
  const collisions = [];
  for (const u of urls) {
    const k = urlKey(u);
    // 소문자화로 서로 다른 URL 이 같은 키가 되면 매칭이 틀어진다 — 조용히 넘기지 않는다.
    if (byKey.has(k) && byKey.get(k) !== u) collisions.push([byKey.get(k), u]);
    byKey.set(k, u);
  }
  if (collisions.length) {
    console.error(`[sitemap] ⚠️ 정규화 키 충돌 ${collisions.length}건 — 매칭이 어긋날 수 있습니다`);
    for (const [a, b] of collisions.slice(0, 3)) console.error(`  ${a}\n  ${b}`);
  }

  const data = { urls, byKey, collisions };
  _cache = { ts: Date.now(), data };
  return data;
}

// 로컬 글의 pathname 을 사이트맵의 실제 URL 로 해석한다.
// 못 찾으면 null — 그건 '사이트맵에 없는 글'이라는 진짜 신호다(추측으로 메우지 않는다).
export function resolveUrl(byKey, pathname) {
  return byKey.get(urlKey(pathname)) || null;
}
