// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

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

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [sitemap()],
});
