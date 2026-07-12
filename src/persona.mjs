// 한 줄 프롬프트 → 페르소나 카드(md frontmatter + 본문) 자동 생성 — 기둥 2.
// 카드가 곧 시스템 프롬프트: 사용자가 파일을 열어 언제든 고칠 수 있다(투명성).
import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { appendUsage } from './usage.mjs';
import { appendEvent } from './events.mjs';
import { sdkEnvFor } from './runners.mjs';

const CARD_PROMPT = (oneLiner, name) => `다음 한 줄 요청으로 AI 직원의 페르소나 카드를 작성해줘.

요청: "${oneLiner}"
${name ? `이름은 반드시 "${name}"으로 한다.` : ''}

정확히 아래 형식의 마크다운만 출력해(설명·코드펜스 금지):

---
name: <${name ? `"${name}" 그대로` : '한글 이름 2-3자, 사람 이름처럼'}>
slug: <영문 소문자 슬러그>
role: <직함 한 줄>
---

# <이름> — <직함>

## 전문성
(이 직원이 깊게 아는 영역 3-5개, 불릿)

## 일하는 방식
(산출물 형식·품질 기준·확인 습관, 불릿 3-4개)

## 톤
(사용자와 대화할 때의 말투 한 줄)`;

// 크루 카드 파일 경로 — slug는 URL 경로 파라미터로 들어오므로 조립 직전 검증(경로 탈출 차단).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function cardPath(wsId, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new Error('잘못된 크루 slug');
  return join(paths(wsId).agents, `${slug}.md`);
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return meta;
}

/** Agent SDK 단일 턴으로 카드 생성 → agents/<slug>.md 저장. name·team 지정 가능. */
export async function createAgentFromPrompt(wsId, oneLiner, { name, team } = {}) {
  let out = '';
  const t0 = Date.now();
  // 카드 생성도 채팅과 동일하게 회사 자격(claude 키/OAuth)을 주입 — 없으면 호스트 자격 폴백.
  // (이게 없으면 웹 사용자가 키를 넣어도 영입만 호스트 키를 찾다 실패했다)
  const sdkEnv = await sdkEnvFor(wsId, 'claude');
  let failed = null;
  for await (const msg of query({
    prompt: CARD_PROMPT(oneLiner, name?.trim()),
    options: {
      cwd: paths(wsId).root,
      allowedTools: [], // 순수 생성 — 도구 불필요
      settingSources: [], // 호스트 머신의 CLAUDE.md 등 미주입(테넌트 격리)
      maxTurns: 1,
      ...(sdkEnv ? { env: sdkEnv } : {}),
    },
  })) {
    if (msg.type === 'result') {
      await appendUsage(wsId, { kind: 'hire', usage: msg.usage, costUsd: msg.total_cost_usd, ms: Date.now() - t0 });
      if (msg.subtype === 'success') out = msg.result;
      else failed = msg.subtype;
    }
  }
  const md = out.trim().replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');
  const meta = parseFrontmatter(md);
  if (!meta.slug || !meta.name) {
    // 대개 AI 연결 부재 — 개발자 에러 대신 사용자 안내로 던진다(온보딩 첫 행동이 영입일 수 있음)
    if (!out.trim() || failed) throw new Error('AI 연결이 필요합니다 — 설정 → 러너 연결에서 Claude API 키 또는 OAuth를 연결하면 영입할 수 있어요.');
    throw new Error(`카드 생성 실패 — frontmatter 누락:\n${md.slice(0, 200)}`);
  }
  let slug = meta.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  // 동명 크루 중복 영입 시 기존 카드를 덮어쓰지 않는다
  for (let n = 2; existsSync(join(paths(wsId).agents, `${slug}.md`)); n++) {
    slug = `${meta.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${n}`;
  }
  let body = md.replace(/^(---[\s\S]*?slug:\s*).*$/m, `$1${slug}`);
  if (name?.trim()) body = body.replace(/^(---[\s\S]*?name:\s*).*$/m, `$1${name.trim()}`);
  if (team?.trim()) body = body.replace(/^---\r?\n/, `---\nteam: ${team.trim()}\n`);
  const file = cardPath(wsId, slug);
  await writeFile(file, body.endsWith('\n') ? body : `${body}\n`);
  await appendEvent(wsId, { type: 'crew', op: 'hire', slug, name: name?.trim() || meta.name });
  return { slug, name: name?.trim() || meta.name, role: meta.role || '', team: team?.trim() || '', file };
}

/** 카드 편집 저장 — 카드가 곧 시스템 프롬프트(투명성 원칙). frontmatter 최소 검증. */
export async function saveAgentCard(wsId, slug, md) {
  const meta = parseFrontmatter(md);
  if (!meta.name) throw new Error('frontmatter에 name이 필요합니다');
  const file = cardPath(wsId, slug);
  if (!existsSync(file)) throw new Error('존재하지 않는 크루입니다');
  await writeFile(file, md.endsWith('\n') ? md : `${md}\n`);
  return { slug, name: meta.name, role: meta.role || '' };
}

/** frontmatter 키를 갱신/삽입/삭제하며 카드 본문은 보존한다. */
function setFrontmatterKey(md, key, value) {
  const re = new RegExp(`^(---[\\s\\S]*?)^${key}:.*$`, 'm');
  if (value === '' || value == null) {
    return md.replace(new RegExp(`^${key}:.*\\n`, 'm'), ''); // 키 제거
  }
  if (re.test(md)) return md.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`);
  return md.replace(/^---\r?\n/, `---\n${key}: ${value}\n`); // 키 삽입
}

/** 이름·역할·팀·모델 수정 — 슬러그·파일명·기록은 유지(정체성은 표시 이름만 바뀐다). */
export async function updateAgentMeta(wsId, slug, { name, role, team, model, runner }) {
  const file = cardPath(wsId, slug);
  if (!existsSync(file)) throw new Error('존재하지 않는 크루입니다');
  let md = await readFile(file, 'utf8');
  const before = parseFrontmatter(md);
  if (name !== undefined && name.trim()) {
    md = setFrontmatterKey(md, 'name', name.trim());
    // 본문 제목의 옛 이름도 함께 (— "# 이름 — 직함" 관례)
    if (before.name) md = md.replace(new RegExp(`^# ${before.name}(?= —|$)`, 'm'), `# ${name.trim()}`);
  }
  if (role !== undefined) md = setFrontmatterKey(md, 'role', role.trim());
  if (team !== undefined) md = setFrontmatterKey(md, 'team', team.trim());
  if (model !== undefined) md = setFrontmatterKey(md, 'model', model.trim()); // 빈 값 = 기본 모델
  if (runner !== undefined) md = setFrontmatterKey(md, 'runner', runner.trim()); // 빈 값 = Claude Code(기본)
  await writeFile(file, md);
  const after = parseFrontmatter(md);
  await appendEvent(wsId, { type: 'crew', op: 'update', slug, name: after.name });
  if (name !== undefined && name.trim() && before.name !== after.name) {
    // 텔레그램 직통 봇의 표시 이름도 따라가게 — 실패(레이트리밋)해도 카드 수정은 완료된 것
    import('./connections.mjs').then((m) => m.syncAgentBotName(wsId, slug, after.name)).catch(() => {});
  }
  return after;
}

/** 카드 "## 일하는 방식"에 규칙 한 줄 추가 — CardPanel의 addRule과 동일 규약(서버측). */
export async function appendAgentRule(wsId, slug, text) {
  const file = cardPath(wsId, slug);
  if (!existsSync(file)) throw new Error('존재하지 않는 크루입니다');
  const md = await readFile(file, 'utf8');
  const rule = String(text).trim();
  if (!rule) return parseFrontmatter(md);
  const h = '## 일하는 방식';
  let next;
  const i = md.indexOf(h);
  if (i === -1) {
    next = `${md.trimEnd()}\n\n${h}\n- ${rule}\n`;
  } else {
    const rest = md.indexOf('\n## ', i + h.length);
    const end = rest === -1 ? md.length : rest;
    next = `${md.slice(0, end).trimEnd()}\n- ${rule}\n${rest === -1 ? '' : md.slice(end)}`;
  }
  await writeFile(file, next);
  await appendEvent(wsId, { type: 'crew', op: 'update', slug, name: parseFrontmatter(next).name });
  return parseFrontmatter(next);
}

/** 팀 이름 변경 — 그 팀 소속 전 크루의 frontmatter를 일괄 갱신. */
export async function renameTeam(wsId, from, to) {
  const { readdir } = await import('node:fs/promises');
  const dir = paths(wsId).agents;
  let changed = 0;
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.md'))) {
    const file = join(dir, f);
    const md = await readFile(file, 'utf8');
    if (parseFrontmatter(md).team !== from) continue;
    await writeFile(file, setFrontmatterKey(md, 'team', to.trim()));
    changed += 1;
  }
  if (changed === 0) throw new Error('해당 팀의 크루가 없습니다');
  await appendEvent(wsId, { type: 'crew', op: 'team', name: `${from} → ${to.trim()}` });
  return { changed };
}

/** 해고 — 카드를 지우지 않고 .archive/로 옮긴다(복구 가능). */
export async function removeAgentCard(wsId, slug) {
  const file = cardPath(wsId, slug); // slug 검증 포함
  const dir = paths(wsId).agents;
  if (!existsSync(file)) throw new Error('존재하지 않는 크루입니다');
  const archive = join(dir, '.archive');
  await mkdir(archive, { recursive: true });
  await rename(file, join(archive, `${Date.now()}-${slug}.md`));
  await appendEvent(wsId, { type: 'crew', op: 'fire', slug });
}

export async function readAgentCard(wsId, slug) {
  let md;
  try {
    md = await readFile(cardPath(wsId, slug), "utf8");
  } catch (e) {
    // 없는 크루 — 전체 파일 경로가 API 응답에 새지 않도록 깔끔한 메시지로(경로 노출 방지)
    if (e.code === "ENOENT") throw new Error(`크루를 찾을 수 없습니다: ${slug}`);
    throw e;
  }
  return { md, meta: parseFrontmatter(md) };
}
