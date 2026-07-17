// 블로그 적합도 판단(v2.7): 각 키워드에 별점(★1~5)·한 줄 이유·위험 경고를 붙인다.
// v2.7 가점: 💪건강·🔬생활원리형 +1.25(수명·단가), 🔬과학지식형 +0.75. 가십·인물 실검 감점 유지.
// 완전 자동 발행이 아니라, 사람이 고르기 쉽게 '평가만' 제공한다. 대원칙 불변: 게시는 사람 승인만.
//
// 산출 요소(요구사항):
//  1) 경쟁도  — 문서수가 적을수록 가점(신생 사이트는 레드오션 불리)
//  2) 비율    — 검색÷문서가 높을수록 가점(틈새)
//  3) 검색의도 — 정보형(방법·뜻·기준·일정 …) 가점, 단순 가십·속보 감점
//  4) 계급    — 📅캘린더·🌲에버그린 가점(수명 김), 🔥실검 중 정치·인물 신변 감점
//  5) 지속성  — 한 달 뒤에도 검색될 주제면 가점

// 정보형 의도(방법·뜻·기준·일정 등) — 오래 읽히는 실용 정보
export const INFO =
  /방법|뜻|의미|기준|일정|얼마|언제|어떻게|왜|신청|조회|자격|요건|조건|계산|비교|후기|추천|가격|요금|비용|연납|환급|신고|납부|접종|예방|권장량|식단|증상|효능|정리|총정리|가이드|순위|목록|리스트|기간|마감|혜택|지원금|보조금|사용법|설정|차이|원리|흡수율|반감기/;

// 정치·인물 신변·미확인 사실(명예훼손·사실확인 부담) — 감점 + ⚠️ 경고
export const RISK =
  /대통령|장관|의원|국회|정당|여당|야당|정부|청와대|대선|총선|경선|나토|정상회담|외교|회담|사망|별세|부고|유서|자살|구속|피소|고소|기소|영장|검찰|경찰|수사|열애|결혼|이혼|불륜|폭행|음주운전|마약|성추행|성폭행|논란|저격|디스|하차|복귀|임신|출산|파경|폭로|사과|입장문|해명|의혹|갈등|공방|막말|설전/;

export function starBar(n) {
  const s = Math.max(1, Math.min(5, n | 0));
  return '★'.repeat(s) + '☆'.repeat(5 - s);
}

// 후보 c({keyword,source,gossip,label?}) + 네이버 지표 stat({vol,doc,ratio,…}) → 적합도.
// 반환: { stars(1~5), reason, warn(위험 여부) }
export function scoreKeyword(c, stat) {
  const text = c.source === 'calendar' ? c.label || c.keyword : c.keyword;
  const s = stat || {};
  let pts = 0; // 기준선 3점(→ ★3)에 가감

  // 3) 검색의도
  const info = INFO.test(text);
  const risky = !!c.gossip || RISK.test(text);
  let intentTag;
  if (info) {
    pts += 0.75;
    intentTag = '정보형';
  } else if (risky) {
    pts -= 1.5;
    intentTag = c.gossip ? '가십·속보' : '정치·속보';
  } else {
    intentTag = '일반';
  }

  // 4) 계급 + 5) 지속성(수명) — v2.7: 에버그린 원리+판단 중심으로 가중
  let tierTag;
  if (c.source === 'calendar') {
    pts += 1.25; // 선점 + 수명 김
    tierTag = '캘린더';
  } else if (c.source === 'evergreen') {
    pts += 1.25; // 한 달 뒤에도 검색됨
    tierTag = '에버그린';
  } else if (c.source === 'parking') {
    // 🅿️ 시설 주차 — 검색의도가 명확하고(요금·위치) 수명이 김. 유입 실측 근거로 신설.
    // ⚠️ 이 분기가 없으면 아래 else 로 떨어져 '실검'으로 오분류된다(실검은 폐지된 계급).
    pts += 1.25;
    tierTag = '주차';
  } else if (c.source === 'health') {
    pts += 1.25; // 💪 건강·영양·헬스 — 수명·단가 높음
    tierTag = '건강';
  } else if (c.source === 'science') {
    if (c.angle === 'knowledge') {
      pts += 0.75; // 🔬 과학지식형(자연·과학 원리) — 수명 길지만 단가 낮음
      tierTag = '과학지식';
    } else {
      pts += 1.25; // 🔬 생활원리형(가전 원리+요금/선택 판단) — 고단가
      tierTag = '생활원리';
    }
  } else {
    tierTag = '실검';
    if (risky) pts -= 0.75; // 인물 신변·정치는 언론사 경쟁·수명 짧음
    else if (info) pts += 0.25; // 실검이라도 정보형이면 어느 정도 지속
  }

  // 1) 경쟁도(블로그 문서수) — 적을수록 신생 사이트에 유리
  let compTag = '경쟁 미상';
  if (s.doc != null) {
    if (s.doc < 5000) {
      pts += 1;
      compTag = '경쟁 낮음';
    } else if (s.doc < 50000) {
      pts += 0.5;
      compTag = '경쟁 보통';
    } else if (s.doc < 300000) {
      compTag = '경쟁 다소 높음';
    } else {
      pts -= 1;
      compTag = '경쟁 심함';
    }
  }

  // 2) 비율(검색÷문서) — 높을수록 틈새
  if (s.ratio != null) {
    if (s.ratio >= 1) pts += 1;
    else if (s.ratio >= 0.3) pts += 0.5;
    else if (s.ratio < 0.1) pts -= 0.5;
  }

  const stars = Math.max(1, Math.min(5, Math.round(3 + pts)));
  const verdict =
    stars >= 4 ? '블로그로 적합' : stars === 3 ? '무난·선택 가능' : '발행 비추천';
  const reason = `${intentTag}·${tierTag}·${compTag}. ${verdict}`;

  return { stars, reason, warn: risky };
}

// 위험 주제 라벨(인물 신변·정치 갈등·미확인 사실)
export const WARN_LABEL = '⚠️ 사실확인 부담·명예훼손 주의';
