// 네이버 지표: 검색광고 API(월간검색수) + 오픈API(블로그 문서수). 24h 캐시, 우아한 저하.
// 키는 process.env 에서만 읽고 로그·반환에 노출하지 않음.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_DIR } from './env.mjs';

const CACHE = path.join(AUTO_DIR, 'state', 'naver-cache.json');
const DAY = 24 * 3600 * 1000;

const loadCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } };
const saveCache = (c) => { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); };
const norm = (k) => k.replace(/\s+/g, '').toUpperCase();

// "< 10" 문자열/숫자 파싱
function parseQc(v) {
  if (typeof v === 'number') return { n: v, lt: false };
  const s = String(v);
  if (s.includes('<')) return { n: 5, lt: true }; // 10 미만 → 정렬용 근사값
  return { n: parseInt(s.replace(/[^0-9]/g, '')) || 0, lt: false };
}

// ── 검색광고 API: /keywordstool (HMAC-SHA256 서명) ──
function adHeaders(method, uriPath) {
  const ts = String(Date.now());
  const sig = crypto
    .createHmac('sha256', process.env.NAVER_AD_SECRET_KEY)
    .update(`${ts}.${method}.${uriPath}`) // 쿼리스트링 제외, 경로만 서명
    .digest('base64');
  return {
    'X-Timestamp': ts,
    'X-API-KEY': process.env.NAVER_AD_API_KEY,
    'X-Customer': String(process.env.NAVER_AD_CUSTOMER_ID),
    'X-Signature': sig,
  };
}

// 최대 5개씩 묶어 호출. 반환: Map(정규화키 → {vol, pcLt, moLt})
async function fetchVolumes(keywords) {
  const out = new Map();
  if (!process.env.NAVER_AD_API_KEY) return out;
  const uriPath = '/keywordstool';
  for (let i = 0; i < keywords.length; i += 5) {
    const batch = keywords.slice(i, i + 5);
    const qs = new URLSearchParams({ hintKeywords: batch.map((k) => k.replace(/\s+/g, '')).join(','), showDetail: '1' });
    try {
      const res = await fetch(`https://api.naver.com${uriPath}?${qs}`, { headers: adHeaders('GET', uriPath) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      for (const row of data.keywordList || []) {
        const pc = parseQc(row.monthlyPcQcCnt), mo = parseQc(row.monthlyMobileQcCnt);
        out.set(norm(row.relKeyword), { vol: pc.n + mo.n, pcLt: pc.lt, moLt: mo.lt });
      }
    } catch (e) {
      console.error('[naver-ad]', e.message); // 우아한 저하: 이 배치 검색량 생략
    }
  }
  return out;
}

// ── 오픈API: 블로그 문서수 ──
async function fetchDocCount(keyword) {
  if (!process.env.NAVER_OPENAPI_CLIENT_ID) return null;
  try {
    const res = await fetch(`https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=1`, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_OPENAPI_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_OPENAPI_CLIENT_SECRET,
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return (await res.json()).total;
  } catch (e) {
    console.error('[naver-open]', e.message);
    return null; // 우아한 저하
  }
}

// 키워드 배열 → { keyword: {vol, volLt, doc, ratio} }. 24h 캐시.
export async function enrichKeywords(keywords) {
  const cache = loadCache();
  const now = Date.now();
  const need = keywords.filter((k) => !cache[k] || now - cache[k].ts > DAY);

  if (need.length) {
    const volMap = await fetchVolumes(need);
    for (const k of need) {
      const v = volMap.get(norm(k));
      const doc = await fetchDocCount(k);
      cache[k] = {
        ts: now,
        vol: v ? v.vol : null,
        volLt: v ? v.pcLt && v.moLt : false,
        doc,
      };
    }
    saveCache(cache);
  }

  const result = {};
  for (const k of keywords) {
    const c = cache[k] || {};
    const ratio = c.vol != null && c.doc != null && c.doc > 0 ? +(c.vol / c.doc).toFixed(3) : null;
    result[k] = { vol: c.vol ?? null, volLt: !!c.volLt, doc: c.doc ?? null, ratio };
  }
  return result;
}

// 텔레그램 표기용 한 줄(부재 수치는 생략)
export function statLine(s) {
  if (!s) return '';
  const parts = [];
  if (s.vol != null) parts.push(`검색 ${s.volLt ? '<10' : s.vol.toLocaleString('en-US')}`);
  if (s.doc != null) parts.push(`문서 ${s.doc.toLocaleString('en-US')}`);
  if (s.ratio != null) parts.push(`비율 ${s.ratio}`);
  return parts.length ? '📊 ' + parts.join(' · ') : '';
}
