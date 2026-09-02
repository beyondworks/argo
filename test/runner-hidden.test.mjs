import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RUNNERS, RUNNER_AUTH, isHiddenRunner, visibleRunnerIds, pickRunner } from '../src/runners/catalog.mjs';

// 유건 결정 2026-09-03: Gemini 러너 숨김 — Antigravity가 같은 구글 모델을 더 안정적으로 실행. 숨김 = 새로 고를 수도,
// 자동으로 잡히지도 않되 이미 지정된 크루·자격은 그대로 돈다. 목록을 만드는 자리 전부가 한 판정(isHiddenRunner)을 쓴다.
const load = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const on = { company: { connected: true, invalid: false } };

test('카탈로그 — gemini는 hidden, 실행 정의(RUNNERS·RUNNER_AUTH)는 남아 있다', () => {
  assert.equal(isHiddenRunner('gemini'), true);
  assert.ok(RUNNERS.gemini?.models?.length, '실행 경로(모델 카탈로그)는 유지');
  assert.ok(RUNNER_AUTH.gemini, '자격 정의 유지 — 저장된 자격·기존 크루가 계속 돈다');
  assert.ok(!visibleRunnerIds().includes('gemini') && visibleRunnerIds().includes('antigravity'));
});

test('pickRunner — 자동 선택(기본 러너·순서 폴백)은 숨김 러너를 건너뛰고, 명시 지정은 존중한다', () => {
  const st = { gemini: on, antigravity: on };
  assert.equal(pickRunner(st, null).runner, 'antigravity', '순서 폴백에서 gemini 제외');
  assert.equal(pickRunner(st, null, null, { defaultRunner: 'gemini' }).runner, 'antigravity', '회사 기본 러너가 숨김이면 건너뛴다');
  assert.equal(pickRunner(st, 'gemini').runner, 'gemini', '이미 gemini로 지정된 크루는 그대로');
  assert.equal(pickRunner({ gemini: on }, null).available, false, '숨김 러너만 연결된 회사는 자동 크루가 러너 없음');
});

test('배선 — 목록을 만드는 자리 전부가 숨김 판정을 쓴다(설정 카드 순서·크루 도구 안내·셀렉터·경쟁 슬롯·keys PUT)', async () => {
  const connect = await load('../app/runner-connect.jsx');
  const order = JSON.parse((connect.match(/const RUNNER_ORDER = (\[[^\]]*\]);/) ?? [])[1].replace(/'/g, '"'));
  assert.ok(!order.includes('gemini'), '설정·온보딩 카드 순서에서 제외');
  assert.match(connect, /filter\(\(id\) => runners\[id\]\?\.hidden && runners\[id\]\?\.company\?\.connected\)\.map\(\(id\) => \(\s*<RunnerRow[^\n]*retired/, '보관된 숨김 자격은 "제공 종료 · 해제만" 행으로(검수 MEDIUM-4)');
  assert.match(connect, /\{hostLinked \|\| retired \? \(/, '제공 종료 행은 연결 폼 없이 해제만');
  const chat = await load('../src/chat.mjs');
  assert.doesNotMatch(chat, /describe\(Object\.keys\(RUNNERS\)\.join\(' \| '\)\)/, '크루 도구 runner 인자 설명이 전체 키를 노출');
  assert.doesNotMatch(chat, /describe\(`\$\{Object\.keys\(RUNNERS\)\.join\(' \| '\)\}/, '영입 도구 runner 인자 설명이 전체 키를 노출');
  assert.match(chat, /if \(runner && isHiddenRunner\(runner\) && runner !== effRunner\) return `\$\{RUNNERS\[runner\]\.name\} 러너는 더 이상 새로 지정할 수 없다/, '숨김 러너 새 지정 거절 — 같은 러너 안 모델 변경은 허용(검수 LOW-3)');
  // 셀렉터 — 숨김은 선택지에서 빼되 현재 값이면 남긴다(유건 2026-09-03: 선택 불가로 보일 바엔 숨긴다 / 검수 HIGH-2: 빠지면 "자동" 오표시)
  const crew = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(crew, /const pickable = \(runners \?\? \[\]\)\.filter\(\(r\) => !r\.hidden \|\| r\.id === sel\.runner\);/, '카드 패널 러너 셀렉터');
  assert.match(crew, /\(runners \?\? \[\]\)\.filter\(\(r\) => !r\.hidden \|\| r\.id === sel\.runner\)\.map\(\(r\) => \(/, '대화창 엔진 메뉴');
  const edit = await load('../app/c/[ws]/crew-edit.jsx');
  assert.match(edit, /const pickable = \(runners \?\? \[\]\)\.filter\(\(r\) => !r\.hidden \|\| r\.id === form\.runner\);/, '크루 편집 모달 셀렉터');
  const compete = await load('../app/c/[ws]/compete/page.jsx');
  assert.match(compete, /filter\(\(r\) => r\.authed && !r\.hidden && r\.models\?\.length\)/, '경쟁 슬롯');
  const keys = await load('../app/api/companies/[ws]/keys/route.js');
  assert.match(keys, /if \(isHiddenRunner\(runner\)\) throw new Error\('더 이상 제공되지 않는 러너입니다'\);/, 'keys PUT 신규 저장 거절(검수 LOW-5)');
  // 안내문 4곳(chat/oneshot/persona/trial)이 하드코딩 러너 줄 대신 가시 러너 줄을 쓴다(검수 MEDIUM-2)
  for (const f of ['../src/chat.mjs', '../src/oneshot.mjs', '../src/persona.mjs', '../src/trial.mjs']) {
    const src = await load(f);
    assert.ok(!src.includes('Claude·Codex·Gemini·Antigravity'), `${f}: 하드코딩 러너 줄 잔존`);
    assert.ok(src.includes('${visibleRunnerNamesLine()}'), `${f}: 가시 러너 줄 미사용`);
  }
  const { visibleRunnerNamesLine } = await import('../src/runners/catalog.mjs');
  assert.ok(!/Gemini/.test(visibleRunnerNamesLine()) && /Antigravity/.test(visibleRunnerNamesLine()));
});

test('/api/runners 행동 — 목록에 gemini가 hidden:true로 남고(현재 값 정직 표기용) 가시 러너는 hidden:false', async () => {
  // 라우트 실호출(next-esm-resolve 훅) — 소스 문자열 핀은 리터럴을 두고 결과만 되살리는 변이에 초록이었다(검수 MEDIUM-3 실증)
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { register } = await import('node:module');
  register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
  const route = await import('../app/api/runners/route.js');
  const res = await route.GET(new Request('http://127.0.0.1/api/runners'));
  const j = await res.json();
  const g = j.runners.find((r) => r.id === 'gemini');
  assert.ok(g && g.hidden === true, 'gemini 항목은 남되 hidden');
  assert.ok(j.runners.filter((r) => !r.hidden).every((r) => !isHiddenRunner(r.id)) && j.runners.some((r) => r.id === 'antigravity' && r.hidden === false));
});

test('가용 판정 — anyRunnerUsable은 숨김 러너를 세지 않고, onlyHiddenConnected가 그 상태를 가려낸다(검수 HIGH-1 모순 해소)', async () => {
  const { anyRunnerUsable, onlyHiddenConnected, PICK_ORDER } = await import('../app/runner-usable.mjs');
  const st = { gemini: { company: { connected: true, invalid: false }, hidden: true } };
  assert.equal(anyRunnerUsable(st), false);
  assert.equal(onlyHiddenConnected(st), true);
  assert.equal(anyRunnerUsable({ ...st, claude: { company: { connected: true, invalid: false }, hidden: false } }), true);
  assert.ok(!PICK_ORDER.includes('gemini'), 'PICK_ORDER(자동 표시 순서)에서 제외 — 판정이 두 벌이 되지 않게(검수 LOW-1)');
});

test('명판 "엔진" — runnerStatus의 hidden 표지를 usableRunnerNames가 걸러 저장된 gemini 자격이 있어도 세지 않는다', async () => {
  const { usableRunnerNames } = await import('../app/runner-usable.mjs');
  const st = { claude: { name: 'Claude', company: { connected: true, invalid: false }, hidden: false }, gemini: { name: 'Gemini', company: { connected: true, invalid: false }, hidden: true } };
  assert.deepEqual(usableRunnerNames(st), ['Claude']);
  const runners = await load('../src/runners.mjs');
  assert.match(runners, /hidden: isHiddenRunner\(id\),/, 'runnerStatus가 hidden 표지를 싣는다(클라이언트는 이 표지만 본다)');
});

test('i18n — 제공 러너로서 Gemini를 안내하는 문구가 없다(실행 한계·반경 서술은 허용)', async () => {
  const i18n = await load('../app/i18n.jsx');
  for (const k of ['settings.runners.help', 'market.mcpRunnerNote', 'chat.card.mcpCliWarn']) {
    const line = i18n.split('\n').find((l) => l.includes(`'${k}':`));
    assert.ok(line, `${k} 존재`);
    assert.ok(!/Gemini/.test(line), `${k}에 Gemini 언급 잔존`);
  }
  // 형제 키 누락 방지(검수 MEDIUM-1): "Codex·Gemini"/"Codex, Gemini" 같은 나열형 제공 안내 패턴을 사전 전체에서 스윕
  const offers = i18n.split('\n').filter((l) => /Codex·Gemini|Codex, Gemini|Gemini, or an SDK|Gemini나 SDK/.test(l));
  assert.deepEqual(offers.map((l) => l.trim().slice(0, 40)), [], '나열형 제공 안내에 Gemini 잔존');
  for (const k of ['runner.retired', 'settings.runners.retiredNote']) {
    const m = i18n.match(new RegExp(`^\\s*'${k.replace(/\./g, '\\.')}':\\s*\\['([^']*)',\\s*'([^']*)'\\]`, 'm'));
    assert.ok(m && /[가-힣]/.test(m[1]) && !/[가-힣]/.test(m[2]), `${k} ko/en 등록`);
  }
});
