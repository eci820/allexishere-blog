// @ts-check
import { defineConfig } from 'astro/config';
import fs from 'node:fs';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import rehypeImageGrid from './src/lib/rehype-image-grid.mjs';
import rehypeCallouts from './src/lib/rehype-callouts.mjs';
import rehypeSeoFix from './src/lib/rehype-seo-fix.mjs';
import rehypeMapLinks from './src/lib/rehype-map-links.mjs';
import { writeDevEditor } from './src/lib/write-editor.mjs';

// 로컬 개발 전용 편집기(Sveltia CMS) 서빙 통합.
// astro:server:setup 훅은 `astro dev` 에서만 실행되므로, /admin 은 개발 서버에만 존재하고
// 운영 빌드(astro build → dist)에는 admin 관련 파일이 전혀 포함되지 않습니다(순수 static 유지).
// admin 파일을 public/ 이 아니라 cms/ 에 두는 이유도 dist 복사를 원천 차단하기 위함입니다.
function sveltiaDevAdmin() {
  return {
    name: 'sveltia-dev-admin',
    hooks: {
      /** @param {{ server: import('vite').ViteDevServer }} ctx */
      'astro:server:setup': ({ server }) => {
        const readCms = (name) =>
          fs.readFileSync(new URL(`./cms/${name}`, import.meta.url), 'utf-8');
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (url === '/admin' || url === '/admin/' || url === '/admin/index.html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(readCms('index.html'));
          } else if (url === '/admin/config.yml') {
            res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
            res.end(readCms('config.yml'));
          } else {
            next();
          }
        });
      },
    },
  };
}

// noindex:true 인 글의 URL 경로 집합. sitemap·RSS 에서 제외해 'noindex' 와 '목록 포함'의
// 상충 신호를 막습니다. getPostUrl 과 같은 규칙(originalPath 우선, 없으면 /entry/{폴더명}).
function noindexPaths() {
  const base = new URL('./src/content/blog/', import.meta.url);
  const set = new Set();
  let files = [];
  try {
    files = fs.readdirSync(base, { recursive: true });
  } catch {
    return set;
  }
  for (const rel of files) {
    const f = String(rel);
    if (!/\.(md|mdx)$/.test(f) || f.startsWith('_templates') || f.startsWith('.obsidian')) continue;
    const raw = fs.readFileSync(new URL(f, base), 'utf8');
    const fm = raw.split(/\r?\n---/)[0];
    if (!/^noindex:\s*true\s*$/m.test(fm)) continue;
    const orig = (fm.match(/^originalPath:\s*["']?(.*?)["']?\s*$/m) || [])[1];
    const id = f.replace(/[\\/]index\.(md|mdx)$/, '').replace(/\.(md|mdx)$/, '');
    let p = orig && orig.trim() ? orig.trim() : `/entry/${id}`;
    if (!p.startsWith('/')) p = '/' + p;
    set.add(p.replace(/\/+$/, ''));
  }
  return set;
}
const NOINDEX_PATHS = noindexPaths();

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
    // 콜아웃(강조박스) → 연속 이미지 그리드 → 지도 링크 pill → SEO 보정(본문 h1강등·img alt) 순.
    // seoFix 를 마지막에 둬 그리드로 재배치된 이미지까지 alt 를 확실히 채운다.
    rehypePlugins: [rehypeCallouts, rehypeImageGrid, rehypeMapLinks, rehypeSeoFix],
  },

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [
    sitemap({
      filter: (page) => {
        try {
          const p = decodeURIComponent(new URL(page).pathname).replace(/\/+$/, '');
          return !NOINDEX_PATHS.has(p);
        } catch {
          return true;
        }
      },
    }),
    sveltiaDevAdmin(),
    writeDevEditor(),
  ],
});
