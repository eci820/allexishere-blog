// 본문에서 이미지 문단(<p><img></p>)이 2개 이상 연속되면
// <div class="img-grid"> 로 묶어 그리드로 보여줍니다(모바일 2열·데스크톱 3열, CSS 담당).
// 단독 이미지 1장은 묶지 않아 기존처럼 크게 유지됩니다.

function isWhitespace(node) {
  return node.type === 'text' && node.value.trim() === '';
}

// <p> 안에 (공백 제외) 이미지 하나만 있는 문단인지 판별. <a><img></a> 형태도 허용.
function isImageParagraph(node) {
  if (!node || node.type !== 'element' || node.tagName !== 'p') return false;
  const kids = node.children.filter((c) => !isWhitespace(c));
  if (kids.length !== 1) return false;
  const only = kids[0];
  if (only.type !== 'element') return false;
  if (only.tagName === 'img') return true;
  if (only.tagName === 'a') {
    const inner = only.children.filter((c) => !isWhitespace(c));
    return inner.length === 1 && inner[0].type === 'element' && inner[0].tagName === 'img';
  }
  return false;
}

function walk(node) {
  if (!node.children || node.children.length === 0) return;
  for (const child of node.children) walk(child);

  const kids = node.children;
  const out = [];
  let i = 0;
  while (i < kids.length) {
    if (isImageParagraph(kids[i])) {
      const run = [kids[i]];
      let j = i + 1;
      while (j < kids.length) {
        if (isWhitespace(kids[j])) { j++; continue; } // 이미지 사이 공백은 건너뜀
        if (isImageParagraph(kids[j])) { run.push(kids[j]); j++; }
        else break;
      }
      if (run.length >= 2) {
        out.push({
          type: 'element',
          tagName: 'div',
          properties: { className: ['img-grid'] },
          children: run,
        });
        i = j;
        continue;
      }
    }
    out.push(kids[i]);
    i++;
  }
  node.children = out;
}

export default function rehypeImageGrid() {
  return (tree) => walk(tree);
}
