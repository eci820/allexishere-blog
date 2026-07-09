// 본문 마크다운에서 '자주 묻는 질문' 섹션을 찾아 Q/A 쌍을 뽑고,
// 구글 리치결과용 FAQPage(JSON-LD) 객체를 만듭니다.
// 글 생성 규격(generate.mjs)은 건드리지 않으므로, '표시 시점'에 본문을 파싱합니다.
//
// 지원하는 두 가지 작성 형태:
//   (A) FAQ 제목(##/###) 아래에 질문을 소제목(더 깊은 ###/####)으로,
//       그 다음 문단을 답으로 적는 형태.
//   (B) FAQ 제목 아래에 **Q1. 질문** (볼드) + 다음 문단이 답(A1. ...)인 형태.
// 둘 중 더 많은 쌍을 만든 쪽을 채택합니다.

export interface FaqItem {
  question: string;
  answer: string;
}

// 마크다운 장식을 걷어내 순수 텍스트로. (링크는 표시 텍스트만 남김)
function stripMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 이미지 제거
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 링크 → 텍스트
    .replace(/`([^`]*)`/g, '$1') // 인라인 코드
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 볼드
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1') // 이탤릭
    .replace(/^#{1,6}\s*/, '') // 남은 헤딩 표시
    .replace(/\s+/g, ' ')
    .trim();
}

// 'Q1.', 'A1.', 'Q.', 'A :' 같은 라벨 접두어 제거
function stripQaLabel(text: string): string {
  return text.replace(/^\s*[QA]\s*\d*\s*[.:]?\s*/i, '').trim();
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function looksLikeFaqHeading(text: string): boolean {
  return /자주\s*묻는\s*질문|자주하는\s*질문|^\s*FAQ\b/i.test(text);
}

// 순수 링크만 있는 문단(관련글 링크 등)인지 — 답이 아님
function isBareLink(text: string): boolean {
  return /^\s*\[[^\]]+\]\([^)]*\)\s*$/.test(text.trim());
}

/** 본문에서 FAQ 항목들을 추출합니다. 없으면 빈 배열. */
export function extractFaq(body: string): FaqItem[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);

  // 1) FAQ 제목 줄 찾기
  let faqLevel = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && looksLikeFaqHeading(m[2])) {
      faqLevel = m[1].length;
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];

  // 2) 섹션 범위: FAQ 제목과 같거나 더 상위(#이 같거나 적은) 헤딩 전까지
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].length <= faqLevel) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end);

  const byHeading = collectByHeading(section, faqLevel);
  const byBold = collectByBold(section);

  // 완성된(질문·답 모두 있는) 쌍이 더 많은 방식을 채택
  return byHeading.length >= byBold.length ? byHeading : byBold;
}

// (A) 질문이 더 깊은 소제목인 형태
function collectByHeading(section: string[], faqLevel: number): FaqItem[] {
  const items: FaqItem[] = [];
  let cur: { q: string; a: string[] } | null = null;
  const flush = () => {
    if (cur) {
      const answer = stripMarkdown(cur.a.join(' '));
      if (cur.q && answer) items.push({ question: cur.q, answer });
    }
  };
  for (const line of section) {
    const m = line.match(HEADING_RE);
    if (m && m[1].length > faqLevel) {
      flush();
      cur = { q: stripMarkdown(m[2]), a: [] };
    } else if (cur && line.trim() && !isBareLink(line)) {
      cur.a.push(line.trim());
    }
  }
  flush();
  return items;
}

// (B) 질문이 **볼드** 문단인 형태
function collectByBold(section: string[]): FaqItem[] {
  const paras = section
    .join('\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const items: FaqItem[] = [];
  let cur: { q: string; a: string[] } | null = null;
  const boldOnly = /^\*\*([^]+?)\*\*$/; // 문단 전체가 볼드 = 질문
  const flush = () => {
    if (cur) {
      const answer = stripMarkdown(cur.a.join(' '));
      if (cur.q && answer) items.push({ question: cur.q, answer });
    }
  };
  for (const para of paras) {
    const bm = para.match(boldOnly);
    if (bm) {
      flush();
      cur = { q: stripQaLabel(stripMarkdown(bm[1])), a: [] };
    } else if (cur && cur.a.length === 0 && !isBareLink(para)) {
      // 볼드 Q/A 형태의 답은 질문 바로 다음 '한 문단'입니다.
      // 첫 문단만 취해, FAQ 뒤에 이어지는 마무리 문단이 답에 섞이지 않게 합니다.
      cur.a.push(stripQaLabel(para));
    }
  }
  flush();
  return items;
}

/**
 * FAQ 항목으로 FAQPage JSON-LD 를 만듭니다.
 * 얇은 마크업을 피하려 최소 2개 이상일 때만 생성(그 외 null).
 */
export function buildFaqJsonLd(
  items: FaqItem[]
): Record<string, unknown> | null {
  if (items.length < 2) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.question,
      acceptedAnswer: { '@type': 'Answer', text: it.answer },
    })),
  };
}
