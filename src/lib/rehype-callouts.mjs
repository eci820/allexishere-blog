// Obsidian 콜아웃 / GitHub Alerts 문법을 콜아웃 박스로 렌더링합니다.
//   > [!tip] 제목        → 팁 박스
//   > [!warning]         → 주의 박스(제목 생략 시 기본 제목)
//   > [!note] 제목        → 참고 박스
// 지원 3종(tip·warning·note) + 흔한 별칭. 인식 안 되는 종류는 일반 인용구로 둡니다.
// 디자인은 global.css 의 .callout[data-callout=...] 에서 담당합니다.

const TYPES = {
  tip: '팁',
  warning: '주의',
  note: '참고',
};
// GitHub/Obsidian 별칭 → 우리 3종으로 매핑
const ALIAS = {
  info: 'note',
  important: 'note',
  quote: 'note',
  hint: 'tip',
  success: 'tip',
  check: 'tip',
  caution: 'warning',
  danger: 'warning',
  attention: 'warning',
  error: 'warning',
};

const isWs = (n) => n.type === 'text' && n.value.trim() === '';

function resolveType(raw) {
  const k = raw.toLowerCase();
  if (TYPES[k]) return k;
  if (ALIAS[k]) return ALIAS[k];
  return null;
}

// blockquote 하나를 콜아웃 div 로 변환. 콜아웃이 아니면 null 반환.
function toCallout(bq) {
  const firstP = bq.children.find((c) => c.type === 'element' && c.tagName === 'p');
  if (!firstP) return null;
  const firstText = firstP.children[0];
  if (!firstText || firstText.type !== 'text') return null;

  const value = firstText.value;
  const nl = value.indexOf('\n');
  const firstLine = nl === -1 ? value : value.slice(0, nl);
  const rest = nl === -1 ? '' : value.slice(nl + 1);

  const m = firstLine.match(/^\s*\[!([A-Za-z]+)\]\s*(.*)$/);
  if (!m) return null;
  const type = resolveType(m[1]);
  if (!type) return null;

  const title = m[2].trim() || TYPES[type];

  // 본문 재구성: 첫 문단에서 '[!type] 제목' 줄을 제거
  if (rest === '') {
    // 첫 문단이 제목만 있던 경우 → 그 문단 통째로 제거
    firstP.children.shift();
    if (firstP.children.every(isWs)) {
      const idx = bq.children.indexOf(firstP);
      bq.children.splice(idx, 1);
    }
  } else {
    firstText.value = rest;
  }

  const body = bq.children.filter((c) => !isWs(c));

  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['callout'], 'data-callout': type },
    children: [
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['callout-title'] },
        children: [{ type: 'text', value: title }],
      },
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['callout-body'] },
        children: body,
      },
    ],
  };
}

function walk(node) {
  if (!node.children || node.children.length === 0) return;
  for (const child of node.children) walk(child);
  node.children = node.children.map((child) => {
    if (child.type === 'element' && child.tagName === 'blockquote') {
      return toCallout(child) || child;
    }
    return child;
  });
}

export default function rehypeCallouts() {
  return (tree) => walk(tree);
}
