// map.naver.com 링크를 지도 pill(.map-link) 로 표준화한다. (호주판 rehype-map-links 의 한국판)
//
//  · 글에서는 지금까지처럼 그냥  🗺 [네이버 지도에서 …보기](https://map.naver.com/...)  로 쓴다.
//    → 기존 글·새 글을 하나도 고치지 않고, 빌드타임에 이 플러그인이 <a> 를 pill 로 바꾼다.
//  · 하는 일: 지도 링크에 .map-link 클래스 + target=_blank + rel="noopener nofollow" 부여,
//    아이콘은 📍 하나로 정리(본문에 붙어 있던 🗺 중복 제거). CSS(.map-link)가 알약 모양을 그린다.
//  · 외부 의존 없이 hast 트리를 수동 재귀한다(레포의 다른 rehype 플러그인과 같은 방식).
//  · 빌드타임 전용이라 봇(automation/) 재시작과 무관하다 — 다음 배포 빌드에서 반영된다.

const MAP_HOST = 'map.naver.com';
// 앵커 텍스트 맨 앞 / 앵커 바로 앞 텍스트 끝에 붙는 지도 이모지(🗺 · 🗺️ · 중복 📍)를 걷어낸다.
const LEAD_ICON = /^\s*(?:🗺️|🗺|📍)+\s*/u;
const TRAIL_ICON = /(?:🗺️|🗺|📍)+\s*$/u;

function isMapAnchor(node) {
  if (!node || node.type !== 'element' || node.tagName !== 'a') return false;
  const href = node.properties?.href;
  return typeof href === 'string' && href.includes(MAP_HOST);
}

function firstText(node) {
  for (const c of node.children || []) {
    if (c.type === 'text') return c;
  }
  return null;
}

function walk(node) {
  const kids = node.children;
  if (!Array.isArray(kids) || kids.length === 0) return;
  for (const child of kids) walk(child);

  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (!isMapAnchor(child)) continue;

    // 1) 앵커 바로 앞 텍스트에 붙어 있던 🗺/📍 접두 이모지를 제거(pill 안 📍 와 중복 방지).
    const prev = kids[i - 1];
    if (prev && prev.type === 'text') {
      prev.value = prev.value.replace(TRAIL_ICON, '');
    }

    // 2) 새 탭·보안 속성 + .map-link 클래스.
    child.properties = child.properties || {};
    child.properties.target = '_blank';
    child.properties.rel = 'noopener nofollow';
    const cls = child.properties.className;
    child.properties.className = Array.isArray(cls)
      ? [...new Set([...cls, 'map-link'])]
      : ['map-link'];

    // 3) 아이콘 정리: 앵커 텍스트 맨 앞에 지도 이모지가 있으면 제거한다.
    //    📍 는 CSS(.map-link::before)가 한 번만 그린다 — 중복 방지.
    const t = firstText(child);
    if (t) t.value = t.value.replace(LEAD_ICON, '');
  }
}

export default function rehypeMapLinks() {
  return (tree) => walk(tree);
}
