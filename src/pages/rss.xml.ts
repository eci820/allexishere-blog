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
    // noindex:true 글은 sitemap 과 동일하게 RSS 에서도 제외(색인·배포 신호 일관성).
    // 페이지 자체는 살아 있고 사이트 내부 링크로는 계속 접근됩니다.
    items: posts.filter((post) => !post.data.noindex).map((post) => ({
      title: post.data.title,
      description: post.data.description?.trim() || makeExcerpt(post.body ?? ''),
      pubDate: post.data.pubDate,
      link: getPostUrl(post),
    })),
    customData: `<language>ko-kr</language>`,
  });
}
