// 스킬·MCP 마켓 — 카탈로그 + 원클릭 설치/제거. 설치는 워크스페이스 파일에 남아
// 스킬은 다음 턴 시스템 프롬프트에, MCP는 다음 턴 mcpServers에 자동 반영된다.
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

export async function installSkill(wsId, id) {
  const item = SKILL_CATALOG.find((s) => s.id === id);
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

export async function installMcp(wsId, id) {
  const item = MCP_CATALOG.find((s) => s.id === id);
  if (!item) throw new Error('카탈로그에 없는 MCP입니다');
  const cfg = await loadMcp(wsId);
  cfg.servers[item.id] = item.def;
  await saveMcp(wsId, cfg);
}

/** 커스텀 MCP — command/args만 허용, env 평문 시크릿은 받지 않는다(참조는 P1 서버측에서). */
export async function addCustomMcp(wsId, { name, command, args = [] }) {
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
