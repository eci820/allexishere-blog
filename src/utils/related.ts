import type { CollectionEntry } from 'astro:content';

// '함께 읽으면 좋은 글' 추천을 계산합니다.
// 목표: 태그가 없는 이관 글(91편)까지 후보에 포함시켜 '잠자는 글'로 순환을 유도하는 것.
// → 태그만으로는 이관 글이 안 떠서, 제목·설명의 '키워드 겹침'을 함께 점수화합니다.

// 제목에 흔히 붙어 뜻이 옅은 일반어(겹쳐도 관련도 신호가 약함) — 매칭에서 제외.
const STOPWORDS = new Set([
  '총정리', '정리', '방법', '이유', '원인', '전망', '가이드', '기준', '절차',
  '오늘', '최신', '공개', '총', '및', '관련', '주요', '핵심', '무엇', '어떻게',
  '위한', '대한', '있는', '하는', '되는', '그리고', '하지만', '이란', '입니다',
]);

// 토큰 끝에 붙는 대표적인 한글 조사 — 떼어내면 '수면의'와 '수면'이 매칭됨.
const PARTICLES = [
  '으로써', '으로', '에서', '에게', '까지', '부터', '이라', '라는', '으론',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '나',
];

function stripParticle(token: string): string {
  for (const p of PARTICLES) {
    if (token.length > p.length + 1 && token.endsWith(p)) {
      return token.slice(0, -p.length);
    }
  }
  return token;
}

// 문자열을 매칭용 토큰 집합으로. 공백·문장부호로 자르고, 조사 제거 후 2글자 이상만.
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const raw = text
    .toLowerCase()
    .split(/[\s,.·・…"'"'`~!?()[\]{}<>:;/\\|@#$%^&*+=\-–—]+/);
  for (const r of raw) {
    if (!r) continue;
    const t = stripParticle(r);
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function intersectionCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

interface Scored {
  post: CollectionEntry<'blog'>;
  score: number;
}

/**
 * 현재 글과 관련도가 높은 글을 최대 limit개 돌려줍니다.
 * 점수 = 공유 태그×3 + 제목 키워드 겹침×2 + 설명 키워드 겹침×1.
 * 관련 글이 부족하면(2개 미만) 최신 글로 자리를 채워 블록이 항상 노출되게 합니다.
 */
export function getRelatedPosts(
  current: CollectionEntry<'blog'>,
  all: CollectionEntry<'blog'>[],
  limit = 3
): CollectionEntry<'blog'>[] {
  const curTags = new Set((current.data.tags ?? []).map((t) => t.toLowerCase()));
  const curTitle = tokenize(current.data.title);
  const curDesc = tokenize(current.data.description ?? '');

  const scored: Scored[] = [];
  for (const post of all) {
    if (post.id === current.id) continue;
    const tags = new Set((post.data.tags ?? []).map((t) => t.toLowerCase()));
    const title = tokenize(post.data.title);
    const desc = tokenize(post.data.description ?? '');
    const score =
      intersectionCount(curTags, tags) * 3 +
      intersectionCount(curTitle, title) * 2 +
      intersectionCount(curDesc, desc) * 1;
    if (score > 0) scored.push({ post, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 동점이면 최신 글 우선
    return b.post.data.pubDate.getTime() - a.post.data.pubDate.getTime();
  });

  const picked = scored.slice(0, limit).map((s) => s.post);

  // 관련 글이 모자라면 최신 글로 채웁니다(자기 자신·이미 뽑힌 글 제외).
  if (picked.length < limit) {
    const chosen = new Set(picked.map((p) => p.id));
    chosen.add(current.id);
    const recent = [...all]
      .filter((p) => !chosen.has(p.id))
      .sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime());
    for (const p of recent) {
      if (picked.length >= limit) break;
      picked.push(p);
    }
  }

  return picked;
}
