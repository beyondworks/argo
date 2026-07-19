// 한 줄 프롬프트 → 페르소나 카드(md frontmatter + 본문) 자동 생성 — 기둥 2.
// 카드가 곧 시스템 프롬프트: 사용자가 파일을 열어 언제든 고칠 수 있다(투명성).
import { readFile, mkdir, rename } from 'node:fs/promises';
import { writeJsonAtomic } from './jsonstore.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { appendUsage } from './usage.mjs';
import { appendEvent } from './events.mjs';
import { runOneShot } from './oneshot.mjs'; // 러너 독립 — Claude 없이 Codex/Gemini/GLM만 연결해도 영입 가능

// 카드 = 시스템 프롬프트. lang='en'이면 이름·직함·본문을 영어로 생성하되, 세 섹션 헤더(## 전문성/일하는 방식/톤)는
// 한국어 고정 토큰으로 유지한다 — 백엔드·프론트 여러 파서(persona.mjs:appendAgentRule, hub.mjs, crew page)가 이
// 리터럴을 앵커로 쓰므로 헤더를 바꾸면 파서가 깨진다(회귀 0 위해 헤더 불변, 내용만 언어 전환).
const CARD_PROMPT = (oneLiner, name, lang = 'ko') => lang === 'en' ? `Write an AI employee's persona card from this one-line request.

Request: "${oneLiner}"
${name ? `The name must be "${name}".` : ''}

Output ONLY markdown in exactly this format (no explanation, no code fences). Keep the three section headers in Korean exactly as shown (전문성 / 일하는 방식 / 톤), but write ALL content in English:

---
name: <${name ? `"${name}" as-is` : 'a natural English first name (1-2 words), like a real person'}>
slug: <lowercase english slug>
role: <one-line job title in English>
---

# <name> — <role>

## 전문성
(3-5 areas this employee knows deeply — bullets, in English)

## 일하는 방식
(output format, quality bar, checking habits — 3-4 bullets, in English)

## 톤
(one line on how they speak with the user, in English)` : `다음 한 줄 요청으로 AI 직원의 페르소나 카드를 작성해줘.

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

/** frontmatter가 깨졌어도(닫는 --- 누락 등) "key: value" 첫 줄에서 값을 복원한다. */
function looseField(md, key) {
  const m = md.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** 카드 본문만 — 정상/비정상 frontmatter를 떼어낸다(닫는 --- 없이 곧장 본문인 경우 포함). */
function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (m) return md.slice(m[0].length).trim();
  if (/^---/.test(md)) {          // 여는 ---만 있고 닫는 게 없음
    const h = md.search(/^#\s/m);
    if (h > 0) return md.slice(h).trim();  // 첫 '#' 헤딩부터 본문
    // 헤딩도 닫는 ---도 없음 → 선두 '---' + 이어지는 key: value 잔재를 걷어낸다
    const lines = md.split('\n');
    let i = 1;
    while (i < lines.length && (/^\s*[\w-]+\s*:/.test(lines[i]) || lines[i].trim() === '' || lines[i].trim() === '---')) i++;
    return lines.slice(i).join('\n').trim();
  }
  return md.trim();
}

/** 역할(직함)을 AI가 한 줄로 추천 — 카드에서 역할을 못 뽑았을 때의 폴백. 생성 실패로 두지 않는다. */
async function recommendRole(wsId, oneLiner, lang = 'ko') {
  try {
    const { text } = await runOneShot(wsId, lang === 'en'
      ? `Reply with a fitting job title for this AI employee in one short English line (2-4 words; title only, no punctuation or quotes).\nRequest: "${oneLiner}"`
      : `다음 요청에 어울리는 AI 직원의 직함을 한국어 한 줄(2-12자, 설명·기호·따옴표 없이 직함만)로 답해줘.\n요청: "${oneLiner}"`, { lang });
    const role = (text || '').trim().split('\n')[0].replace(/^["'#*\-\s]+|["'\s]+$/g, '').slice(0, 40);
    if (role) return role;
  } catch { /* 아래 폴백 */ }
  return ((oneLiner || '').split(/[-—·,.\n]/)[0].trim().slice(0, 30)) || (lang === 'en' ? 'AI employee' : 'AI 직원');
}

/** 원샷 1턴으로 카드 생성 → agents/<slug>.md 저장. name·team 지정 가능.
    러너 독립(runOneShot) — 가용 러너(회사 자격 우선)로 실행하고, 죽은 러너는 자가 치유 재시도.
    (이전: Claude SDK 하드코딩 — Codex만 연결한 실사용자가 영입 자체 불가 + "Claude 키" 오안내, 2026-07-19) */
export async function createAgentFromPrompt(wsId, oneLiner, { name, team } = {}) {
  const t0 = Date.now();
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({})); // 시스템 언어 — 카드 생성 언어
  const { runner, text, usage, costUsd } = await runOneShot(wsId, CARD_PROMPT(oneLiner, name?.trim(), lang), { lang });
  await appendUsage(wsId, { kind: 'hire', runner, usage, costUsd, ms: Date.now() - t0 });
  const md = text.trim().replace(/^```(?:markdown)?\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  // AI가 아예 응답을 못 준 경우만 진짜 실패. 형식이 어긋난 건 아래에서 복원한다(생성 실패로 두지 않는다).
  if (!md) {
    throw new Error(lang === 'en'
      ? 'AI connection is needed — connect any runner (Claude, Codex, Gemini, or GLM) in Settings → AI connections to hire.'
      : 'AI 연결이 필요합니다 — 설정 → AI 연결에서 아무 러너나(Claude·Codex·Gemini·GLM) 연결하면 영입할 수 있어요.');
  }

  // 관대한 필드 복원 — frontmatter(닫는 --- 없어도)·본문 H1("# 이름 — 역할")·입력에서 긁는다.
  const meta = parseFrontmatter(md);
  const h1 = (md.match(/^#\s+(.+)$/m)?.[1] || '').split(/\s+[—–-]\s+/);
  const nameFinal = (name?.trim() || meta.name || looseField(md, 'name') || h1[0] || 'AI 직원').trim();
  let roleFinal = (meta.role || looseField(md, 'role') || (h1[1] || '')).trim();
  // 역할을 못 뽑으면 AI가 직함을 추천해 채운다.
  if (!roleFinal) roleFinal = await recommendRole(wsId, oneLiner, lang);

  // slug — 지정값→이름 슬러그화→crew. 동명 크루 중복 영입 시 기존 카드를 덮어쓰지 않는다(-n).
  const slugify = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const base = slugify(meta.slug || looseField(md, 'slug') || nameFinal) || 'crew';
  let slug = base;
  for (let n = 2; existsSync(join(paths(wsId).agents, `${slug}.md`)); n++) slug = `${base}-${n}`;

  // frontmatter는 항상 정규 형식으로 재조립 — AI 출력 편차에 강건. 본문(전문성·톤 등)은 그대로 보존.
  const fm = ['---', `name: ${nameFinal}`, `slug: ${slug}`, `role: ${roleFinal}`];
  if (team?.trim()) fm.push(`team: ${team.trim()}`);
  fm.push('---');
  const finalMd = `${fm.join('\n')}\n\n${stripFrontmatter(md)}\n`;

  const file = cardPath(wsId, slug);
  await writeJsonAtomic(file, finalMd);
  await appendEvent(wsId, { type: 'crew', op: 'hire', slug, name: nameFinal });
  return { slug, name: nameFinal, role: roleFinal, team: team?.trim() || '', file };
}

// 정규식 메타문자 리터럴화 — 이름 등 사용자 값으로 RegExp를 만들 때 오작동/rename 실패 방지.
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 카드 편집 저장 — 카드가 곧 시스템 프롬프트(투명성 원칙). frontmatter 최소 검증. */
export async function saveAgentCard(wsId, slug, md) {
  const meta = parseFrontmatter(md);
  if (!meta.name) throw new Error('frontmatter에 name이 필요합니다');
  const file = cardPath(wsId, slug);
  if (!existsSync(file)) throw new Error('존재하지 않는 크루입니다');
  // 엔진(runner/model)은 PATCH 경로가 소유한다 — 본문/규칙 저장(PUT)이 통째로 덮어써 엔진 선택을
  // 조용히 원복시키던 문제(패널 stale) 방어: 들어온 md에 엔진 키가 없으면 디스크의 현재 값을 보존한다.
  // (사용자가 raw 편집기에서 직접 엔진 키를 넣었으면 그때만 incoming에 존재 → 그 값 존중)
  let out = md.endsWith('\n') ? md : `${md}\n`;
  try {
    const cur = parseFrontmatter(await readFile(file, 'utf8'));
    if (cur.runner && meta.runner === undefined) out = setFrontmatterKey(out, 'runner', cur.runner);
    if (cur.model && meta.model === undefined) out = setFrontmatterKey(out, 'model', cur.model);
  } catch { /* 디스크 읽기 실패 시 들어온 md 그대로 저장 */ }
  await writeJsonAtomic(file, out);
  const saved = parseFrontmatter(out);
  return { slug, name: saved.name, role: saved.role || '' };
}

/** frontmatter 키를 갱신/삽입/삭제하며 카드 본문은 보존한다. */
function setFrontmatterKey(md, key, value) {
  // 개행 세척 — 값에 개행이 섞이면 frontmatter 구조가 갈라진다(키 인젝션·본문 분리). 전 키 공통 방어(검수 LOW).
  if (typeof value === 'string') value = value.replace(/\r?\n/g, ' ').trim();
  const re = new RegExp(`^(---[\\s\\S]*?)^${key}:.*$`, 'm');
  if (value === '' || value == null) {
    return md.replace(new RegExp(`^${key}:.*\\n`, 'm'), ''); // 키 제거
  }
  if (re.test(md)) return md.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`);
  return md.replace(/^---\r?\n/, `---\n${key}: ${value}\n`); // 키 삽입
}

/** 이름·역할·팀·모델 수정 — 슬러그·파일명·기록은 유지(정체성은 표시 이름만 바뀐다). */
/** 크루 능력 범위 필드 해석(순수) — 카드 frontmatter `skills:`/`mcp:` 계약(유건 지시 2026-07-19):
    미기재/빈 값 = 전체 사용(null — 설치된 것 전부, 회사 공용 기본), 'none' = 사용 안 함(빈 배열),
    그 외 = 쉼표 목록(지정한 것만). (export: chat 턴 필터·회귀 테스트 공용) */
export function parseScopeList(v) {
  const s = String(v ?? '').trim();
  if (!s) return null; // 전체(기본)
  if (s.toLowerCase() === 'none') return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export async function updateAgentMeta(wsId, slug, { name, role, team, model, runner, skills, mcp }) {
  const file = cardPath(wsId, slug);
  if (!existsSync(file)) throw new Error('존재하지 않는 크루입니다');
  let md = await readFile(file, 'utf8');
  const before = parseFrontmatter(md);
  if (name !== undefined && name.trim()) {
    md = setFrontmatterKey(md, 'name', name.trim());
    // 본문 제목의 옛 이름도 함께 (— "# 이름 — 직함" 관례). 이름을 정규식 리터럴로 이스케이프하고
    // 치환값은 함수 리플레이서로 넘겨 새 이름의 '$'가 캡처참조로 오해석되는 것까지 막는다.
    if (before.name) md = md.replace(new RegExp(`^# ${escRe(before.name)}(?= —|$)`, 'm'), () => `# ${name.trim()}`);
  }
  if (role !== undefined) md = setFrontmatterKey(md, 'role', role.trim());
  if (team !== undefined) md = setFrontmatterKey(md, 'team', team.trim());
  if (model !== undefined) md = setFrontmatterKey(md, 'model', model.trim()); // 빈 값 = 기본 모델
  if (runner !== undefined) md = setFrontmatterKey(md, 'runner', runner.trim()); // 빈 값 = 회사 연결 러너(기본)
  if (skills !== undefined) md = setFrontmatterKey(md, 'skills', String(skills).trim()); // 빈 값 = 전체, 'none' = 없음, csv = 지정만
  if (mcp !== undefined) md = setFrontmatterKey(md, 'mcp', String(mcp).trim());          // 동일 계약(parseScopeList)
  await writeJsonAtomic(file, md);
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
  await writeJsonAtomic(file, next);
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
    await writeJsonAtomic(file, setFrontmatterKey(md, 'team', to.trim()));
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
  // 직통 봇 연결도 함께 정리 — 안 걷으면 유령 폴러가 계속 돌고, 토큰 중복 검사가
  // UI에 보이지 않는 해고 크루를 지목해 사용자가 풀 방법이 없어진다(검수 지적).
  const { updateAgentBot } = await import('./connections.mjs'); // 동적 — 모듈 간 순환 방지
  await updateAgentBot(wsId, slug, null).catch(() => {});
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
