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

// 글 URL → 최종 수정일(ISO). sitemap 의 <lastmod> 근거입니다.
//
// 🔴 부정확한 lastmod 는 없느니만 못합니다. 구글은 lastmod 가 실제 변경과 어긋나는 걸
//    반복 확인하면 그 사이트의 lastmod 를 통째로 무시합니다. 그래서 규칙을 좁게 잡습니다:
//      ① updatedDate 가 있으면 그것   ② 없으면 pubDate   ③ 둘 다 없거나 파싱 실패면 생략
//    '오늘 날짜'·'빌드 시각' 같은 값을 넣지 않습니다 — 그건 매 배포마다 전 글이 수정된 척
//    하는 거짓 신호이고, lastmod 신뢰를 잃는 가장 빠른 길입니다.
//
// ⚠️ 알려진 한계: 봇 갱신 경로(generate.mjs 의 refreshPublished)는 frontmatter 를
//    verbatim 보존만 하고 updatedDate 를 남기지 않습니다. 그래서 갱신된 글도 pubDate 가
//    들어가 '실제보다 오래된' 값이 됩니다. 오래된 쪽으로 틀리는 건 거짓 신선도를 주장하지
//    않으므로 해롭지 않지만, 정확하지도 않습니다. 근본 해결은 refreshPublished 가
//    updatedDate 를 찍게 하는 것이며 별건입니다.
//
// 글이 아닌 페이지(홈·/page/N·about·privacy)는 근거가 될 날짜가 없어 lastmod 를 넣지
// 않습니다. 목록 페이지에 '오늘'을 넣고 싶어지지만, 그게 바로 ③의 거짓 신호입니다.
function postLastmods() {
  const base = new URL('./src/content/blog/', import.meta.url);
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(base, { recursive: true });
  } catch {
    return map;
  }
  for (const rel of files) {
    const f = String(rel);
    if (!/\.(md|mdx)$/.test(f) || f.startsWith('_templates') || f.startsWith('.obsidian')) continue;
    const raw = fs.readFileSync(new URL(f, base), 'utf8');
    const fm = raw.split(/\r?\n---/)[0];
    const pick = (re) => (fm.match(re) || [])[1];
    // updatedDate 우선, 없으면 pubDate. 파싱 안 되면 넣지 않는다.
    const rawDate = (pick(/^updatedDate:\s*["']?(.*?)["']?\s*$/m) || '').trim()
      || (pick(/^pubDate:\s*["']?(.*?)["']?\s*$/m) || '').trim();
    if (!rawDate) continue;
    const d = new Date(rawDate);
    if (Number.isNaN(d.getTime())) continue;
    // 미래 날짜는 넣지 않는다(예약 발행·오타 방지) — 거짓 신선도가 된다.
    if (d.getTime() > Date.now()) continue;
    const orig = (fm.match(/^originalPath:\s*["']?(.*?)["']?\s*$/m) || [])[1];
    const id = f.replace(/[\\/]index\.(md|mdx)$/, '').replace(/\.(md|mdx)$/, '');
    let p = orig && orig.trim() ? orig.trim() : `/entry/${id}`;
    if (!p.startsWith('/')) p = '/' + p;
    map.set(p.replace(/\/+$/, '').toLowerCase(), d.toISOString());
  }
  return map;
}
const POST_LASTMOD = postLastmods();

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
      // <lastmod> 를 채웁니다. 근거가 있는 URL 에만 넣고, 없으면 그대로 둡니다(생략).
      // 근거 규칙은 postLastmods() 주석 참고 — updatedDate → pubDate, 없으면 생략.
      serialize: (item) => {
        try {
          const p = decodeURIComponent(new URL(item.url).pathname).replace(/\/+$/, '').toLowerCase();
          const lastmod = POST_LASTMOD.get(p);
          if (lastmod) item.lastmod = lastmod;
        } catch {
          /* URL 파싱 실패는 무시 — lastmod 없이 그대로 내보낸다 */
        }
        return item;
      },
    }),
    sveltiaDevAdmin(),
    writeDevEditor(),
  ],
});
