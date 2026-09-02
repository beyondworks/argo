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

test('배선 — 목록을 만드는 자리 전부가 숨김 판정을 쓴다(/api/runners·설정 카드 순서·검진·크루 도구 안내)', async () => {
  const route = await load('../app/api/runners/route.js');
  assert.match(route, /Object\.entries\(RUNNERS\)\.filter\(\(\[id\]\) => !isHiddenRunner\(id\)\)\.map/, '/api/runners 목록 필터');
  const connect = await load('../app/runner-connect.jsx');
  const order = JSON.parse((connect.match(/const RUNNER_ORDER = (\[[^\]]*\]);/) ?? [])[1].replace(/'/g, '"'));
  assert.ok(!order.includes('gemini'), '설정·온보딩 카드 순서에서 제외');
  const health = await load('../src/runner-health.mjs');
  assert.match(health, /for \(const runner of Object\.keys\(RUNNER_AUTH\)\) \{\s*\n\s*if \(isHiddenRunner\(runner\)\) continue;/, '검진 루프 제외');
  const chat = await load('../src/chat.mjs');
  assert.doesNotMatch(chat, /describe\(Object\.keys\(RUNNERS\)\.join\(' \| '\)\)/, '크루 도구 runner 인자 설명이 전체 키를 노출');
  assert.doesNotMatch(chat, /describe\(`\$\{Object\.keys\(RUNNERS\)\.join\(' \| '\)\}/, '영입 도구 runner 인자 설명이 전체 키를 노출');
  assert.match(chat, /if \(runner && isHiddenRunner\(runner\)\) return `\$\{RUNNERS\[runner\]\.name\} 러너는 더 이상 새로 지정할 수 없다/, '숨김 러너 새 지정 거절');
});

test('명판 "엔진" — runnerStatus의 hidden 표지를 usableRunnerNames가 걸러 저장된 gemini 자격이 있어도 세지 않는다', async () => {
  const { usableRunnerNames } = await import('../app/runner-usable.mjs');
  const st = { claude: { name: 'Claude', company: { connected: true, invalid: false }, hidden: false }, gemini: { name: 'Gemini', company: { connected: true, invalid: false }, hidden: true } };
  assert.deepEqual(usableRunnerNames(st), ['Claude']);
  const runners = await load('../src/runners.mjs');
  assert.match(runners, /hidden: isHiddenRunner\(id\),/, 'runnerStatus가 hidden 표지를 싣는다(클라이언트는 이 표지만 본다)');
});

test('i18n — 제공 러너로서 Gemini를 안내하는 문구가 없다(실행 한계 서술은 허용)', async () => {
  const i18n = await load('../app/i18n.jsx');
  for (const k of ['settings.runners.help', 'market.mcpRunnerNote', 'settings.workroots.desc']) {
    const line = i18n.split('\n').find((l) => l.includes(`'${k}':`));
    assert.ok(line, `${k} 존재`);
    assert.ok(!/Gemini/.test(line), `${k}에 Gemini 언급 잔존`);
  }
});
