// 날짜를 화면 표시용 'YYYY.MM.DD' 형식으로 바꿉니다.
// frontmatter 의 날짜(예: 2026-06-07)는 UTC 자정으로 저장되므로,
// JSON-LD 의 ISO 날짜(datePublished 등)와 어긋나지 않도록 UTC 기준으로 뽑습니다.
export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}
