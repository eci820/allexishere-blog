// 글 본문(마크다운)에서 목록에 보여줄 짧은 미리보기 텍스트를 만듭니다.
// 이미지·링크·제목기호(#)·강조(**) 등 마크다운 문법을 제거하고 순수 글자만 남깁니다.

export function makeExcerpt(markdown: string, maxLength = 160): string {
  let text = markdown;

  // 코드블록 제거
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // 이미지 ![alt](url) 제거
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // 링크 [텍스트](url) → 텍스트만
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 제목/인용/목록 기호 제거 (줄 앞의 #, >, -, *, 숫자.)
  text = text.replace(/^\s{0,3}([#>]+|[-*+]|\d+\.)\s+/gm, '');
  // 강조/코드 기호 제거
  text = text.replace(/[*_`~]/g, '');
  // HTML 태그 제거
  text = text.replace(/<[^>]+>/g, ' ');
  // 표 구분선 제거
  text = text.replace(/\|/g, ' ');
  // 공백 정리
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxLength) {
    text = text.slice(0, maxLength).trimEnd() + '…';
  }
  return text;
}
