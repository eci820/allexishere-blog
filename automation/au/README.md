# AU 자동화 (allexishere-au) — 봇 확장 모듈

이 디렉토리는 **호주 사이트(`allexishere-au`) 자동화**를 기존 한국 텔레그램 봇에 얹는
코드다. 봇 프로세스는 한국 저장소(`allexishere-blog/automation/bot.mjs`)에서 돌지만,
**AU 글은 `~/Projects/allexishere-au` 에 쓴다.** 두 저장소·두 사이트는 완전히 독립이다.

## 🔴 절대 규칙

- **한국 무영향**: 한국 명령·카드·에이전트·발행 경로를 건드리지 않는다.
  한국 파일 수정은 `bot.mjs`(additive 라우팅) + `lib/capture.mjs`(RESERVED 에 'au') 둘뿐.
- **크로스 저장소 하드가드**: AU 쓰기·git 은 전부 `au-guard.mjs` 로 경로를 검증한다.
  AU 함수가 한국 경로를 건드리면 즉시 throw(fail-loud). 검증은 `test-au-guard.mjs`.
- **커밋 위생**: `git add -A` 금지. 저장소별 명시적 add. push 전 `git status`.
- **구독 CLI 전용**: `ANTHROPIC_API_KEY` 사용 금지(`subscriptionEnv` 재사용).
- **지어내기 금지**: 요금·규정·시간은 호주 공식 출처 기반만. 확인 못 하면
  `unverified — check the official source`. 숫자엔 출처 URL + last updated.

## 계약

- 에이전트 계약: `~/.claude/skills/allexishere-agent-contract/SKILL.md` (§1–9 전 항목 준수)
- 안전 원칙: `~/.claude/skills/safe-automation-ops/SKILL.md`
- 사이트 운영: `~/.claude/skills/allexishere-ops/SKILL.md`

## 구성 (구현 순서)

1. `au-guard.mjs` — 크로스 저장소 경로 가드 + `test-au-guard.mjs`(negative test)
2. `au-pool.mjs` — 주제 풀(시설+속성+수식어, 축B 토픽), subject 단위 dedup
3. `au-title-rules.mjs` — 영어 pain-point 축 + 제목↔본문 검증
4. `au-generate.mjs` — 공식 출처 fetch → CLI 1회 → AU repo 에 draft:true
5. `au-publish.mjs` — 자체 락 → draft:false → 명시적 git add → commit → push (cwd:AU_ROOT)
6. `au-briefing.mjs` — 매일 11:00 영어 카드로 1~2편 제안(launchd 별도 잡)
7. `au-callbacks.mjs` — `au*` 콜백 라우터
8. `au-analyst.mjs` / `au-seo.mjs` — [E] 구조만·dry-run(데이터 성숙 전 추세 제안 끔)

## 🔴 구현 시 반드시 지킬 보완점 (사용자 지시)

### 보완 1 — fetch 성공 ≠ 내용 확보 (au-generate.mjs)
HTTP 200 이어도 **본문이 비었거나 JS 렌더링이라 의미 있는 텍스트가 없으면 "실패"로
처리**한다. fetch 실패만 다루면 안 된다.
- 판정 기준: 추출 텍스트 길이(예: 최소 글자 수) + 핵심 키워드 유무.
- 실패면 그 사실은 `unverified` 로 남기고 초안 카드에 "source X: 내용 미확보" 표시.
- 근거(실측 사고): 네이버 지도 요금 페이지가 HTTP 200 이지만 JS 렌더링이라 추출 도구가
  없는 요금표를 **지어낸** 사고가 있었다. 호주 공식 사이트도 같을 수 있다.

### 보완 2 — AU 에이전트용 GSC 권한 (au-analyst.mjs / au-seo.mjs)
au-analyst/au-seo 를 **나중에 켤 때** 한국 GSC 서비스계정을 **`au.allexishere.com` 속성에도
추가**해야 데이터를 읽을 수 있다. 이 선행조건을 잊으면 에이전트가 빈 데이터로 돈다.
→ 두 파일 상단 주석 + 이 README 에 기록. 스케줄 등록은 데이터가 쌓인 뒤 사용자 지시로.

## 발행 정책 (승인됨)

- 브리핑 **2편/day 제안**, 하드캡 `publishCap.perDay = 2`, 사람 승인 **1편/day** 권장.
- 근거: 신규 도메인·권위 0. 급증은 신뢰·색인에 역효과. 상위 5편을 1~2주에 걸쳐.
- 우선순위는 **검색량 실측이 아니라** "빈틈/에버그린/검증가능/제로클릭 방어" 4기준 판단.
  GSC 노출이 쌓이면 au-seo/au-analyst 가 재조정 후보 제시(데이터 성숙 후).
