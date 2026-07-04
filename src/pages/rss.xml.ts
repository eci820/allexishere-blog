// RSS 피드 (/rss.xml). 구독자·검색엔진이 새 글을 자동으로 받아볼 수 있게 합니다.
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { SITE } from '../consts';
import { getPublishedPosts } from '../utils/posts';
import { getPostUrl } from '../utils/url';
import { makeExcerpt } from '../utils/excerpt';

export async function GET(context: APIContext) {
  const posts = await getPublishedPosts();
  const site = context.site ?? new URL(SITE.url);

  return rss({
    title: `${SITE.title} - ${SITE.tagline}`,
    description: SITE.description,
    site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description?.trim() || makeExcerpt(post.body ?? ''),
      pubDate: post.data.pubDate,
      link: getPostUrl(post),
    })),
    customData: `<language>ko-kr</language>`,
  });
}
