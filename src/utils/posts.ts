import { getCollection } from 'astro:content';

// 목록에 노출할 글을 최신순으로 가져옵니다.
// 초안(draft:true)은 '운영 빌드에서만' 제외합니다. 개발(npm run dev)에서는 초안도
// 보여줘서 발행 전에 미리보기를 할 수 있게 합니다(Obsidian 글쓰기 흐름 대응).
export async function getPublishedPosts() {
  const posts = await getCollection('blog', ({ data }) =>
    import.meta.env.PROD ? data.draft !== true : true
  );
  return posts.sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime()
  );
}
