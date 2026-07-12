import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CATEGORIES } from './consts';

const categorySlugs = CATEGORIES.map((c) => c.slug) as [string, ...string[]];

// 웹 편집기(Sveltia CMS)는 비어 있는 선택 항목을 생략하지 않고 ''(빈 문자열)로 적습니다.
// 그대로 두면 date/enum/image 스키마가 깨지므로, 빈 문자열을 '없음(undefined)'으로 바꿔줍니다.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

// blog 컬렉션: src/content/blog/ 안의 마크다운 파일들을 모읍니다.
const blog = defineCollection({
  // 글 파일만 모읍니다. Obsidian 보관함 설정(.obsidian)과 새 글 템플릿(_templates)은
  // 콘텐츠로 오인하지 않도록 제외합니다.
  loader: glob({
    pattern: ['**/*.{md,mdx}', '!_templates/**', '!.obsidian/**'],
    base: './src/content/blog',
  }),
  schema: ({ image }) =>
    z.object({
      // 필수 항목 ---------------------------------------------------------
      /** 글 제목 */
      title: z.string(),
      /** 글 요약(검색결과·목록에 표시). 없으면 본문 앞부분으로 대체 */
      description: z.string().default(''),
      /** 최초 발행일 */
      pubDate: z.coerce.date(),
      /** 카테고리. 편집기가 빈 값을 보내면 기본 카테고리로 채웁니다. */
      category: z.preprocess(
        (v) => (v === '' || v == null ? categorySlugs[0] : v),
        z.enum(categorySlugs)
      ),

      // 선택 항목 ---------------------------------------------------------
      /** 수정일 (있으면 표시). 편집기의 빈 문자열은 '없음'으로 처리 */
      updatedDate: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
      /** 태그 목록 */
      tags: z.array(z.string()).default([]),
      /** 대표 이미지 — **선택 사항**(비워두는 게 기본). 없으면 목록은 텍스트 카드,
       *  상세는 히어로 생략, 공유 미리보기(og)는 기본 이미지로 자동 대체됩니다.
       *  편집기의 빈 문자열은 '없음'으로 처리. */
      cover: z.preprocess(emptyToUndefined, image().optional()),
      /** 대표 이미지 대체 텍스트 */
      coverAlt: z.string().optional(),
      /**
       * 티스토리 원본 URL 경로. 예: "/92" 또는 "/entry/글제목"
       * 검색 유입을 보존하기 위해 이 경로를 그대로 재현하거나 301 리다이렉트에 사용합니다.
       */
      originalPath: z.string().optional(),
      /** 초안 여부. true 면 배포 빌드에서 제외 */
      draft: z.boolean().default(false),
      /** 실험 코호트 태그(검증용). 예: "2026-07-13_conditions_changed" */
      cohort: z.string().optional(),
    }),
});

export const collections = { blog };
