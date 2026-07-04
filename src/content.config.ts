import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORIES } from './consts';

const categorySlugs = CATEGORIES.map((c) => c.slug) as [string, ...string[]];

// blog 컬렉션: src/content/blog/ 안의 마크다운 파일들을 모읍니다.
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      // 필수 항목 ---------------------------------------------------------
      /** 글 제목 */
      title: z.string(),
      /** 글 요약(검색결과·목록에 표시). 없으면 본문 앞부분으로 대체 */
      description: z.string().default(''),
      /** 최초 발행일 */
      pubDate: z.coerce.date(),
      /** 카테고리 (parking | tax | health 중 하나) */
      category: z.enum(categorySlugs),

      // 선택 항목 ---------------------------------------------------------
      /** 수정일 (있으면 표시) */
      updatedDate: z.coerce.date().optional(),
      /** 태그 목록 */
      tags: z.array(z.string()).default([]),
      /** 대표 이미지 */
      cover: image().optional(),
      /** 대표 이미지 대체 텍스트 */
      coverAlt: z.string().optional(),
      /**
       * 티스토리 원본 URL 경로. 예: "/92" 또는 "/entry/글제목"
       * 검색 유입을 보존하기 위해 이 경로를 그대로 재현하거나 301 리다이렉트에 사용합니다.
       */
      originalPath: z.string().optional(),
      /** 초안 여부. true 면 배포 빌드에서 제외 */
      draft: z.boolean().default(false),
    }),
});

export const collections = { blog };
