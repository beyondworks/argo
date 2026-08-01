// 스킬·MCP 마켓 — 카탈로그 + 원클릭 설치/제거. 설치는 워크스페이스 파일에 남아
// 스킬은 다음 턴 시스템 프롬프트에, MCP는 다음 턴 mcpServers에 자동 반영된다.
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { paths } from './workspace.mjs';
import { loadDeviceSession } from './devicesession.mjs'; // 기기 세션 = "사용자 본인 기기" 신호(호스팅 오분류 방지)
// 커넥터는 스킬·MCP와 같은 마켓 표면에 산다(설계서 §2-3) — 카탈로그·설치(=연결)·제거(=해제)가 한 자리.
// 코어(연결 왕복·토큰·도구 호출)는 connectors.mjs가 전담하고, 여기는 "카탈로그 항목 → 코어 인자" 변환만 한다.
import { startConnect, connectorMessage, isTlsOrLoopback } from './connectors.mjs';

/* ─── 스킬 카탈로그 — 지시형 md, 설치 = skills/<id>.md 복사 ─── */
export const SKILL_CATALOG = [
  {
    id: 'deep-research',
    title: '딥 리서치',
    desc: '막히면 우회하는 다단 폴백 웹 조사 — 교차 검증·출처 필수',
    md: `# 딥 리서치 스킬

웹 조사를 요청받으면 "찾을 수 없습니다"로 끝내지 않는다. 아래 사다리를 순서대로 탄다.

## 검색 사다리 (위가 막히면 아래로)
1. WebSearch — 쿼리를 2~3가지로 변형해 다각도 검색 (한국어+영어, 연도 포함/제외)
2. WebFetch — 유력 소스 원문을 직접 연다. 요약 결과만 믿지 않는다
3. 403·차단·로그인벽을 만나면 → 같은 URL 앞에 \`https://r.jina.ai/\`를 붙여 재시도 (리더 프록시)
4. 그래도 막히면 → \`curl -sL -A "Mozilla/5.0 (iPhone)"\` 모바일 UA로 재시도
5. 전부 막히면 → 어떤 경로를 시도했는지 명시하고, 사장에게 마켓의 브라우저 MCP(puppeteer) 설치를 제안한다

## 검증 규칙
- 수치·날짜·고유명사는 서로 다른 소스 2개 이상에서 교차 확인한다. 불일치하면 둘 다 표기
- 모든 주장에는 출처 URL을 붙인다. 출처 없는 문장은 "추정"으로 표기
- 오래된 정보 주의 — 문서의 발행일을 확인하고 결과에 기준 시점을 명시한다

## 산출 형식
- 핵심 결론 3줄 → 근거 불릿(출처 링크) → 미확인·반대 증거
- 재사용 가치가 있으면 vault/notes/에 주제 노트로 남기고 [[링크]]를 건다
`,
  },
  {
    id: 'newsletter-title',
    title: '뉴스레터 제목',
    desc: '모바일 잘림·낚시 방지 규칙이 있는 제목 작성 규격',
    md: `# 뉴스레터 제목 스킬\n\n뉴스레터 제목을 요청받으면 반드시 아래 규칙을 따른다.\n\n- 형식: \`[브랜드 한 단어] 제목 본문\` — 대괄호 프리픽스 필수\n- 길이: 한글 22자 이내 (모바일 프리뷰 잘림 방지)\n- 숫자를 하나 이상 포함한다 (예: 3가지, 12g)\n- 낚시 금지 — 본문이 실제로 답하는 약속만 한다\n`,
  },
  {
    id: 'ad-copy-qa',
    title: '광고 카피 QA',
    desc: '카피 제출 전 정책·소구·근거 자가 검수 체크리스트',
    md: `# 광고 카피 QA 스킬\n\n광고 카피를 제출하기 전 아래를 자가 검수하고, 결과를 체크리스트로 함께 보여준다.\n\n- [ ] 매체 정책 위반 표현 없음 (체중감량 약속·의학 효능·과장 보증 금지)\n- [ ] 소구 1개에 집중 (한 카피에 여러 약속 금지)\n- [ ] 약속에는 근거가 붙어 있다 (성분·숫자·리뷰)\n- [ ] 타깃이 3초 안에 자기 얘기로 인식할 훅인가\n- [ ] 글자수: 헤드라인 한글 20자 내외\n`,
  },
  {
    id: 'meeting-notes',
    title: '회의록 정리',
    desc: '결정·액션아이템·오너 중심의 회의록 표준 포맷',
    md: `# 회의록 정리 스킬\n\n회의 내용 정리를 요청받으면 아래 포맷을 따른다.\n\n## 결정된 것\n(불릿 — 결정 사항만, 논의 과정 제외)\n\n## 액션 아이템\n(체크박스 — \`- [ ] 할 일 — 담당자, 기한\`)\n\n## 보류·다음 논의\n(불릿)\n\n원문에 없는 결정을 만들어내지 않는다. 불명확하면 "미정"으로 표기한다.\n`,
  },
  {
    id: 'seo-outline',
    title: 'SEO 블로그 아웃라인',
    desc: '검색 의도 → H2/H3 구조 → 내부링크 제안까지',
    md: `# SEO 블로그 아웃라인 스킬\n\n블로그 글감을 받으면 본문을 쓰기 전에 아웃라인부터 만든다.\n\n1. 검색 의도 한 줄 정의 (정보형/비교형/구매형)\n2. 제목 3안 — 키워드 앞배치, 32자 이내\n3. H2 4~6개 + 각 H2 아래 H3 포인트\n4. 각 섹션에 넣을 근거(데이터·예시) 표기\n5. 회사 기억(vault)에서 연결할 만한 과거 글 [[링크]] 제안\n`,
  },
  {
    id: 'cold-email',
    title: '콜드메일 프레임',
    desc: '관찰→가치→증거→작은 CTA 4문단 콜드메일 규격',
    md: `# 콜드메일 스킬\n\n콜드메일 작성 시 4문단 프레임을 따른다. 전체 120단어 이내.\n\n1. 관찰 — 상대 회사의 구체적 사실 한 줄 (아부 금지)\n2. 가치 — 우리가 해결하는 문제를 상대 언어로 한 줄\n3. 증거 — 숫자 하나 (사례·성과)\n4. CTA — 작게 ("15분 통화" 말고 "자료 하나 보내드릴까요?")\n\n제목은 소문자 느낌의 짧은 구문, 스팸 단어(무료·긴급·최대) 금지.\n`,
  },
];

// 영어 시스템 언어(company.lang === 'en') 회사용 스킬 카탈로그 — SKILL_CATALOG와 동일 id의 미러.
// 설치 시 md 본문까지 영어로 내려간다. ko 회사(lang='ko' 또는 없음)는 이 객체를 절대 타지 않는다.
// 글자수 규격은 영어 매체 관례로 적응(한글 22자 → ~45 chars 등) — 직역이 아니라 같은 목적의 규격.
export const SKILL_CATALOG_EN = [
  {
    id: 'deep-research',
    title: 'Deep Research',
    desc: 'Multi-fallback web research that routes around blocks — cross-checking and sources required',
    md: `# Deep Research skill

When asked to research the web, never end with "I couldn't find it." Climb this ladder in order.

## Search ladder (blocked above → go below)
1. WebSearch — vary the query 2–3 ways for multiple angles (English + Korean, with/without the year)
2. WebFetch — open the primary sources directly. Don't trust summaries alone
3. On 403 / blocks / login walls → retry the same URL prefixed with \`https://r.jina.ai/\` (reader proxy)
4. Still blocked → retry with \`curl -sL -A "Mozilla/5.0 (iPhone)"\` (mobile UA)
5. If everything is blocked → state which routes you tried, then suggest installing the browser MCP (puppeteer) from the market

## Verification rules
- Cross-check numbers, dates, and proper nouns against 2+ independent sources. If they disagree, show both
- Attach a source URL to every claim. Sentences without a source are marked "Estimate"
- Beware stale info — check the publication date and state the as-of point in your results

## Output format
- 3-line key conclusion → evidence bullets (with source links) → unverified/counter-evidence
- If it's worth reusing, leave a topic note in vault/notes/ and add [[links]]
`,
  },
  {
    id: 'newsletter-title',
    title: 'Newsletter Titles',
    desc: 'Title-writing spec with mobile-truncation and no-clickbait rules',
    md: `# Newsletter Title skill\n\nWhen asked for a newsletter title, always follow these rules.\n\n- Format: \`[one-word brand] title body\` — the bracket prefix is required\n- Length: under 45 characters (avoids mobile preview truncation)\n- Include at least one number (e.g. 3 ways, 12g)\n- No clickbait — only promise what the body actually answers\n`,
  },
  {
    id: 'ad-copy-qa',
    title: 'Ad Copy QA',
    desc: 'Self-review checklist for policy, appeal, and evidence before submitting copy',
    md: `# Ad Copy QA skill\n\nBefore submitting ad copy, self-review the items below and show the results as a checklist.\n\n- [ ] No policy-violating claims (no weight-loss promises, medical efficacy, or exaggerated guarantees)\n- [ ] One appeal per copy (never multiple promises in one piece)\n- [ ] Every promise carries evidence (ingredient, number, review)\n- [ ] Does the hook read as "this is about me" to the target within 3 seconds\n- [ ] Length: headline around 40 characters\n`,
  },
  {
    id: 'meeting-notes',
    title: 'Meeting Notes',
    desc: 'Standard minutes format centered on decisions, action items, and owners',
    md: `# Meeting Notes skill\n\nWhen asked to organize meeting content, follow this format.\n\n## Decisions\n(bullets — decisions only, no discussion process)\n\n## Action items\n(checkboxes — \`- [ ] task — owner, due date\`)\n\n## Deferred / next discussion\n(bullets)\n\nNever invent decisions that aren't in the source. Mark unclear items "TBD".\n`,
  },
  {
    id: 'seo-outline',
    title: 'SEO Blog Outline',
    desc: 'From search intent → H2/H3 structure → internal link suggestions',
    md: `# SEO Blog Outline skill\n\nGiven a blog topic, build the outline before writing the body.\n\n1. Define the search intent in one line (informational/comparative/transactional)\n2. 3 title options — keyword up front, under 60 characters\n3. 4–6 H2s + H3 points under each H2\n4. Note the evidence (data, examples) to include per section\n5. Suggest past posts from company memory (vault) to connect with [[links]]\n`,
  },
  {
    id: 'cold-email',
    title: 'Cold Email Frame',
    desc: 'Observation → value → evidence → small CTA: a 4-paragraph cold email spec',
    md: `# Cold Email skill\n\nFollow the 4-paragraph frame for cold emails. Under 120 words total.\n\n1. Observation — one concrete fact about their company (no flattery)\n2. Value — the problem we solve, in their language, one line\n3. Evidence — one number (case, result)\n4. CTA — small (not "a 15-min call" but "want me to send one resource?")\n\nSubject line: a short lowercase-feel phrase; no spam words (free, urgent, best).\n`,
  },
];

/* ─── MCP 카탈로그 — 설치 = mcp.json에 서버 정의 추가 ─── */
export const MCP_CATALOG = [
  {
    id: 'sequential-thinking',
    title: 'Sequential Thinking',
    desc: '복잡한 문제를 단계적 사고로 푸는 공식 MCP',
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  },
  {
    id: 'memory',
    title: 'Knowledge Graph Memory',
    desc: '엔티티·관계 기반 지식 그래프 메모리 (공식)',
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    id: 'puppeteer',
    title: 'Puppeteer 브라우저',
    desc: '웹 페이지 탐색·스크린샷 (공식, 로컬 브라우저 사용)',
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
  },
];

// 영어 미러 — def는 언어 무관 동일값(중복이지만 구조 대칭 우선, PRESETS_EN 관례).
export const MCP_CATALOG_EN = [
  {
    id: 'sequential-thinking',
    title: 'Sequential Thinking',
    desc: 'Official MCP for solving complex problems with step-by-step thinking',
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  },
  {
    id: 'memory',
    title: 'Knowledge Graph Memory',
    desc: 'Entity/relation-based knowledge graph memory (official)',
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    id: 'puppeteer',
    title: 'Puppeteer Browser',
    desc: 'Web page browsing and screenshots (official, uses a local browser)',
    def: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
  },
];

/** 회사 언어 → 언어별 카탈로그. en에 없는 id는 ko 항목으로 폴백(presetFor와 동일 관례). */
export function skillCatalogFor(lang = 'ko') {
  if (lang !== 'en') return SKILL_CATALOG;
  return SKILL_CATALOG.map((s) => SKILL_CATALOG_EN.find((e) => e.id === s.id) || s);
}
export function mcpCatalogFor(lang = 'ko') {
  if (lang !== 'en') return MCP_CATALOG;
  return MCP_CATALOG.map((m) => MCP_CATALOG_EN.find((e) => e.id === m.id) || m);
}

/* ─── 커넥터 카탈로그 — kind:'connector' (설계서 §2-3, 스파이크 §④ US-2) ───
   항목 스키마:
     { id, name, url, scopes?: [], note, oauth?: { client_id, client_secret_env? }, dangerous?: [] }
   · url    = 원격 MCP 서버(스트리머블 HTTP). https 강제(loopback만 평문 예외 — OAuth 2.1, 코어와 같은 판정).
   · scopes = **연결 1회에 동의받을 합집합**. 도구마다 요구 scope가 갈리는 서버(구글: 도구별 PRM)에서
              중간 재동의를 막는 유일한 수단이다(스파이크 §② 특이점 2).
   · oauth  = **디스커버리 2모드**의 분기점(connectorMode):
              ① 표준 = 이 필드 없음 → SDK가 PRM(RFC 9728) 디스커버리 + DCR(RFC 7591)로 클라이언트를
                 스스로 등록한다. 카탈로그가 할 일이 없다.
              ② 고정 = client_id 기입 → SDK가 DCR을 건너뛴다(clientInformation 존재 시 registerClient
                 미호출 — 스파이크 §② 소스 실독). **DCR 미지원 서버**용이며, 구글 실측이 그 경우다
                 (accounts.google.com AS 메타데이터에 registration_endpoint 없음).
              두 모드는 같은 startConnect 경로로 수렴한다 — 코어에는 모드 개념이 없다.
              ※ 설계서·스파이크가 예비했던 `authorization_server`는 넣지 않는다: 코어(US-1)가 소비하지
                 않는 죽은 필드다. SDK는 AS를 PRM의 authorization_servers에서 스스로 찾는다(실측).
                 PRM을 발행하지 않는 서버를 등재하게 되는 시점에 **코어 지원과 함께** 추가한다.
   · dangerous = 결재 게이트(US-5)가 쓸 쓰기 도구 명시 목록. 서버 annotations가 1순위이고 이건 보완재다.

   ⚠ **client_secret 값은 이 파일에 절대 쓰지 않는다.** 이 레포는 public이라 소스에 박은 값은 번들
      추출 이전에 깃헙에 그대로 남는다("데스크톱 secret은 기밀이 아니다"라는 통설보다 노출면이 넓다 —
      분리 검수 F4). 대신 **환경변수 이름만**(`client_secret_env: 'GOOGLE_CONNECTOR_SECRET'`) 싣고
      값은 실행 환경에서 읽는다. 이름 규칙은 대문자·숫자·밑줄이며 테스트가 잠근다.

   **등재 순서 = 검증 순서다.** 실측(2026-08-01)으로 확인한 것만 싣는다:
   · 경로는 `/mcp/v1` — 호스트만 적혀 있던 스파이크 기록의 빈틈이었다(루트·/mcp는 404).
   · `tools/list`는 무인증 공개. Calendar 9 · Gmail 13 · Drive 8, **annotations 100%** 제공.
   · PRM은 **도구별**(`/.well-known/oauth-protected-resource/<tool>`)이고 `scopes_supported`는 택일이다.
     Calendar 9개 도구 전부에 `auth/calendar`가 들어 있어 **이 하나로 전 도구가 열린다** — scopes에
     합집합을 다 적으면 동의 화면만 무섭게 길어지고 얻는 게 없다.
   · Gmail·Drive는 뒤로 미룬다: 필요한 scope가 구글 '제한' 등급이라 프로덕션 게시에 CASA 보안 심사가
     붙는다(Calendar의 '민감' 등급은 검증만). Gmail은 발송 도구 자체가 없다(초안까지).
   검증 안 된 항목을 미리 실으면 화면에 "연결" 버튼이 생기고 누르면 실패한다 — 조용한 무동작보다 나쁘다. */
export const CONNECTOR_CATALOG = [
  {
    id: 'google-calendar',
    name: '구글 캘린더',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    // 택일 목록 중 전 도구를 덮는 하나만 — 나머지 7개는 이것의 부분집합이다(실측).
    scopes: ['https://www.googleapis.com/auth/calendar'],
    note: '일정 조회·검색·시간 제안은 바로, 생성·수정·삭제·참석 응답은 결재 후 실행됩니다.',
    // DCR 미지원(accounts.google.com AS 메타데이터에 registration_endpoint 없음) → 고정 모드 필수.
    // 값이 아니라 **이름**만 싣는다(F4) — 이 레포는 public이다.
    oauth: {
      client_id: '871799254033-m6keci1lbsheho954b4ib2kvn5al6osn.apps.googleusercontent.com',
      client_secret_env: 'ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET',
    },
    // 서버 annotations(readOnlyHint=false)가 1순위 판정이고 이건 그것이 비었을 때의 보완재다.
    // 실측 기준 이 4개가 쓰기다 — 목록이 어긋나면 테스트가 문다.
    dangerous: ['create_event', 'update_event', 'delete_event', 'respond_to_event'],
  },
];

// 영어 미러 — 등재 시 **같은 id·같은 url·같은 scopes**로 짝을 맞춘다(name·note만 언어별).
// 짝이 어긋나면 영어 회사가 다른 서버에 연결되므로, 그 규칙은 테스트가 잠근다(connector-catalog.test).
export const CONNECTOR_CATALOG_EN = [
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    scopes: ['https://www.googleapis.com/auth/calendar'],
    note: 'Reading, searching and time suggestions run right away; creating, updating, deleting and RSVPs run after your approval.',
    oauth: {
      client_id: '871799254033-m6keci1lbsheho954b4ib2kvn5al6osn.apps.googleusercontent.com',
      client_secret_env: 'ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET',
    },
    dangerous: ['create_event', 'update_event', 'delete_event', 'respond_to_event'],
  },
];

/** 회사 언어 → 언어별 커넥터 카탈로그. en에 없는 id는 ko 항목으로 폴백(skill/mcp와 동일 관례). */
export function connectorCatalogFor(lang = 'ko') {
  if (lang !== 'en') return CONNECTOR_CATALOG;
  return CONNECTOR_CATALOG.map((c) => CONNECTOR_CATALOG_EN.find((e) => e.id === c.id) || c);
}

/** 디스커버리 모드 — 'fixed'(사전 등록 client_id: DCR 미지원 서버) | 'standard'(PRM/DCR 자동). */
export const connectorMode = (item) => (item?.oauth?.client_id ? 'fixed' : 'standard');

const CONNECTOR_ID_RE = /^[a-z0-9-]{1,32}$/;
const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim());

/** 카탈로그 항목 검증(순수) — 위반 필드명 배열을 돌려준다(빈 배열 = 유효).
    등재 시점(테스트)에 걸러야 하는 것들이다: 잘못된 항목은 화면에 카드로 뜬 뒤 연결에서야 터진다. */
export function connectorCatalogItemErrors(item) {
  if (!item || typeof item !== 'object') return ['item'];
  const e = [];
  if (!CONNECTOR_ID_RE.test(item.id ?? '')) e.push('id'); // 영소문자·숫자·하이픈 1~32자(MCP 이름 규칙과 동일)
  if (typeof item.name !== 'string' || !item.name.trim()) e.push('name');
  if (typeof item.url !== 'string' || !isTlsOrLoopback(item.url)) e.push('url'); // 판정은 코어와 단일 출처
  if (item.note !== undefined && typeof item.note !== 'string') e.push('note');
  if (item.scopes !== undefined && !strList(item.scopes)) e.push('scopes');
  if (item.dangerous !== undefined && !strList(item.dangerous)) e.push('dangerous');
  if (item.oauth !== undefined) {
    const o = item.oauth;
    if (!o || typeof o !== 'object' || typeof o.client_id !== 'string' || !o.client_id.trim()) e.push('oauth.client_id');
    // 이름만 허용 — 값이 들어오면(공백·특수문자 포함 문자열) 규칙에서 걸린다. 소스에 secret 박기 방지.
    // 접두사로 반경을 좁힌다 — 이름 형태만 보면 DATABASE_URL·AWS_SECRET_ACCESS_KEY 같은 무관한 env가
    // 통과하고, 그 값이 원격 AS의 토큰 엔드포인트로 전송된다(분리 검수 D2 실측). F4가 "규율 대신
    // 구조"로 간 취지를 잇는다 — 커넥터 전용 이름공간만 허용.
    if (o?.client_secret_env !== undefined && !/^ARGO_CONNECTOR_[A-Z0-9_]{1,48}$/.test(o.client_secret_env)) e.push('oauth.client_secret_env');
    if (o?.client_secret !== undefined) e.push('oauth.client_secret'); // 값 필드는 아예 금지(이름 필드만)
  }
  return e;
}

/**
 * 카탈로그 항목 → `startConnect`가 받는 serverDef. 두 모드의 유일한 분기점이며, 여기서 나온 값은
 * 모드와 무관하게 같은 코어 경로로 들어간다.
 * **순수하지 않다**: 고정 모드의 client secret을 `process.env`에서 읽고, 이름만 있고 값이 없으면
 * 던진다(F4 — 소스에는 이름만 산다). 검증 실패도 던진다.
 */
export function connectorServerDef(item) {
  const bad = connectorCatalogItemErrors(item);
  if (bad.length) throw new Error(`커넥터 카탈로그 항목이 잘못되었습니다: ${bad.join(', ')}`);
  return {
    id: item.id,
    url: item.url,
    ...(item.scopes?.length ? { scopes: [...item.scopes] } : {}),
    ...(connectorMode(item) === 'fixed'
      ? { oauth: { client_id: item.oauth.client_id, ...resolveClientSecret(item.oauth) } }
      : {}),
  };
}

/** 카탈로그의 환경변수 **이름**을 실행 환경의 값으로 바꾼다 — 소스에는 이름만 산다(검수 F4).
    이름이 없으면 퍼블릭 클라이언트(PKCE만)로 간다. 이름은 있는데 값이 없으면 **조용히 퍼블릭으로
    넘어가지 않고** 배포 설정 오류로 실패시킨다 — 그 조합은 "secret이 필요한 서버인데 안 넣었다"는 뜻이고,
    조용히 넘어가면 벤더가 주는 모호한 401로만 드러난다(조용한 무동작 금지). */
function resolveClientSecret(oauth) {
  const name = oauth.client_secret_env;
  if (!name) return {};
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`커넥터 client secret 환경변수 ${name}가 설정되지 않았습니다`);
  return { client_secret: value };
}

/** 카탈로그 × 회사 연결 상태 병합(순수) — 설정 카드(US-6)가 그대로 그리는 목록. 시크릿은 애초에
    listConnections가 걸러 오므로 여기서 다시 새지 않는다.
    카탈로그에서 내려간 뒤에도 토큰이 남아 있는 연결은 **orphan으로 노출**한다 — 안 그리면 살아 있는
    토큰을 화면에서 해제할 방법이 사라진다(조용한 무동작 금지). */
export function mergeConnectorStatus(catalog = [], connections = []) {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const rows = catalog.map((item) => {
    const c = byId.get(item.id);
    byId.delete(item.id);
    return {
      id: item.id,
      name: item.name,
      note: item.note ?? '',
      status: c?.status ?? 'disconnected', // 저장 기록 없음 = 한 번도 연결한 적 없음
      hasTokens: !!c?.hasTokens,
      ...(item.scopes?.length ? { scopes: [...item.scopes] } : {}),
      ...(item.dangerous?.length ? { dangerous: [...item.dangerous] } : {}),
      ...(c?.errorCode ? { errorCode: c.errorCode } : {}),
      ...(c?.error ? { error: c.error } : {}),
    };
  });
  for (const c of byId.values()) {
    rows.push({ id: c.id, name: c.id, note: '', status: c.status, hasTokens: !!c.hasTokens, orphan: true, ...(c.errorCode ? { errorCode: c.errorCode } : {}) });
  }
  return rows;
}

/**
 * 카탈로그 항목 연결 시작 — installSkill/installMcp와 같은 자리·같은 형태(회사 + 카탈로그 id).
 * 반환 { ok, authUrl, done }: authUrl은 사용자 브라우저가 열 인가 URL(null = 인가 불요 서버),
 * done은 백그라운드 완료 프라미스(라우트는 기다리지 않는다 — 브라우저 인가에 최대 120초).
 * catalog 주입은 테스트·후속 등재 검증용 이음매다(기본값 = 회사 언어의 실카탈로그).
 */
export async function connectConnector(wsId, id, { lang = 'ko', catalog = connectorCatalogFor(lang), ...opts } = {}) {
  const item = catalog.find((c) => c.id === id);
  if (!item) throw new Error(connectorMessage('not_in_catalog', lang, String(id ?? '')));
  const { authUrl, done } = await startConnect(wsId, connectorServerDef(item), opts);
  done.catch(() => {}); // 완료는 저장소 상태로 관측한다(폴링) — 여기서 기다리면 응답이 인가 시간만큼 막힌다
  return { ok: true, authUrl, done };
}

/* ─── 스킬 설치 상태 ─── */
/** 스킬 주입 계획(순수) — full=본문 주입, ref=예산 초과로 참조만. 주입(loadSkills)과 마켓
    표기(market GET)가 **같은 규칙**을 공유한다 — 갈라지면 "설치됨인데 크루는 모른다"가 재발.
    (실사용 제보 2026-07-31의 최유력 원인: 이전 구현은 예산 초과 시 break — 큰 스킬 하나가
    이름순 앞에 오면 뒤의 모든 스킬이 통째로 미주입됐고, 화면은 '설치됨'이라 사장은 알 길이
    없었다. 원격 스킬은 200KB까지 설치되는데 예산은 6000자라 즉시 성립하던 조합.) */
export const SKILL_INJECT_CAP = 6000; // 주입·표기 공용 예산 — 한쪽만 바꾸면 배지가 거짓이 된다(검수 L2)
// ref 참조 라인 상한 — 초과분은 프롬프트에 **이름조차 안 들어간다**(omitted). 이 캡이 chat만 아는
// 값이면 마켓은 21번째부터 'ref'(참조 주입됨) 배지를 달아 거짓이 된다(검수 R2) — 계획에 포함해
// 주입과 표기가 같은 3상태(full/ref/omitted)를 본다. 상한 자체의 근거는 #203 M4(실측 501개=46KB 비대).
export const SKILL_REF_CAP = 20;
export function planSkillInjection(entries, cap = SKILL_INJECT_CAP, refCap = SKILL_REF_CAP) {
  let used = 0;
  const full = [];
  const ref = [];
  const omitted = []; // 이름조차 미주입 — 크루는 존재를 모른다(개수 요약 한 줄만 받는다)
  for (const e of entries) {
    if (used + e.size <= cap) { full.push(e.id); used += e.size; }
    else if (ref.length < refCap) ref.push(e.id); // break가 아니라 skip — 작은 스킬은 뒤에 있어도 산다
    else omitted.push(e.id);
  }
  return { full, ref, omitted };
}

export async function listInstalledSkills(wsId) {
  const dir = paths(wsId).skills;
  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    // 항목별 관용 — #203이 턴 경로(loadSkills, 검수 M3)만 닫은 창의 마켓 대칭: 디렉터리(EISDIR)·
    // 권한(EACCES) 항목 하나가 여기서 throw하면 마켓 GET 전체가 500(검수 라이브 확인). 건너뛴다.
    const text = await readFile(join(dir, n), 'utf8').catch(() => null);
    if (text === null) continue;
    out.push({
      id: n.replace(/\.md$/, ''),
      title: text.match(/^#\s*(.+)$/m)?.[1] ?? n,
      size: text.length,
    });
  }
  return out;
}

export async function installSkill(wsId, id, lang = 'ko') {
  const item = skillCatalogFor(lang).find((s) => s.id === id);
  if (!item) throw new Error('카탈로그에 없는 스킬입니다');
  await mkdir(paths(wsId).skills, { recursive: true });
  await writeFile(join(paths(wsId).skills, `${id}.md`), item.md);
}

/** 공방 — 사장이 직접 쓰는 스킬(업무 매뉴얼 한 장). skills/에 저장돼 기존 주입·목록 파이프라인을 그대로 탄다.
    4000자 캡 — loadSkills 총 주입 상한(6000) 안에서 한 스킬이 전부를 먹지 않게. */
export async function saveCustomSkill(wsId, { name, md }) {
  const title = String(name ?? '').trim().slice(0, 40);
  const body = String(md ?? '').trim();
  if (!title || !body) throw new Error('스킬 이름과 지시 내용이 필요합니다');
  const slug = title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill';
  await mkdir(paths(wsId).skills, { recursive: true });
  const text = body.startsWith('#') ? body : `# ${title}\n\n${body}`;
  await writeFile(join(paths(wsId).skills, `custom-${slug}.md`), `${text.slice(0, 4000)}\n`);
  return { id: `custom-${slug}` };
}

export async function removeSkill(wsId, id) {
  const safe = id.replace(/[^a-z0-9가-힣-]/gi, '');
  await rm(join(paths(wsId).skills, `${safe}.md`), { force: true });
}

/* ─── MCP 설정 (mcp.json) ─── */
export async function loadMcp(wsId) {
  try { return JSON.parse(await readFile(paths(wsId).mcp, 'utf8')); } catch { return { servers: {} }; }
}

async function saveMcp(wsId, cfg) {
  await writeFile(paths(wsId).mcp, JSON.stringify(cfg, null, 2));
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;

/** 호스팅(멀티테넌트 워커) 감지 — 프로세스에 크로스테넌트 크라운주얼(서비스 키)이 있거나 테넌트 바인딩이면
   임의 코드 실행형 MCP(사용자 정의 command·원격 npm)를 막는다. 로컬(자기 PC) 앱만 유지. 명시 opt-in으로 해제.
   근거(P0-2): 임의 프로세스를 서비스 키 곁에서 돌리면 env·/proc로 키가 유출돼 전 테넌트 데이터가 뚫린다.
   카탈로그(installMcp)의 검증된 공식 MCP는 계속 허용한다. (export: 회귀 테스트용) */
export const arbitraryMcpBlocked = () =>
  // ARGO_TENANT_OWNER(멀티테넌트 바인딩)는 무엇으로도 못 여는 하드 차단 — standalone·opt-in belt가 들어올리지 못한다.
  // runners.mjs startClaudeSetupToken와 동일 불변식("호스팅 런타임에 ARGO_STANDALONE=1이 실수로 새어들어도 다중테넌트에선 재개방 금지").
  // 이 게이트가 지키는 능력(임의 프로세스 spawn = 서비스 키 곁 유출→전 테넌트 침해)이 더 상위라 방어도 최소한 대칭이어야 한다(검수 HIGH).
  !!process.env.ARGO_TENANT_OWNER
  || (process.env.ARGO_STANDALONE !== '1' // 데스크톱 사이드카 = 로컬·단일사용자 앱 → 서비스 키가 env로 새어들어도 안 막는 벨트(사이드카는 키를 안 받지만 회귀 방어)
      && process.env.ARGO_ALLOW_CUSTOM_MCP !== '1'
      // 기기 세션 파일 존재 = 사용자 본인이 로그인한 기기(상주 :3001 포함) — 데스크톱과 같은 신뢰로 허용.
      // 실사고(2026-07-25): 유건 본인 맥의 상주가 서비스 키 보유만으로 "호스팅(원격)"으로 오분류돼 host
      // 가져오기가 막힘. 근거: ① 러너 자식(Bash/MCP)은 sdkEnvFor가 항상 세척 env를 줘 서비스 키를 상속하지
      // 않는다(P1-6 완료 — env 유출 벡터 폐쇄) ② 기기 세션 파일은 워커·호스티드 웹엔 존재하지 않는다.
      // 진짜 멀티테넌트(TENANT)는 위 하드 차단이 그대로 막는다.
      && !loadDeviceSession()
      && !!process.env.SUPABASE_SERVICE_ROLE_KEY);
export function assertArbitraryMcpAllowed() {
  if (arbitraryMcpBlocked()) {
    throw new Error('호스팅 모드에서는 임의 명령을 실행하는 사용자 정의·원격 MCP를 추가할 수 없습니다 — 보안상 로컬 앱에서만 지원됩니다(카탈로그의 검증된 MCP는 사용 가능).');
  }
}

export async function installMcp(wsId, id) {
  const item = MCP_CATALOG.find((s) => s.id === id);
  if (!item) throw new Error('카탈로그에 없는 MCP입니다');
  const cfg = await loadMcp(wsId);
  cfg.servers[item.id] = item.def;
  await saveMcp(wsId, cfg);
}

/** 커스텀 MCP — command/args만 허용, env 평문 시크릿은 받지 않는다(참조는 P1 서버측에서). */
export async function addCustomMcp(wsId, { name, command, args = [] }) {
  assertArbitraryMcpAllowed(); // 호스팅 모드 차단(P0-2) — 임의 command 프로세스가 서비스 키 곁에서 실행되는 것 방지
  if (!NAME_RE.test(name || '')) throw new Error('이름은 영소문자·숫자·하이픈 1~32자');
  if (!command?.trim()) throw new Error('command가 필요합니다');
  const cfg = await loadMcp(wsId);
  cfg.servers[name] = { command: command.trim(), args: args.filter((a) => a?.trim()).map((a) => a.trim()) };
  await saveMcp(wsId, cfg);
}

export async function removeMcp(wsId, name) {
  const cfg = await loadMcp(wsId);
  delete cfg.servers[name];
  await saveMcp(wsId, cfg);
}

/* ─── 호스트(이 컴퓨터) Claude Code MCP 가져오기 — 로컬 앱 전용 ───
   "이 컴퓨터에 이미 연결된 도구를 회사에서도 그대로" — 사용자가 Claude Code에 등록해 둔
   MCP(user 스코프, ~/.claude.json mcpServers)를 env(토큰)까지 복사해 회사 mcp.json에 넣는다.
   보안: ① 호스팅(멀티테넌트)에선 assertArbitraryMcpAllowed가 차단(임의 command 실행 클래스)
   ② env가 회사 mcp.json에 들어가므로 mcp.json은 시크릿 봉투(secretbox) 대상 — 동기화 시 암호문. */
export async function listHostMcp() {
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8'));
    return Object.entries(cfg.mcpServers ?? {})
      .filter(([, s]) => s && typeof s === 'object')
      .map(([name, s]) => ({
        name,
        type: s.type ?? (s.command ? 'stdio' : s.url ? 'http' : 'unknown'),
        // 표시용 요약 — command/url만. env 값은 절대 내보내지 않는다(마스킹 규칙).
        summary: String(s.command ?? s.url ?? '').slice(0, 80),
        hasEnv: !!(s.env && Object.keys(s.env).length),
      }));
  } catch { return []; } // 파일 없음/손상 = 가져올 것 없음
}

/* ─── 런타임 실행 게이트 — 호스팅(멀티테넌트 워커)에서 임의 command MCP를 spawn하지 않는다 ───
   추가(add) 게이트만으로는 부족하다: mcp.json이 봉투로 동기화되므로, 로컬에서 넣은 임의 command가
   서비스 키를 든 워커로 흘러가 실행되면 전 테넌트가 뚫린다(검수 HIGH). 그래서 실행 직전에도 거른다.
   - 로컬(자기 PC) 앱: 전부 실행 허용(사용자 자신의 환경).
   - 호스팅 모드: 로컬 프로세스를 spawn하는 stdio(command) 서버는 카탈로그의 검증된 command만 허용.
     원격(url/http) 서버는 로컬 프로세스가 없어 그 클래스의 위험이 없으므로 통과. */
export function safeMcpServersForRuntime(servers = {}) {
  if (!arbitraryMcpBlocked()) return servers; // 로컬 앱 — 제한 없음
  const okCommands = new Set(MCP_CATALOG.map((s) => `${s.def?.command} ${(s.def?.args ?? []).join(' ')}`.trim()));
  const out = {};
  for (const [name, def] of Object.entries(servers)) {
    if (!def?.command) { out[name] = def; continue; } // url/http 원격 — 로컬 spawn 없음, 허용
    const sig = `${def.command} ${(def.args ?? []).join(' ')}`.trim();
    if (okCommands.has(sig)) out[name] = def; // 카탈로그의 검증된 command만
    else console.warn(`[argo] 호스팅 모드 — 미검증 command MCP 실행 차단: ${name}`);
  }
  return out;
}

export async function importHostMcp(wsId, name) {
  assertArbitraryMcpAllowed(); // 호스팅 모드 차단 — 임의 프로세스가 서비스 키 곁에서 도는 것 방지
  let cfg;
  try { cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8')); }
  catch { throw new Error('이 컴퓨터의 Claude Code 설정(~/.claude.json)을 읽을 수 없습니다'); }
  const src = cfg.mcpServers?.[name];
  if (!src || typeof src !== 'object') throw new Error(`이 컴퓨터의 Claude Code에 "${name}" MCP가 없습니다`);
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!NAME_RE.test(safe)) throw new Error('가져올 수 없는 이름입니다');
  const company = await loadMcp(wsId);
  // 설정 원형 보존(command/args/env/type/url/headers) — SDK mcpServers가 그대로 먹는 형태
  company.servers[safe] = JSON.parse(JSON.stringify(src));
  await saveMcp(wsId, company);
  return { name: safe, hasEnv: !!(src.env && Object.keys(src.env).length) };
}
