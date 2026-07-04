// 사이트 전역에서 재사용하는 기본 정보들을 한 곳에 모아둔 파일입니다.
// 이름·설명을 바꾸고 싶으면 여기만 고치면 사이트 전체에 반영됩니다.

export const SITE = {
  /** 사이트 제목 (브라우저 탭, 검색결과 등에 표시) */
  title: 'All areas of expertise',
  /** 헤더에 제목과 함께 보이는 부제(태그라인) */
  tagline: '모든 정보가 모이는 곳',
  /** 사이트 한 줄 설명 (검색결과 스니펫, 메타 설명 기본값) */
  description:
    '정확하고, 정감이 넘치며, 모두에게 도움이 되는 정보만을 선별하여 여러분께 제공합니다.',
  /** 실제 도메인 (astro.config.mjs 의 site 와 동일하게 유지) */
  url: 'https://allexishere.com',
  /** 소유자/저자 이름 */
  author: 'All areas of expertise',
  /** 기본 대표 이미지 (OpenGraph 용, public/ 안에 위치) */
  defaultOgImage: '/og-default.png',
  /** 언어 */
  locale: 'ko_KR',
} as const;

/** Google AdSense 설정 */
export const ADSENSE = {
  /** 게시자 ID (ca-pub-...). 자동광고 스크립트와 ads.txt 에 사용 */
  publisherId: 'ca-pub-4175701831650134',
  /**
   * 수동 광고 '슬롯 ID' 3곳.
   * 애드센스 대시보드 → 광고 → '광고 단위 기준' 에서 디스플레이 광고를 만들면
   * data-ad-slot 숫자가 발급됩니다. 그 숫자를 아래에 채워 넣으세요.
   * (비워두면 광고 자리(회색 박스)만 잡히고 실제 광고는 안 나옵니다 — 나중에 채우면 됨)
   */
  slots: {
    /** 본문 제목 바로 아래 */
    top: '',
    /** 첫 번째 소제목(h2) 뒤 */
    inArticle: '',
    /** 본문 맨 끝 */
    bottom: '',
  },
} as const;

/**
 * 카테고리 정의. slug 는 스키마 검증·이전용으로만 쓰입니다(홈·글에는 노출 안 함).
 * 티스토리 원본은 여러 카테고리를 썼지만, 사용자 요청으로 단일 'info' 하나로 통합합니다.
 */
export const CATEGORIES = [
  {
    slug: 'info',
    name: '정보',
    description: '모든 정보가 모이는 곳',
  },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]['slug'];

/** slug 로 카테고리 정보를 찾는 도우미 함수 */
export function getCategory(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

/** 한 페이지에 보여줄 글 개수 (페이지네이션 단위) */
export const POSTS_PER_PAGE = 10;
