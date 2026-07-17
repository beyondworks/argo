// 스킬·MCP 마켓 — 카탈로그 + 원클릭 설치/제거. 설치는 워크스페이스 파일에 남아
// 스킬은 다음 턴 시스템 프롬프트에, MCP는 다음 턴 mcpServers에 자동 반영된다.
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { paths } from './workspace.mjs';

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
4. 그래도 막히고 셸 능력이 켜져 있으면 → \`curl -sL -A "Mozilla/5.0 (iPhone)"\` 모바일 UA로 재시도
5. 전부 막히면 → 어떤 경로를 시도했는지 명시하고, 사장에게 필요한 능력(웹 브라우징/셸)을 request_capability로 요청하거나 마켓의 브라우저 MCP(playwright) 설치를 제안한다

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
4. Still blocked and shell capability is on → retry with \`curl -sL -A "Mozilla/5.0 (iPhone)"\` (mobile UA)
5. If everything is blocked → state which routes you tried, then ask the captain via request_capability for the needed capability (web browsing/shell) or suggest installing the browser MCP (playwright) from the market

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

/* ─── 스킬 설치 상태 ─── */
export async function listInstalledSkills(wsId) {
  const dir = paths(wsId).skills;
  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    const text = await readFile(join(dir, n), 'utf8');
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
  process.env.ARGO_ALLOW_CUSTOM_MCP !== '1'
  && !!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.ARGO_TENANT_OWNER);
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
