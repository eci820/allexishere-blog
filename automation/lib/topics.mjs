// 기존 발행 글과 주제 매칭(배지·/draft 경고·내부링크 공용).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';

const BLOG = path.join(ROOT, 'src', 'content', 'blog');
// 일반어(보조어)는 주제 매칭에서 제외 — '부작용·조회·방법' 같은 단어의 오탐 방지
const STOP = new Set([
  '방법', '조회', '부작용', '뜻', '이유', '근황', '총정리', '정리', '신청', '가격', '후기', '일정',
  '효과', '종류', '기간', '대상', '자격', '확인', '정보', '안내', '요령', '수칙', '명소', '시기',
  '추천', '분석', '비교', '순위', '최신', '무료', '예방', '관리', '기준', '가능', '이용', '서비스',
  '사실관계', '논란', '얼마', '언제', '어디', '오늘', '올해', '2026', '나이', '뜻과',
]);
const tokens = (s) =>
  s.replace(/[^가-힣a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));

// 키워드와 가장 겹치는 발행 글 1개(초안 제외). score=제목에 포함된 키워드 토큰 수.
export function existingMatch(keyword) {
  if (!fs.existsSync(BLOG)) return null;
  const kw = tokens(keyword);
  if (!kw.length) return null;
  let best = null;
  for (const d of fs.readdirSync(BLOG)) {
    const f = path.join(BLOG, d, 'index.md');
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    if (/^draft:\s*true/m.test(raw)) continue;
    const title = (raw.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || '';
    const orig = (raw.match(/^originalPath:\s*"?(.*?)"?\s*$/m) || [])[1] || '/entry/' + d;
    const score = kw.filter((w) => title.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { title, url: orig, score, slug: d };
  }
  return best;
}

// 배지 판정(강한 겹침): 같은 주제 글 보유 여부
export function hasExistingPost(keyword) {
  const m = existingMatch(keyword);
  return m && m.score >= 2 ? m : null;
}
