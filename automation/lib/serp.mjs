// 🔎 상위 노출 글 분석 — "검색 상단에 나오는 글을 참고해 우리 글에 반영" (2026-11-26 사용자 지시).
//
// 무엇을: 쓰기 전에 그 검색어의 상위 문서를 읽고
//   ① 상위 글들이 공통으로 답하는 질문(= 검색 의도의 최소 요건)
//   ② 공통 구조(소제목 흐름·표 유무·분량)
//   ③ 공식 출처로 확인되는 핵심 사실(출처 URL 포함)
//   ④ 상위 글들이 놓친 것(= 우리 글의 정보 이득)
//  을 뽑아 작성 프롬프트와 검증 단계에 넘긴다.
//
// 🔴 문장·표현은 가져오지 않는다. 구조와 '다뤄야 할 질문', 출처 있는 사실만 — 복제는 저품질·저작권 문제다.
//
// ⚠️ 정직한 한계: 구글 순위를 그대로 가져오는 공식 API 는 없다(유료 SERP API 미사용).
//    · 네이버: 공식 검색 API(웹문서·블로그) 상위 결과 — 정확한 네이버 노출 순서.
//    · 구글: claude 의 WebSearch 상위 결과로 근사한다. 구글 실제 순위와 다를 수 있다.
//    리포트·주석에 이 차이를 숨기지 않는다(계약 §6).

import { claudeText } from './harness.mjs';

async function naverSearch(kind, query, display = 5) {
  if (!process.env.NAVER_OPENAPI_CLIENT_ID) return [];
  try {
    const res = await fetch(`https://openapi.naver.com/v1/search/${kind}.json?query=${encodeURIComponent(query)}&display=${display}`, {
      headers: { 'X-Naver-Client-Id': process.env.NAVER_OPENAPI_CLIENT_ID, 'X-Naver-Client-Secret': process.env.NAVER_OPENAPI_CLIENT_SECRET },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return ((await res.json()).items || []).map((it) => ({ title: strip(it.title), link: it.link, desc: strip(it.description).slice(0, 160) }));
  } catch (e) {
    console.error('[serp-naver]', e.message);
    return [];
  }
}

const PROMPT = (keyword, naver) => `검색어 "${keyword}"로 지금 검색 상위에 노출되는 글들을 분석하세요. 우리 블로그가 이 검색어로 쓸 글의 '설계도'를 만드는 일입니다.

1) WebSearch 로 "${keyword}"를 검색하고, 상위 결과 중 실제 정보 글 3~5개를 WebFetch 로 열어 읽으세요.
   아래 네이버 상위 문서도 참고 대상입니다(필요하면 WebFetch):
${naver.map((n, i) => `   ${i + 1}. ${n.title} — ${n.link}`).join('\n') || '   (네이버 결과 없음)'}
2) 다음을 뽑으세요. 🔴 문장·표현은 절대 옮기지 말고 구조와 정보만:
   - mustCover: 상위 글 대부분이 답하는 질문(검색 의도의 최소 요건) 3~7개
   - structure: 상위 글들의 공통 흐름(소제목 순서·표 유무) 한 줄
   - typicalLength: 상위 글 본문 분량 대략(자)
   - facts: 공식 기관·운영처·제조사 문서로 확인되는 핵심 사실 3~8개(값·기준 연월·출처 URL). 블로그·카페만 출처인 수치는 넣지 마세요.
   - gaps: 상위 글들이 공통으로 빠뜨렸거나 틀리게 쓴 것 2~5개(우리 글의 정보 이득 후보)
   - titlePatterns: 상위 글 제목들이 공통으로 쓰는 검색 표현 3~5개(제목 문장 그대로가 아니라 표현 단위)

아래 JSON 하나만 출력(코드펜스·설명 금지):
{"mustCover":["..."],"structure":"...","typicalLength":2500,"facts":[{"fact":"...","asOf":"2026-11","source":"https://..."}],"gaps":["..."],"titlePatterns":["..."],"sourcesRead":["https://..."]}`;

// return { brief, costUsd } | { brief:null, error }
export async function serpBrief(keyword, config) {
  const naver = [...(await naverSearch('webkr', keyword, 5)), ...(await naverSearch('blog', keyword, 3))].slice(0, 7);
  try {
    const r = await claudeText(PROMPT(keyword, naver), {
      model: config.cliModel,
      timeoutSec: (config.serp && config.serp.timeoutSeconds) || 360,
      tools: ['WebSearch', 'WebFetch'],
    });
    const t = String(r.result).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const arr = (x, n) => (Array.isArray(x) ? x : []).slice(0, n);
    const brief = {
      keyword,
      mustCover: arr(o.mustCover, 7).map(String),
      structure: String(o.structure || '').slice(0, 200),
      typicalLength: Number(o.typicalLength) || null,
      // 출처 URL 없는 사실은 버린다 — 확인 근거가 없으면 작성자에게 넘기지 않는다(§4).
      facts: arr(o.facts, 8).filter((f) => f && /^https?:\/\//.test(String(f.source || ''))),
      gaps: arr(o.gaps, 5).map(String),
      titlePatterns: arr(o.titlePatterns, 5).map(String),
      sourcesRead: arr(o.sourcesRead, 8).map(String),
      naverTop: naver.map((n) => n.title).slice(0, 5),
    };
    return { brief, costUsd: r.costUsd };
  } catch (e) {
    return { brief: null, error: `${e.kind || 'error'}: ${String(e.message).slice(0, 120)}`, costUsd: 0 };
  }
}

// 작성 프롬프트에 붙일 블록.
export function serpForPrompt(b) {
  if (!b) return '';
  return `\n\n[상위 노출 글 분석 — 참고용. 🔴 문장 복제 금지, 구조·질문·사실만 참고]
- 이 검색어의 상위 글들이 공통으로 답하는 질문(반드시 다룰 것): ${b.mustCover.join(' / ') || '(없음)'}
- 상위 글 공통 흐름: ${b.structure || '-'} · 분량 약 ${b.typicalLength || '?'}자 → 우리 글은 이보다 짧아도 되지만 위 질문은 빠짐없이 답할 것
- 공식 출처로 확인된 사실(쓸 때 출처·기준 연월을 함께): ${b.facts.map((f) => `${f.fact}(${f.asOf || '기준일 확인'}, ${f.source})`).join(' / ') || '(없음 — 직접 확인)'}
- 상위 글들이 놓친 것(우리 글의 차별점으로 반드시 1개 이상 채울 것): ${b.gaps.join(' / ') || '(없음)'}
- 상위 글 제목에 공통으로 쓰이는 검색 표현(제목·소제목에 자연스럽게): ${b.titlePatterns.join(', ') || '-'}`;
}
