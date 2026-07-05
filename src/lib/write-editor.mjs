// 로컬 전용 '티스토리식' 글쓰기 편집기 서버 (dev 전용).
// astro:server:setup(=astro dev)에서만 /write 경로와 API를 미들웨어로 붙입니다.
// 운영 빌드(astro build → dist)에는 전혀 포함되지 않습니다(순수 static 유지).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BLOG = path.join(ROOT, 'src', 'content', 'blog');
const WRITE = path.join(ROOT, 'cms', 'write');

const CT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const IMG_CT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function send(res, status, type, body) { res.statusCode = status; res.setHeader('Content-Type', type); res.end(body); }
function json(res, obj, status = 200) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj)); }
function readJson(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

// ---- frontmatter ----
function parseFM(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const mm = line.match(/^([A-Za-z]+):\s*(.*)$/); if (!mm) return;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).replace(/\\"/g, '"');
    data[mm[1]] = v;
  });
  return { data, body: raw.slice(m[0].length) };
}
function parseTags(v) {
  if (!v) return [];
  const inner = v.replace(/^\[|\]$/g, '').trim(); if (!inner) return [];
  return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}
const dq = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function tagVal(s) { return /[:#\[\]{},"']|^\s|\s$/.test(s) ? dq(s) : s; }

function serialize(fm, body) {
  let o = '---\n';
  o += `title: ${dq(fm.title)}\n`;
  if (fm.description) o += `description: ${dq(fm.description)}\n`;
  o += `pubDate: ${fm.pubDate}\n`;
  o += `category: info\n`;
  if (fm.tags && fm.tags.length) o += `tags: [${fm.tags.map(tagVal).join(', ')}]\n`;
  o += `draft: ${fm.draft ? 'true' : 'false'}\n`;
  o += '---\n\n' + String(body).replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
  return o;
}
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}
function safeSlug(s) {
  return String(s || '').trim().replace(/[\/\\:*?"<>|#%\[\]{}()]/g, '').replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}
function safeFilename(name) {
  const ext = (path.extname(name) || '.png').toLowerCase();
  let base = path.basename(name, path.extname(name));
  base = base.replace(/[^\w가-힣.\-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '') || 'image';
  return { base, ext };
}
function listDirs() {
  return fs.readdirSync(BLOG, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_templates' && d.name !== '.obsidian')
    .map((d) => d.name);
}

// ---- API handlers ----
function apiPosts(res) {
  const posts = listDirs().map((slug) => {
    const f = path.join(BLOG, slug, 'index.md');
    if (!fs.existsSync(f)) return null;
    const { data } = parseFM(fs.readFileSync(f, 'utf8'));
    return { slug, title: data.title || slug, draft: data.draft === 'true', pubDate: data.pubDate || '', readOnly: !!data.originalPath };
  }).filter(Boolean).sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  json(res, { posts });
}
function apiLoad(res, body) {
  const slug = safeSlug(body.slug);
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return json(res, { ok: false, error: 'not found' });
  const { data, body: md } = parseFM(fs.readFileSync(f, 'utf8'));
  json(res, { ok: true, post: { slug, title: data.title || '', description: data.description || '', tags: parseTags(data.tags), body: md.trim(), draft: data.draft === 'true', isNew: false } });
}
function apiSave(res, body) {
  const slug = safeSlug(body.slug); if (!slug) return json(res, { ok: false, error: '슬러그가 비었습니다' });
  const orig = body.originalSlug ? safeSlug(body.originalSlug) : null;
  const dir = path.join(BLOG, slug);
  // 폴더 이름(주소) 변경 → 발행 전까지만. 기존 폴더를 새 이름으로 이동.
  if (orig && orig !== slug) {
    const oldDir = path.join(BLOG, orig);
    if (fs.existsSync(dir)) return json(res, { ok: false, error: '같은 주소의 글이 이미 있습니다' });
    if (fs.existsSync(oldDir)) fs.renameSync(oldDir, dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'index.md');
  let pubDate = kstNow();
  if (fs.existsSync(f)) { const { data } = parseFM(fs.readFileSync(f, 'utf8')); if (data.pubDate) pubDate = data.pubDate; }
  const content = serialize({ title: body.title, description: body.description, pubDate, tags: body.tags || [], draft: body.draft !== false }, body.body || '');
  fs.writeFileSync(f, content);
  json(res, { ok: true, slug });
}
function apiUpload(res, body) {
  const slug = safeSlug(body.slug); if (!slug) return json(res, { ok: false, error: '슬러그 필요' });
  const m = /^data:([^;]+);base64,(.*)$/.exec(body.dataUrl || ''); if (!m) return json(res, { ok: false, error: '이미지 형식 오류' });
  const dir = path.join(BLOG, slug); fs.mkdirSync(dir, { recursive: true });
  let { base, ext } = safeFilename(body.filename || 'image.png');
  const mimeExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' }[m[1]];
  if (mimeExt) ext = mimeExt;
  let name = base + ext, i = 1;
  while (fs.existsSync(path.join(dir, name))) name = base + '-' + i++ + ext;
  fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
  json(res, { ok: true, save: './' + name, show: '/write/media/' + encodeURIComponent(slug) + '/' + encodeURIComponent(name) });
}
async function apiPublish(res, body) {
  const slug = safeSlug(body.slug);
  const f = path.join(BLOG, slug, 'index.md');
  if (!fs.existsSync(f)) return json(res, { ok: false, error: 'not found' });
  // 봇 승인과 동일한 '공유 게시 함수'(락으로 직렬화)를 사용해 동시 발행 충돌을 막습니다.
  const { publish } = await import('../../automation/publish.mjs');
  const r = await publish({ slug, title: body.title });
  if (r.ok) json(res, { ok: true, message: `게시 완료: ${r.url}` });
  else json(res, { ok: false, error: r.error });
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) return send(res, 404, 'text/plain', 'not found');
  const ext = path.extname(filePath);
  res.setHeader('Content-Type', CT[ext] || IMG_CT[ext] || 'application/octet-stream');
  res.end(fs.readFileSync(filePath));
}

export function writeDevEditor() {
  return {
    name: 'write-dev-editor',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use(async (req, res, next) => {
          const url = decodeURI((req.url || '').split('?')[0]);
          if (!url.startsWith('/write')) return next();

          // 정적 파일
          if (url === '/write' || url === '/write/') return serveFile(res, path.join(WRITE, 'index.html'));
          if (url === '/write/app.js') return serveFile(res, path.join(WRITE, 'app.js'));
          if (url === '/write/app.css') return serveFile(res, path.join(WRITE, 'app.css'));
          if (url.startsWith('/write/vendor/')) {
            const rel = url.replace('/write/vendor/', '').replace(/\.\./g, '');
            return serveFile(res, path.join(WRITE, 'vendor', rel));
          }
          // 업로드된 이미지 미리보기 (편집기 내 표시용)
          if (url.startsWith('/write/media/')) {
            const parts = url.replace('/write/media/', '').split('/');
            const slug = safeSlug(parts[0]); const file = path.basename(parts.slice(1).join('/'));
            return serveFile(res, path.join(BLOG, slug, file));
          }
          // API
          if (url.startsWith('/write/api/')) {
            const action = url.replace('/write/api/', '');
            const b = req.method === 'POST' ? await readJson(req) : {};
            try {
              if (action === 'posts') return apiPosts(res);
              if (action === 'load') return apiLoad(res, b);
              if (action === 'save') return apiSave(res, b);
              if (action === 'upload') return apiUpload(res, b);
              if (action === 'publish') return await apiPublish(res, b);
            } catch (e) { return json(res, { ok: false, error: (e.message || '').toString() }, 500); }
            return json(res, { ok: false, error: 'unknown action' }, 404);
          }
          return send(res, 404, 'text/plain', 'not found');
        });
      },
    },
  };
}
