// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import rehypeImageGrid from './src/lib/rehype-image-grid.mjs';

// https://astro.build/config
export default defineConfig({
  // 우리 블로그의 실제 주소. sitemap·RSS·SEO(canonical 등)가 이 값을 기준으로 만들어집니다.
  site: 'https://allexishere.com',

  // 티스토리 원본 주소는 끝에 슬래시가 없는 형태(/entry/제목)로 구글에 색인돼 있습니다.
  // 그 경로를 '리다이렉트 없이' 그대로 재현하려고 아래 두 설정을 씁니다.
  //  - trailingSlash: 'never'  → 내부 링크·canonical 을 슬래시 없는 형태로
  //  - build.format: 'file'    → dist/entry/제목.html 로 출력 → /entry/제목 에서 바로 200
  trailingSlash: 'never',
  build: {
    format: 'file',
  },

  markdown: {
    // Astro 기본 GFM 을 끄고 직접 remark-gfm 을 넣습니다.
    // singleTilde:false → 물결표 1개(예: "16~31일")를 취소선으로 오해하지 않게 함
    // (취소선은 ~~두 개~~ 일 때만). GFM 표·자동링크 등은 그대로 유지됩니다.
    gfm: false,
    // remark-cjk-friendly: **볼드**가 한글·문장부호에 붙어 있어도(예: **‘중독’**입니다)
    // 제대로 볼드 처리되도록 CommonMark 강조 규칙을 한중일 친화적으로 보정합니다.
    remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkCjkFriendly],
    // 연속 이미지 문단을 그리드로 묶기
    rehypePlugins: [rehypeImageGrid],
  },

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [sitemap()],
});
