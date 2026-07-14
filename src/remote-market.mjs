// 원격 마켓 연동 — skillsmp.com(스킬)·공식 MCP 레지스트리(도구)를 검색하고 즉시 설치한다.
// 링크 이동 없음: 스킬은 GitHub raw에서 md를 받아 skills/에, MCP는 mcp.json에 바로 심는다.
// 외부 실패 시 조용히 빈 결과 + 오류 메시지(내장 카탈로그는 항상 동작).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { loadMcp, assertArbitraryMcpAllowed } from './market.mjs';

const TTL = 10 * 60 * 1000;
const cache = new Map(); // key → {at, data}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'argo-market/0.1' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`원격 응답 ${res.status}`);
  return res.json();
}

/* ─── 스킬: skillsmp.com ─── */
export async function searchRemoteSkills(q) {
  return cached(`sk:${q}`, async () => {
    const d = await fetchJson(`https://skillsmp.com/api/skills?search=${encodeURIComponent(q)}`);
    return (d.skills ?? []).slice(0, 12).map((s) => ({
      id: s.id,
      name: s.name,
      author: s.author,
      desc: (s.description ?? '').slice(0, 160),
      stars: s.stars ?? 0,
      githubUrl: s.githubUrl,
    }));
  });
}

/** GitHub tree/blob URL → raw SKILL.md 후보들. */
function rawCandidates(githubUrl) {
  const m = String(githubUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(tree|blob)\/([^/]+)\/(.+)$/);
  if (!m) {
    const root = String(githubUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (root) return ['main', 'master'].map((b) => `https://raw.githubusercontent.com/${root[1]}/${root[2]}/${b}/SKILL.md`);
    return [];
  }
  const [, owner, repo, kind, branch, path] = m;
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  if (kind === 'blob' || path.endsWith('.md')) return [`${base}/${path}`];
  return [`${base}/${path}/SKILL.md`, `${base}/${path}.md`, `${base}/${path}/README.md`];
}

export async function installRemoteSkill(wsId, { name, githubUrl }) {
  const safe = String(name ?? '').toLowerCase().replace(/[^a-z0-9가-힣-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!safe) throw new Error('스킬 이름이 없습니다');
  let md = null;
  for (const url of rawCandidates(githubUrl)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 200_000) throw new Error('스킬 파일이 너무 큽니다(200KB 초과)');
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) continue;
      md = `<!-- source: ${githubUrl} -->\n\n${text}`;
      break;
    } catch { /* 다음 후보 */ }
  }
  if (!md) throw new Error('SKILL.md를 찾지 못했습니다 — 저장소 구조가 표준과 다릅니다');
  await mkdir(paths(wsId).skills, { recursive: true });
  await writeFile(join(paths(wsId).skills, `${safe}.md`), md);
  return { id: safe };
}

/* ─── MCP: 공식 레지스트리 ─── */
export async function searchRemoteMcp(q) {
  return cached(`mcp:${q}`, async () => {
    const d = await fetchJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(q)}&limit=30`);
    const seen = new Set();
    const out = [];
    for (const item of d.servers ?? []) {
      const sv = item.server ?? {};
      if (seen.has(sv.name)) continue;
      seen.add(sv.name);
      // 즉시 설치 가능한 형태만: npm 패키지(→ npx stdio) 또는 streamable-http 원격
      const npm = (sv.packages ?? []).find((p) => p.registryType === 'npm');
      const remote = (sv.remotes ?? []).find((r) => r.type === 'streamable-http');
      if (!npm && !remote) continue;
      out.push({
        name: sv.name,
        title: sv.title || sv.name.split('/').pop(),
        desc: (sv.description ?? '').slice(0, 160),
        install: npm ? { kind: 'npm', pkg: npm.identifier } : { kind: 'http', url: remote.url },
      });
      if (out.length >= 12) break;
    }
    return out;
  });
}

export async function installRemoteMcp(wsId, { name, install }) {
  const safe = String(name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!safe) throw new Error('MCP 이름이 없습니다');
  let def;
  if (install?.kind === 'npm' && install.pkg) {
    assertArbitraryMcpAllowed(); // npm MCP = npx로 로컬 임의 코드 실행 → 호스팅 차단(P0-2). http(원격)은 로컬 실행 없어 허용
    def = { command: 'npx', args: ['-y', install.pkg] };
  } else if (install?.kind === 'http' && /^https:\/\//.test(install.url ?? '')) {
    def = { type: 'http', url: install.url };
  } else {
    throw new Error('설치 가능한 배포 형태(npm/http)가 아닙니다');
  }
  const cfg = await loadMcp(wsId);
  cfg.servers[safe] = def;
  await writeFile(paths(wsId).mcp, JSON.stringify(cfg, null, 2));
  return { name: safe };
}

/* ─── 추천 TOP 20 ─── */

/** 스킬 TOP 20 — skillsmp 스타순(인기순). 다운로드 수는 미제공이라 ★로 정직 표기.
    같은 저장소가 상위를 도배하지 않게 저자당 최대 2개로 다양화한다. */
export async function topRemoteSkills() {
  return cached('top:skills', async () => {
    // 스타순 상위 수천 행이 소수 메가 저장소 소속이라(실측 6팀), 하이브리드로 다양화한다:
    // ① 스타순 풀(저자당 2개) ② 인기 카테고리 검색의 상위 스타 결과로 나머지를 채움
    const TERMS = ['writing', 'marketing', 'seo', 'research', 'automation', 'design', 'data', 'email', 'video', 'review'];
    const [starPages, termResults] = await Promise.all([
      Promise.allSettled([1, 2].map((p) => fetchJson(`https://skillsmp.com/api/skills?sortBy=stars&limit=100&page=${p}`))),
      Promise.allSettled(TERMS.map((t) => fetchJson(`https://skillsmp.com/api/skills?search=${t}&sortBy=stars&limit=6`))),
    ]);
    const pool = [
      ...starPages.flatMap((p) => (p.status === 'fulfilled' ? p.value.skills ?? [] : [])),
      ...termResults.flatMap((p) => (p.status === 'fulfilled' ? p.value.skills ?? [] : [])),
    ].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));

    const perAuthor = new Map();
    const seen = new Set();
    const out = [];
    for (const s of pool) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const n = perAuthor.get(s.author) ?? 0;
      if (n >= 2) continue;
      perAuthor.set(s.author, n + 1);
      out.push({
        id: s.id, name: s.name, author: s.author,
        desc: (s.description ?? '').slice(0, 140),
        stars: s.stars ?? 0, githubUrl: s.githubUrl,
      });
      if (out.length >= 20) break;
    }
    return out;
  });
}

/** MCP 후보 — 널리 쓰이는 npm 패키지 큐레이션. 랭킹은 npm 주간 다운로드 실측. */
const MCP_TOP_CANDIDATES = [
  { pkg: '@playwright/mcp', title: 'Playwright 브라우저', desc: '웹 페이지 열기·클릭·입력·스크린샷 — 크루에게 브라우저를 쥐여줍니다' },
  { pkg: '@modelcontextprotocol/server-filesystem', title: 'Filesystem', desc: '지정 폴더의 파일 읽기·쓰기 (경로 지정 필요)' },
  { pkg: '@modelcontextprotocol/server-memory', title: 'Knowledge Graph Memory', desc: '엔티티·관계 기반 지식 그래프 메모리 (공식)' },
  { pkg: '@modelcontextprotocol/server-sequential-thinking', title: 'Sequential Thinking', desc: '복잡한 문제를 단계적 사고로 풀게 하는 공식 MCP' },
  { pkg: '@modelcontextprotocol/server-puppeteer', title: 'Puppeteer 브라우저', desc: '웹 페이지 탐색·스크린샷 (공식, 로컬 브라우저)' },
  { pkg: '@modelcontextprotocol/server-brave-search', title: 'Brave 웹 검색', desc: '실시간 웹 검색', needsKey: true },
  { pkg: '@modelcontextprotocol/server-slack', title: 'Slack', desc: '슬랙 채널 읽기·메시지 전송', needsKey: true },
  { pkg: '@modelcontextprotocol/server-github', title: 'GitHub', desc: '저장소·이슈·PR 조회와 조작', needsKey: true },
  { pkg: '@modelcontextprotocol/server-postgres', title: 'PostgreSQL', desc: 'DB 스키마 조회·읽기 쿼리', needsKey: true },
  { pkg: '@modelcontextprotocol/server-google-maps', title: 'Google Maps', desc: '장소 검색·경로·좌표', needsKey: true },
  { pkg: '@notionhq/notion-mcp-server', title: 'Notion', desc: '노션 페이지·DB 읽기와 작성', needsKey: true },
  { pkg: '@supabase/mcp-server-supabase', title: 'Supabase', desc: '수파베이스 프로젝트·DB 관리', needsKey: true },
  { pkg: '@upstash/context7-mcp', title: 'Context7 문서', desc: '라이브러리 최신 공식 문서를 답변에 주입' },
  { pkg: 'firecrawl-mcp', title: 'Firecrawl 크롤링', desc: '웹사이트를 통째로 긁어 마크다운으로', needsKey: true },
  { pkg: 'tavily-mcp', title: 'Tavily 검색', desc: 'AI 특화 웹 검색·리서치', needsKey: true },
  { pkg: 'exa-mcp-server', title: 'Exa 검색', desc: '시맨틱 웹 검색', needsKey: true },
  { pkg: '@browserbasehq/mcp', title: 'Browserbase', desc: '클라우드 브라우저 세션', needsKey: true },
  { pkg: '@executeautomation/playwright-mcp-server', title: 'Playwright (커뮤니티)', desc: '브라우저 자동화 + API 테스트' },
  { pkg: 'chrome-devtools-mcp', title: 'Chrome DevTools', desc: '실행 중인 크롬을 개발자도구로 제어' },
  { pkg: '@stripe/mcp', title: 'Stripe', desc: '결제·고객·인보이스 조회', needsKey: true },
  { pkg: '@sentry/mcp-server', title: 'Sentry', desc: '에러·이슈 모니터링 조회', needsKey: true },
  { pkg: 'airtable-mcp-server', title: 'Airtable', desc: '에어테이블 베이스 읽기·쓰기', needsKey: true },
  { pkg: 'mcp-server-kubernetes', title: 'Kubernetes', desc: '클러스터 조회·관리' },
  { pkg: '@elastic/mcp-server-elasticsearch', title: 'Elasticsearch', desc: '검색 인덱스 질의', needsKey: true },
];

/** MCP TOP 20 — npm 주간 다운로드로 실측 랭킹. */
export async function topRemoteMcp() {
  return cached('top:mcp', async () => {
    const results = await Promise.allSettled(
      MCP_TOP_CANDIDATES.map(async (c) => {
        const d = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(c.pkg)}`);
        return { ...c, downloads: d.downloads ?? 0 };
      })
    );
    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value)
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, 20)
      .map((c) => ({
        name: c.pkg.replace(/^@/, '').replace(/\//g, '-'),
        title: c.title, desc: c.desc, downloads: c.downloads, needsKey: !!c.needsKey,
        install: { kind: 'npm', pkg: c.pkg },
      }));
  });
}

/* ─── 한글 easy 설명 — Haiku 1턴 생성, 메모리+디스크 캐시(재시작에도 유지) ─── */
import { WS_ROOT } from './workspace.mjs';
const explainCache = new Map();
const EXPLAIN_FILE = join(WS_ROOT, '.cache', 'explain.json');
let diskLoaded = false;

async function loadExplainDisk() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const { readFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(EXPLAIN_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) explainCache.set(k, v);
  } catch { /* 첫 실행 */ }
}

async function saveExplainDisk() {
  try {
    await mkdir(join(WS_ROOT, '.cache'), { recursive: true });
    await writeFile(EXPLAIN_FILE, JSON.stringify(Object.fromEntries(explainCache)));
  } catch { /* 캐시 실패는 치명적이지 않다 */ }
}

async function fetchSkillRaw(githubUrl) {
  for (const url of rawCandidates(githubUrl)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) continue;
      return text;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

export async function explainItem(item) {
  const key = `${item.kind}:${item.name ?? item.title}`;
  await loadExplainDisk();
  if (explainCache.has(key)) return explainCache.get(key);

  let raw = null;
  if (item.kind === 'skill' && item.githubUrl) raw = await fetchSkillRaw(item.githubUrl);

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const prompt = `너는 어려운 개발 도구를 비전문가 사장님에게 설명하는 안내자다.
아래 항목을 읽고, 정확히 JSON 하나만 출력해(코드펜스·설명 금지):

{"what":"이게 뭔지 한 문장 — 비유를 써서 아주 쉽게","when":["이럴 때 쓰세요 — 구체적 상황 2~3개"],"examples":["크루에게 이렇게 말해보세요 — 바로 복사해 쓸 실제 지시문 2~3개"],"caution":"주의할 점 한 줄 (없으면 빈 문자열)"}

전부 한국어 존댓말, 전문용어는 풀어서. examples는 이 도구가 실제로 발동될 만한 자연스러운 한국어 지시문으로.

## 항목
종류: ${item.kind === 'skill' ? '스킬(작업 지침서)' : 'MCP 도구(외부 연결)'}
이름: ${item.title ?? item.name}
설명: ${item.desc ?? ''}
${raw ? `원문(일부):\n${raw.slice(0, 2500)}` : ''}`;

  let out = '';
  for await (const msg of query({
    prompt,
    options: { allowedTools: [], settingSources: [], maxTurns: 1, model: 'claude-haiku-4-5-20251001' }, // 설명 생성은 Haiku면 충분 — 속도 우선
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result;
  }
  const jsonText = out.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let easy;
  try {
    easy = JSON.parse(jsonText);
  } catch {
    easy = { what: jsonText.slice(0, 200), when: [], examples: [], caution: '' };
  }
  const result = { easy, raw: raw ? raw.slice(0, 2000) : null };
  explainCache.set(key, result);
  saveExplainDisk(); // 비동기 — 응답을 막지 않는다
  return result;
}

/* ─── 프리워밍 — TOP 목록 로드 시 백그라운드로 설명을 미리 생성(동시 2, 평생 1회) ─── */
const warmingKinds = new Set();

export function warmExplains(items, kind) {
  if (warmingKinds.has(kind)) return;
  warmingKinds.add(kind);
  (async () => {
    await loadExplainDisk();
    const todo = items.filter((i) => !explainCache.has(`${kind}:${i.name ?? i.title}`));
    for (let i = 0; i < todo.length; i += 2) {
      await Promise.allSettled(todo.slice(i, i + 2).map((it) => explainItem({ ...it, kind })));
    }
  })().finally(() => warmingKinds.delete(kind));
}
