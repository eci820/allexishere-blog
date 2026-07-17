// SEO 보정(네이버 서치어드바이저 경고 대응) — 렌더 시점에 전 글+미래 글에 자동 적용.
//  ① 본문 h1(마크다운 '# ') → h2 강등: 페이지당 h1은 레이아웃의 '글 제목' 1개만 남긴다.
//  ② 빈/누락 <img> alt 채움: 직전 소제목 텍스트 → 없으면 글 제목(frontmatter) → "이미지".
//     · 마크다운 이미지 title 이 'decorative'/'장식'이면 장식용으로 보고 alt=""(스크린리더 무시).
//  콘텐츠 파일을 건드리지 않고 빌드 단계에서 교정하므로, 이관글·신규글 모두 재발 방지된다.

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const DECORATIVE = /^(decorative|장식)$/i;

// hast 노드의 텍스트만 추출(소제목 텍스트용).
function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

export default function rehypeSeoFix() {
  return (tree, file) => {
    const fm = file && file.data && file.data.astro && file.data.astro.frontmatter;
    const title = (fm && typeof fm.title === 'string' ? fm.title : '').trim();
    let lastHeading = '';

    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'element') {
        if (HEADINGS.has(node.tagName)) {
          if (node.tagName === 'h1') node.tagName = 'h2'; // ① 본문 h1 강등
          const t = textOf(node).trim();
          if (t) lastHeading = t; // 이후 이미지들의 alt 소스
        } else if (node.tagName === 'img') {
          node.properties = node.properties || {};
          const alt = node.properties.alt;
          const empty = alt == null || String(alt).trim() === '';
          if (empty) {
            const t = node.properties.title;
            // 장식용 표식이면 빈 alt(접근성: 스크린리더가 건너뜀)
            node.properties.alt = t && DECORATIVE.test(String(t).trim())
              ? ''
              : (lastHeading || title || '이미지');
          }
        }
      }
      if (node.children) for (const c of node.children) visit(c);
    };

    visit(tree);
  };
}
