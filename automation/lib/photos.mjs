// 📷 현장 캡처 발행 — 사진 파이프라인 + 개인정보 2중 방어.
//
// 이 파일이 책임지는 것(사용자는 사진만 첨부하면 된다):
//  ① EXIF 완전 제거 — GPS 좌표·촬영시각·기기정보. 텔레그램이 압축하며 지워주는 경우가
//     많지만 '문서로 보내기'로 오면 원본 EXIF 가 그대로 온다. 믿지 않고 항상 지운다.
//  ② 리사이즈·압축 — 가로 최대 1200px, 200KB 이하 목표.
//  ③ 비전 분류(1차 방어) — 영수증·명함·티켓은 발행 이미지에서 제외하고 텍스트만 추출.
//     얼굴이 뚜렷하면 보류(사람이 [포함하기]를 눌러야 들어감).
//  ④ 본문 정규식 스크럽(2차 방어) — LLM 이 흘린 카드번호·연락처 등을 발행 직전에 제거.
//
// ⚠️ ③④는 자동 안전망이지 100% 보장이 아니다(배경 인물·옆 차 번호판·손글씨 메모 등).
//    그래서 걸러낸 결과는 항상 초안 카드에 표시해 사람이 최종 확인하게 한다.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { runClaude, unwrapClaudeJSON } from './claudeCli.mjs';

export const MAX_WIDTH = 1200;
export const TARGET_BYTES = 200 * 1024;

// 200KB 를 넘으면 위에서부터 차례로 재시도한다. 먼저 화질을 낮추고(1200px 유지),
// 그래도 안 되면 가로폭을 줄인다 — 디테일이 아주 많은 사진(잔디·군중·야경)은
// 1200px q64 로도 200KB 를 넘기기 때문. 끝까지 못 맞추면 가장 작은 결과를 쓴다.
const LADDER = [
  { width: 1200, quality: 82 },
  { width: 1200, quality: 72 },
  { width: 1200, quality: 64 },
  { width: 1080, quality: 62 },
  { width: 960, quality: 58 },
];

// ── ①② 사진 1장 처리: EXIF 제거 + 회전 보정 + 리사이즈 + 압축 ──────────
// 반환: { bytes, width, height, quality }
//
// .rotate() 를 먼저 부르는 게 핵심이다. EXIF Orientation 태그를 실제 픽셀 회전으로
// 구워넣은 뒤 메타데이터를 버리기 때문에, 세로로 찍은 사진이 눕지 않는다.
// (sharp 는 keepMetadata/withMetadata 를 명시하지 않는 한 메타데이터를 전부 버린다.)
export async function processPhoto(input, destPath) {
  let best = null;
  for (const step of LADDER) {
    const buf = await sharp(input)
      .rotate() // EXIF 방향 → 픽셀에 반영 후 태그 폐기
      .resize({ width: step.width, withoutEnlargement: true }) // 작은 사진은 확대하지 않음
      .jpeg({ quality: step.quality, mozjpeg: true })
      .toBuffer();
    if (!best || buf.length < best.buf.length) best = { buf, ...step };
    if (buf.length <= TARGET_BYTES) break;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, best.buf);
  const meta = await sharp(destPath).metadata();
  return {
    bytes: best.buf.length,
    width: meta.width,
    height: meta.height,
    quality: best.quality,
    overTarget: best.buf.length > TARGET_BYTES, // 끝까지 못 맞춘 경우 호출부가 알 수 있게
  };
}

// ── EXIF 제거 검증 ──────────────────────────────────────────────────
// 처리 결과에 위치·촬영정보가 남아있지 않은지 실제로 확인한다.
// 반환: { clean: true } | { clean: false, found: [...] }
export async function verifyNoExif(filePath) {
  const meta = await sharp(filePath).metadata();
  const found = [];
  if (meta.exif) found.push('exif');
  if (meta.gps) found.push('gps');
  if (meta.xmp) found.push('xmp');
  if (meta.iptc) found.push('iptc');
  if (meta.icc) found.push('icc');
  return found.length ? { clean: false, found } : { clean: true };
}

// ── ③ 비전 분류(1차 방어) ────────────────────────────────────────────
// 사진마다 종류·얼굴 유무·발행에 쓸 설명·글 작성에 쓸 추출 텍스트를 받는다.
const VISION_PROMPT = (names) => `아래 이미지 ${names.length}장을 각각 분석하세요. 파일 순서: ${names.join(', ')}

각 이미지에 대해 판정할 것:
- kind: "receipt"(영수증·계산서) | "businesscard"(명함) | "ticket"(티켓·탑승권·입장권) | "screen"(화면 캡처·안내판·간판·표지판) | "scene"(장소·사물·풍경·음식)
- hasFace: 사람 얼굴이 알아볼 수 있을 만큼 뚜렷하게 나왔으면 true. 뒷모습·멀리 있는 군중·모자이크는 false.
- alt: 이 사진을 블로그에 넣을 때 쓸 한국어 대체텍스트 한 줄(15~40자). 사진에 실제로 보이는 것만. 개인정보는 넣지 마세요.
- extractedText: 글 작성에 쓸 수 있는 정보만 뽑아 적으세요(요금·메뉴명·가격·영업시간·주소·안내문구).
  ⚠️ 카드번호·적립번호·주문번호·사람 이름·전화번호·차량번호·바코드 번호는 절대 적지 마세요.

판정이 애매하면 더 민감한 쪽으로(영수증 같으면 receipt, 얼굴 같으면 true) 판정하세요.

아래 JSON 배열 하나만 출력하세요(코드펜스·설명 금지). 순서는 파일 순서와 같게:
[{"kind":"...","hasFace":false,"alt":"...","extractedText":"..."}]`;

function parseVisionJSON(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('비전 응답에 JSON 배열이 없음');
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('비전 응답이 배열이 아님');
  return arr;
}

const KINDS = new Set(['receipt', 'businesscard', 'ticket', 'screen', 'scene']);
function normalizeVerdict(v) {
  return {
    kind: KINDS.has(v?.kind) ? v.kind : 'scene',
    hasFace: v?.hasFace === true,
    alt: String(v?.alt || '').trim().slice(0, 80),
    extractedText: String(v?.extractedText || '').trim().slice(0, 1200),
  };
}

// 엔진 1: claude-cli(구독 — 추가 과금 0). cwd 를 사진이 있는 폴더로 두고 파일명으로 참조.
// 프롬프트는 stdin 으로(명령행 인자 아님) — 실패해도 프롬프트가 로그에 쏟아지지 않는다.
async function classifyViaCLI(dir, names, config) {
  const extraArgs = ['--allowedTools', 'Read'];
  if (config?.cliModel) extraArgs.push('--model', config.cliModel);
  const stdout = await runClaude(VISION_PROMPT(names), {
    cwd: dir, // 사진이 작업 폴더 안에 있어야 Read 가 파일명으로 접근한다
    timeoutMs: (config?.cliTimeoutSeconds || 240) * 1000,
    extraArgs,
  });
  return parseVisionJSON(unwrapClaudeJSON(stdout).result);
}

// 엔진 2: Anthropic API 비전(폴백). 이미지를 base64 로 직접 넣는다.
async function classifyViaAPI(dir, names, config) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 없음(비전 폴백 불가)');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const content = [];
  for (const n of names) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(dir, n)).toString('base64') },
    });
  }
  content.push({ type: 'text', text: VISION_PROMPT(names) });
  const resp = await client.messages.create({
    model: config?.model || 'claude-sonnet-5',
    max_tokens: 4000, // 사진 20장까지 판정 JSON 이 들어갈 여유
    messages: [{ role: 'user', content }],
  });
  if (resp.stop_reason === 'refusal') throw new Error('비전 판정 안전 거절');
  if (resp.stop_reason === 'max_tokens') throw new Error('비전 응답이 잘림(max_tokens)');
  const txt = (resp.content.find((b) => b.type === 'text') || {}).text || '';
  return parseVisionJSON(txt);
}

// 사진들을 분류한다. 두 엔진이 다 실패하면 throw 하지 않고 unknown 으로 표시해서
// 호출부가 '전부 보류'(= 발행 이미지 0장)라는 안전한 선택을 하게 한다.
export async function classifyPhotos(dir, names, config) {
  if (!names.length) return { verdicts: [], engine: 'none' };
  let verdicts, engine;
  try {
    verdicts = await classifyViaCLI(dir, names, config);
    engine = 'claude-cli';
  } catch (e1) {
    console.error('[photos] claude-cli 분류 실패:', e1.message);
    try {
      verdicts = await classifyViaAPI(dir, names, config);
      engine = 'anthropic-api';
    } catch (e2) {
      console.error('[photos] API 분류 실패:', e2.message);
      // 안전 폴백: 무엇인지 모르면 발행하지 않는다.
      return {
        verdicts: names.map(() => ({ kind: 'unknown', hasFace: false, alt: '', extractedText: '' })),
        engine: 'none',
        error: e2.message,
      };
    }
  }
  // 개수가 안 맞으면 모자란 쪽을 unknown 으로 채운다(잘못된 짝짓기 방지).
  const out = names.map((_, i) =>
    verdicts[i] ? normalizeVerdict(verdicts[i]) : { kind: 'unknown', hasFace: false, alt: '', extractedText: '' }
  );
  return { verdicts: out, engine };
}

// 분류 결과 → 발행할 사진 / 보류할 사진으로 가른다.
//  · receipt/businesscard/ticket → 제외(텍스트만 활용)
//  · hasFace → 보류(사람이 [포함하기] 눌러야 들어감 — 초상권)
//  · unknown → 보류(분류 실패 시 안전 선택)
export function triagePhotos(photos, verdicts) {
  const publishable = [], held = [], excluded = [];
  photos.forEach((p, i) => {
    const v = verdicts[i] || { kind: 'unknown', hasFace: false, alt: '', extractedText: '' };
    const item = { ...p, ...v };
    if (v.kind === 'receipt' || v.kind === 'businesscard' || v.kind === 'ticket') {
      excluded.push({ ...item, reason: { receipt: '영수증', businesscard: '명함', ticket: '티켓' }[v.kind] });
    } else if (v.hasFace) {
      held.push({ ...item, reason: '얼굴 포함' });
    } else if (v.kind === 'unknown') {
      held.push({ ...item, reason: '분류 실패' });
    } else {
      publishable.push(item);
    }
  });
  return { publishable, held, excluded };
}

// ── ④ 본문 정규식 스크럽(2차 방어) ───────────────────────────────────
// LLM 이 실수로 흘려도 발행 직전에 지운다. 정보성으로 살려야 하는 값(매장 대표번호)은 남긴다.
//
// 살리는 것: 02-·1588-·1577-·1544-·1566-·080- 등 지역/대표번호 → 독자에게 필요한 정보.
// 지우는 것: 개인 휴대폰(010 등), 카드번호, 주민번호, 이메일, 적립·회원·주문번호, 차량번호.
// ⚠️ 오탐(false positive)이 오탐 누락보다 위험한 자리다.
//    개인정보를 못 지우면 사람이 [전문]에서 잡을 수 있지만, 요금·수치를 잘못 지우면
//    글이 조용히 망가진 채 발행된다(2026-07-18: '10분 1000원'이 차량번호로 오인돼
//    통째로 삭제되던 버그 — 주차 글의 핵심 정보가 사라졌다).
//    그래서 각 패턴은 '그 형태일 수밖에 없는' 좁은 조건만 잡는다.
const SCRUB_RULES = [
  {
    label: '카드번호',
    // 하이픈으로 끊어 적은 형태만. 공백 구분(1000 2000 3000 4000)은 요금표와
    // 구별할 수 없어 일부러 제외한다.
    re: /\b\d{4}-\d{4}-\d{4}-\d{1,4}\b/g,
  },
  {
    label: '주민등록번호',
    re: /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/g,
  },
  {
    label: '휴대폰번호',
    // 010/011/016/017/018/019 로 시작하는 개인 번호만. 02-·1588- 같은 대표번호는 건드리지 않는다.
    re: /\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g,
  },
  {
    label: '이메일',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    label: '적립·회원·주문번호',
    // 뒤에 오는 값이 '식별번호처럼 생겼을 때'만. 금액(회원 30000원)을 지우지 않도록
    // 뒤에 원/won 이 붙으면 제외하고, 순수 숫자는 8자리 이상만 번호로 본다.
    re: /(?:적립|회원|멤버십|주문|승인|거래|바코드)\s*(?:번호|No\.?)?\s*[:：]?\s*(?:[A-Za-z][A-Za-z0-9-]{5,}|[A-Za-z0-9-]*\d[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*|\d{8,})(?!\s*원)/g,
  },
  {
    label: '차량번호',
    // 12가3456 / 서울12가3456. 가운데 글자는 '실제 번호판에 쓰이는 글자'로 한정한다.
    // 한글 전체(가-힣)로 두면 '10분 1000원'의 '분'까지 번호판으로 오인한다.
    // ⚠️ \b 대신 전후방탐색을 쓴다 — JS 의 \b 는 한글을 단어문자로 치지 않아서
    //    문자열 맨 앞의 '서울…' 같은 지역명이 매칭에서 빠진다.
    re: /(?<![0-9A-Za-z])(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)?\d{2,3}[가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주바사아자하허호배]\s?\d{4}(?![0-9A-Za-z])/g,
  },
];

// 반환: { text, removed: [{label, count}], total }
export function scrubPII(input) {
  let text = String(input || '');
  const removed = [];
  for (const rule of SCRUB_RULES) {
    const hits = text.match(rule.re);
    if (!hits || !hits.length) continue;
    text = text.replace(rule.re, '');
    removed.push({ label: rule.label, count: hits.length });
  }
  if (removed.length) {
    // 지운 자리에 생긴 겹공백·빈 괄호·떠다니는 구분자 정리
    text = text
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.·)\]])/g, '$1')
      .replace(/\n{3,}/g, '\n\n');
  }
  return { text, removed, total: removed.reduce((n, r) => n + r.count, 0) };
}

// 초안 카드에 붙일 한 줄. 걸린 게 없으면 빈 문자열.
export function scrubSummary(removed) {
  if (!removed?.length) return '';
  const total = removed.reduce((n, r) => n + r.count, 0);
  return `⚠️ 개인정보 ${total}건 자동 제거 (${removed.map((r) => `${r.label} ${r.count}`).join(', ')})`;
}

// 임시 작업 폴더(state/ 아래 — gitignore 되어 저장소에 안 들어간다)
export function stagingDir(base, id) {
  const d = path.join(base, 'capture', id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function cleanupStaging(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
}
