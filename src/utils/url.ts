import type { CollectionEntry } from 'astro:content';

// 글 하나의 최종 URL 을 계산합니다.
// 티스토리 원본 주소(/entry/제목)를 그대로 재현해 검색 유입을 보존하는 것이 목표입니다.
// - originalPath 가 있으면 그 값을 그대로 사용 (이전한 글)
// - 없으면 파일 이름(id)을 기준으로 /entry/파일이름 사용 (새로 쓴 글)
export function getPostUrl(post: CollectionEntry<'blog'>): string {
  const original = post.data.originalPath?.trim();
  if (original) {
    return original.startsWith('/') ? original : `/${original}`;
  }
  return `/entry/${post.id}`;
}
