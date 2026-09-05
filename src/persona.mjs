// 한 줄 프롬프트 → 페르소나 카드(md frontmatter + 본문) 자동 생성 — 기둥 2.
// 카드가 곧 시스템 프롬프트: 사용자가 파일을 열어 언제든 고칠 수 있다(투명성).
import { readFile, mkdir, rename, readdir } from 'node:fs/promises';
import { writeJsonAtomic } from './jsonstore.mjs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { appendUsage } from './usage.mjs';
import { isBilledRunner, visibleRunnerNamesLine } from './runners.mjs'; // billed 각인 — 순환 없음(2R 검수 확인)
import { RUNNERS } from './runners/catalog.mjs'; // 의존 0 모듈
import { isKnownModel, normalizeModelId, effectiveModels } from './runners/catalog-remote.mjs'; // 모델 저장 검증(불변식 D)
import { appendEvent } from './events.mjs';
import { runOneShot } from './oneshot.mjs'; // 러너 독립 — Claude 없이 Codex/Gemini/GLM만 연결해도 영입 가능
import { isReservedSlug } from './slug.mjs'; // 회의실 내부 이름(room-*)과의 파일 충돌 차단 — 예약어 원천

// 카드 = 시스템 프롬프트. lang='en'이면 이름·직함·본문을 영어로 생성하되, 세 섹션 헤더(## 전문성/일하는 방식/톤)는
// 한국어 고정 토큰으로 유지한다 — 백엔드·프론트 여러 파서(persona.mjs:appendAgentRule, hub.mjs, crew page)가 이
// 리터럴을 앵커로 쓰므로 헤더를 바꾸면 파서가 깨진다(회귀 0 위해 헤더 불변, 내용만 언어 전환).
// avoid = 기존 크루 표시 이름 목록(자동 생성일 때만) — 안 넘기면 같은 조건에서 같은 고빈도 이름이
// 나와 전원 동명이 된다(신고 2026-07-26 "전부 서윤" — slug만 -n 회피, 표시 이름 무방비).
// (export: 회귀 테스트용)
export const CARD_PROMPT = (oneLiner, name, lang = 'ko', avoid = []) => lang === 'en' ? `Write an AI employee's persona card from this one-line request.

Request: "${oneLiner}"
${name ? `The name must be "${name}".` : ''}

Output ONLY markdown in exactly this format (no explanation, no code fences). Keep the three section headers in Korean exactly as shown (전문성 / 일하는 방식 / 톤), but write ALL content in English:

---
name: <${name ? `"${name}" as-is` : `a natural English first name (1-2 words), like a real person${avoid.length ? ` — NOT any of these existing names: ${avoid.join(', ')}` : ''}`}>
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
name: <${name ? `"${name}" 그대로` : `한글 이름 2-3자, 사람 이름처럼${avoid.length ? ` — 다음 이름은 이미 있으니 제외: ${avoid.join(', ')}` : ''}`}>
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

// 이름 → slug. 영입 문(createAgentFromPrompt)의 지정값·이름·frontmatter slug가 모두 이 한 함수로 파일 이름이 된다.
const slugify = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
// 예약어(slug.mjs) 거절 — 회사 언어로 안내(이 함수의 다른 오류와 같은 계약) + code로 라우트가 400 매핑.
const reservedSlugError = (name, slug, lang) => Object.assign(new Error(lang === 'en'
  ? `The crew name "${name}" (${slug}) collides with the meeting room's internal name (room-) — please hire with a different name.`
  : `크루 이름 "${name}"(${slug})은 회의실 내부 이름(room-)과 겹칩니다 — 다른 이름으로 영입해 주세요.`), { code: 'SLUG_RESERVED' });

// 크루 카드 파일 경로 — slug는 URL 경로 파라미터로 들어오므로 조립 직전 검증(경로 탈출 차단).
/** 새로 만드는 크루의 작명 규칙 — **생성 시점에만** 강제한다(아래 cardPath 주석 참고). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 카드 파일 경로 — 막는 것은 **경로 이탈**이지 작명 취향이 아니다.
    예전엔 SLUG_RE로 걸렀는데, 그건 한 가지 규칙에 두 가지 일을 시킨 것이었다: 경로 안전 + 작명 규칙.
    문제는 카드 파일이 우리 영입 경로로만 생기지 않는다는 것 — 동기화·볼트 임포트·수동 복사·옛 버전으로
    `클선생.md`, `Mr_Kim.md`, `pepper copy.md` 같은 파일이 agents/에 들어온다. 그러면 목록(readdir)은
    보여주는데 카드 API는 전부 거부해서, **사이드바에 보이지만 열 수도 지울 수도 없는 크루**가 된다.
    실사용 신고 2026-08-02: 해고하려다 "크루를 찾을 수 없습니다"만 반복. 실측 재현 — 열람 404 / 해고 400.

    그래서 안전은 문자 규칙이 아니라 **봉쇄**로 본다: 경로를 실제로 계산해 agents/ **바로 아래**인지만
    확인한다. `../`·중첩 경로·절대경로는 전부 여기서 걸린다(문자 목록보다 오히려 촘촘하다).
    작명 규칙(SLUG_RE)은 새 크루를 만들 때만 쓴다 — 규칙은 들어오는 문을 지키고, 이미 있는 파일은 다룰 수 있어야 한다. */
function cardPath(wsId, slug) {
  if (typeof slug !== 'string' || !slug || slug.includes('\0')) throw Object.assign(new Error('잘못된 크루 slug'), { code: 'BAD_SLUG' });
  const dir = resolve(paths(wsId).agents);
  const file = resolve(dir, `${slug}.md`);
  if (dirname(file) !== dir) throw Object.assign(new Error('잘못된 크루 slug'), { code: 'BAD_SLUG' });
  return file;
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

/** 기존 크루 표시 이름(NFC 정규화) — 영입 프롬프트의 제외 목록 원천. (export: 회귀 테스트용) */
export async function existingNames(wsId) {
  const dir = paths(wsId).agents;
  let files = [];
  try { files = (await readdir(dir)).filter((n) => n.endsWith('.md')); } catch { return []; } // agents/ 부재(첫 영입) — 제외 없음
  const out = [];
  for (const f of files) {
    // 파일별 관용(분리 검수 LOW) — 한 카드가 깨졌다고 제외 목록 전체를 무음 소실하지 않는다
    try {
      const nm = parseFrontmatter(await readFile(join(dir, f), 'utf8')).name;
      if (nm) out.push(nm.normalize('NFC'));
    } catch { /* 깨진 카드 — 건너뜀 */ }
  }
  return out;
}

/** 원샷 1턴으로 카드 생성 → agents/<slug>.md 저장. name·team 지정 가능.
    러너 독립(runOneShot) — 가용 러너(회사 자격 우선)로 실행하고, 죽은 러너는 자가 치유 재시도.
    (이전: Claude SDK 하드코딩 — Codex만 연결한 실사용자가 영입 자체 불가 + "Claude 키" 오안내, 2026-07-19) */
export async function createAgentFromPrompt(wsId, oneLiner, { name, team } = {}) {
  const t0 = Date.now();
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({})); // 시스템 언어 — 카드 생성 언어
  const avoid = name?.trim() ? [] : await existingNames(wsId); // 이름 지정 영입은 제외 불필요
  // 이름 지정 영입은 **이름의 슬러그**를 미리 안다 — 예약어면 모델 턴(비용·최대 5분 대기·usage 적립) 전에 거절(분리 검수 LOW-1).
  // 최종 slug는 모델 frontmatter의 slug:가 이길 수 있으므로 이것은 이름 기준의 보수적 조기 거절이다(검수 2R LOW-B) —
  // 최종 판정은 아래 사후 게이트(base)가 자동 이름·frontmatter slug 경로까지 같은 규칙으로 맡는다.
  if (name?.trim() && isReservedSlug(slugify(name.trim()))) throw reservedSlugError(name.trim(), slugify(name.trim()), lang);
  // 상한 명시 — 기본(120s)은 사용자 대기 경로엔 맞지만 **첫 영입**은 다르다: 신규 회사는 무료
  // 모델(OPENROUTER_ONBOARD_MODEL)로 뽑히기 쉽고 무료 티어는 큐 지연이 크며, 러너가 하나뿐이라
  // 자가치유가 받아줄 대체도 없다 — 여기서 잘리면 온보딩이 통째로 실패한다(검수 2026-07-27 I-1).
  const { runner, text, usage, costUsd } = await runOneShot(wsId, CARD_PROMPT(oneLiner, name?.trim(), lang, avoid), { lang, timeoutMs: 5 * 60_000 });
  // billed 각인 — 구독 러너의 영입 턴 금액이 청구로 새지 않게(검수 2026-07-27 부수 발견: main에서 누수 중이었다)
  await appendUsage(wsId, { kind: 'hire', runner, usage, costUsd, ms: Date.now() - t0, billed: await isBilledRunner(wsId, runner).catch(() => undefined) });
  let md = text.trim().replace(/^```(?:markdown)?\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  // AI가 아예 응답을 못 준 경우만 진짜 실패. 형식이 어긋난 건 아래에서 복원한다(생성 실패로 두지 않는다).
  if (!md) {
    throw new Error(lang === 'en'
      ? `AI connection is needed — connect any runner (${visibleRunnerNamesLine('en')}) in Settings → AI connections to hire.`
      : `AI 연결이 필요합니다 — 설정 → AI 연결에서 아무 러너나(${visibleRunnerNamesLine()}) 연결하면 영입할 수 있어요.`);
  }

  // 관대한 필드 복원 — frontmatter(닫는 --- 없어도)·본문 H1("# 이름 — 역할")·입력에서 긁는다.
  const meta = parseFrontmatter(md);
  const h1 = (md.match(/^#\s+(.+)$/m)?.[1] || '').split(/\s+[—–-]\s+/);
  let nameFinal = (name?.trim() || meta.name || looseField(md, 'name') || h1[0] || 'AI 직원').trim();
  // 사후 가드 — 프롬프트 제외에도 자동 생성 이름이 로스터와 충돌하면 **이름만** 1회 재요청(카드
  // 전체 재생성보다 싸다). 재충돌은 수용: slug는 아래 -n으로 이미 유일하고, 2겹(제외+재요청)을 뚫는
  // 중복은 드물다. 이름 지정 영입(name)은 사장의 선택이라 손대지 않는다.
  const nfc = (s) => String(s).normalize('NFC'); // 비교는 NFC 통일 — 임포트·수기 카드의 NFD 우회 방지(검수 INFO)
  if (!name?.trim() && avoid.includes(nfc(nameFinal))) {
    const t1 = Date.now();
    const alt = await runOneShot(wsId, lang === 'en'
      ? `Suggest ONE natural English first name for a new AI employee. It must NOT be any of: ${[...avoid, nameFinal].join(', ')}. Reply with the name only — no punctuation.`
      : `새 AI 직원의 한글 이름(2-3자, 사람 이름처럼)을 하나만 추천해줘. 다음 이름은 이미 있으니 반드시 제외: ${[...avoid, nameFinal].join(', ')}. 이름만 답해(문장·기호 없이).`,
      { lang, timeoutMs: 60_000 })
      .then(async (r) => {
        // 재요청 턴도 원장에 남긴다 — usage.jsonl은 청구·월 예산 상한의 근거(분리 검수 MEDIUM:
        // 같은 함수에서 한 턴만 기록하면 이 턴의 토큰·금액이 청구·상한 양쪽에서 증발한다).
        await appendUsage(wsId, { kind: 'hire', runner: r.runner, usage: r.usage, costUsd: r.costUsd, ms: Date.now() - t1, billed: await isBilledRunner(wsId, r.runner).catch(() => undefined) }).catch(() => {});
        // 정제 — recommendRole과 같은 걷어내기 + 라벨 콜론은 뒤를 취하고("이름: 지훈"→"지훈")
        // 마크다운 강조는 후행까지 벗긴다("**지훈**" — 선두만 걷으면 "지훈**"로 남는 비대칭,
        // 분리 검수 실측). 약한 정제는 "-"·"이름:"을 이름으로 굳혔다. 2자 미만은 실패 — 기존 이름 유지.
        const line0 = String(r.text ?? '').trim().split('\n')[0];
        const line = (line0.includes(':') ? line0.slice(line0.lastIndexOf(':') + 1) : line0).replace(/^["'#*\-\s\d.:~]+|["'\s*~]+$/g, '');
        const tok = nfc(line.split(/\s+/)[0].replace(/["'`.,!?:*~]/g, '').slice(0, 24));
        return tok.length >= 2 ? tok : '';
      })
      .catch(() => ''); // 재요청 실패는 기존 이름 유지 — 영입을 죽이지 않는다
    if (alt && !avoid.includes(alt)) {
      // H1 동기화 — 옛 이름을 앵커로 역할 유무 양형("# 이름"·"# 이름 — 역할")을 함께 덮는다
      // (updateAgentMeta와 같은 모양 — 검수 LOW). 함수 리플레이서 — LLM 값의 $ 캡처참조 해석 차단.
      md = md.replace(new RegExp(`^(#\\s+)${escRe(nameFinal)}(?=\\s+[—–-]\\s+|\\s*$)`, 'm'), (_, p) => p + alt);
      nameFinal = alt;
    }
  }
  let roleFinal = (meta.role || looseField(md, 'role') || (h1[1] || '')).trim();
  // 역할을 못 뽑으면 AI가 직함을 추천해 채운다.
  if (!roleFinal) roleFinal = await recommendRole(wsId, oneLiner, lang);

  // slug — 지정값→이름 슬러그화→crew. 동명 크루 중복 영입 시 기존 카드를 덮어쓰지 않는다(-n).
  const base = slugify(meta.slug || looseField(md, 'slug') || nameFinal) || 'crew';
  let slug = base;
  for (let n = 2; existsSync(join(paths(wsId).agents, `${slug}.md`)); n++) slug = `${base}-${n}`;

  // frontmatter는 항상 정규 형식으로 재조립 — AI 출력 편차에 강건. 본문(전문성·톤 등)은 그대로 보존.
  const fm = ['---', `name: ${nameFinal}`, `slug: ${slug}`, `role: ${roleFinal}`];
  if (team?.trim()) fm.push(`team: ${team.trim()}`);
  fm.push('---');
  const finalMd = `${fm.join('\n')}\n\n${stripFrontmatter(md)}\n`;

  // 작명 규칙은 **여기(생성 문)**에서만 강제한다 — 우리가 만드는 크루는 항상 규칙을 지키게 하되,
  // 밖에서 들어온 파일까지 규칙으로 막지는 않는다(cardPath 주석 참고). slugify가 언젠가 규칙을
  // 벗어난 값을 내면 카드를 쓰기 전에 여기서 걸린다.
  if (!SLUG_RE.test(slug)) throw new Error(`크루 slug를 만들지 못했습니다: ${slug}`);
  // 예약어(slug.mjs) — 'room-main'은 회의록 chats/room-main.json·회의 턴 마커와 같은 파일 이름이 된다. -n 회피는
  // 접두를 남기므로 base로 판정한다(이름 지정 선판정과 같은 규칙 — frontmatter slug·자동 이름 경로가 여기서 걸린다).
  if (isReservedSlug(base)) throw reservedSlugError(nameFinal, base, lang);
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
    // 스코프·강도도 같은 계약 — 패널이 stale인 채 본문 저장(PUT)하면 칩 토글로 바꾼 skills/mcp가
    // 옛값으로 되살아나 "설치했는데 이 크루만 안 된다"를 만든다(탐색 A3-4, 제보 2026-07-31).
    if (cur.skills && meta.skills === undefined) out = setFrontmatterKey(out, 'skills', cur.skills);
    if (cur.mcp && meta.mcp === undefined) out = setFrontmatterKey(out, 'mcp', cur.mcp);
    if (cur.effort && meta.effort === undefined) out = setFrontmatterKey(out, 'effort', cur.effort);
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

/** 범위를 서버 맵에 적용(순수) — parseScopeList의 반환값 계약을 그대로 따른다:
    null(미기재) = 전부, [](none) = 아무것도, 목록 = 지정한 것만.
    SDK 턴과 codex 주입이 **이 하나를** 쓴다 — 사본이 갈리면 한쪽만 범위가 풀린다
    (실사고 2026-08-19: 안내 목록만 거르고 실제 주입은 안 걸러 codex 크루가 전부 받았다).
    ⚠ 이건 권한 경계가 아니라 최소권한 축소다 — codex는 크루가 자기 카드를 고쳐 범위를 넓힐 수
    있다(SDK는 금고가 하드 차단). 봉쇄가 필요하면 별도 과제. (export: 두 호출부·회귀 테스트 공용) */
export function scopeServers(servers, scope) {
  if (!scope) return servers ?? {};
  return Object.fromEntries(Object.entries(servers ?? {}).filter(([n]) => scope.includes(n)));
}

/** 크루별 추론 강도 — Claude Agent SDK의 effort 계약(sdk.d.ts: 'low'|'medium'|'high'|'xhigh'|'max').
    '' = 모델 기본. (export: UI 옵션·회귀 테스트 공용 — 값 목록이 두 곳에서 갈리지 않게) */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export async function updateAgentMeta(wsId, slug, { name, role, team, model, runner, effort, skills, mcp }) {
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
  // 모델 저장 검증(불변식 D, 2026-09-05) — 러너 목록에 없는 id는 **저장 시점에** 거절한다(종전엔 그대로 저장돼
  // 턴마다 조용히 기본 모델로 강등 = "모델 바꾸면 오류/무시"). 폐기 id는 원격 alias로 현행 id로 바꿔 저장.
  // 러너 미지정(회사 기본)이면 어느 러너든 아는 id면 통과 — 실행 러너와 다르면 chat.mjs가 modelFallback으로 고지한다.
  if (model !== undefined && String(model).trim()) {
    const rid = (runner !== undefined ? String(runner).trim() : String(before.runner ?? '').trim()) || null;
    const m = String(model).trim();
    const known = rid ? isKnownModel(rid, m) : Object.keys(RUNNERS).some((id) => isKnownModel(id, m));
    if (!known) {
      const avail = (rid ? effectiveModels(rid) : []).map((x) => x.id).filter(Boolean).slice(0, 12).join(', ');
      throw new Error(`model_not_in_catalog: ${m}${rid ? ` (${RUNNERS[rid]?.name ?? rid})` : ''}${avail ? ` — 사용 가능 / available: ${avail}` : ''}`);
    }
    model = rid ? normalizeModelId(rid, m) : m;
  }
  if (model !== undefined) md = setFrontmatterKey(md, 'model', model.trim()); // 빈 값 = 기본 모델
  if (runner !== undefined) md = setFrontmatterKey(md, 'runner', runner.trim()); // 빈 값 = 회사 연결 러너(기본)
  // 추론 강도(요청 2026-07-25) — 화이트리스트 밖 값은 저장하지 않는다(SDK가 거부하는 값이 카드에 굳는 것 방지).
  // 빈 값 = 모델 기본. claude(SDK) 러너에만 적용된다 — chat.mjs가 러너를 보고 전달 여부를 정한다.
  if (effort !== undefined) {
    const v = String(effort).trim().toLowerCase();
    md = setFrontmatterKey(md, 'effort', EFFORT_LEVELS.includes(v) ? v : '');
  }
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
  // 고정 작업 폴더도 같은 이유로 정리 — 안 걷으면 같은 이름으로 재영입했을 때 옛 고정이 조용히
  // 부활한다(분리 검수 지적 2026-07-31). 봇 연결 정리와 같은 계열의 수명 문제다.
  const { setPin } = await import('./workroots.mjs');
  await setPin(wsId, slug, '').catch(() => {});
  await appendEvent(wsId, { type: 'crew', op: 'fire', slug });
}

export async function readAgentCard(wsId, slug) {
  let md;
  try {
    md = await readFile(cardPath(wsId, slug), "utf8");
  } catch (e) {
    // 없는 크루 — 전체 파일 경로가 API 응답에 새지 않도록 깔끔한 메시지로(경로 노출 방지)
    // NOT_FOUND 코드 표시 — 라우트가 "없음(404)"과 "읽다 실패(500)"를 가려야 한다. 문구로 판정하면
    // 번역·문구 수정에 조용히 깨진다.
    if (e.code === "ENOENT") throw Object.assign(new Error(`크루를 찾을 수 없습니다: ${slug}`), { code: 'NOT_FOUND' });
    throw e;
  }
  return { md, meta: parseFrontmatter(md) };
}
