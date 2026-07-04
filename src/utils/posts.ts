import { getCollection } from 'astro:content';

// 배포에 노출할 글만(초안 제외) 최신순으로 정렬해 가져옵니다.
export async function getPublishedPosts() {
  const posts = await getCollection('blog', ({ data }) => data.draft !== true);
  return posts.sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime()
  );
}
