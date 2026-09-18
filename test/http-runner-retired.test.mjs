// HTTP 텍스트 러너(runner: http)를 걷어낸 뒤 — 카드에 그 값이 남은 크루는 다른 러너로 대신 돌지 않고 정직하게 멈춘다.
// 외부 에이전트는 크루의 두뇌가 아니라 메신저에 봇으로 접속한다(2026-09-08 방향, 2026-09-18 제거).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-httprt-home-'));
process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-httprt-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { chat } = await import('../src/chat.mjs');
const { RUNNERS, RUNNER_AUTH, pickRunner, isRetiredRunner } = await import('../src/runners/catalog.mjs');

test('카탈로그에서 http 러너가 사라졌다 — 목록·자격·제공 종료 판정 어디에도 없다', () => {
  assert.equal(RUNNERS.http, undefined);
  assert.equal(RUNNER_AUTH.http, undefined);
  assert.equal(isRetiredRunner('http'), false);
});

test('거절이 필요한 이유 — 카탈로그에 없는 러너를 지정하면 pickRunner는 가용한 다른 러너로 넘긴다', () => {
  // 이것이 "외부 에이전트 크루가 다른 두뇌로 답하는" 경로다. 그래서 chat()이 해석 전에 멈춰야 한다.
  const st = { claude: { company: { connected: true } } };
  const r = pickRunner(st, 'http');
  assert.equal(r.runner, 'claude');
  assert.equal(r.fellBack, true);
});

async function crewOn(ws, lang) {
  await createCompany(ws, '회사', '사장');
  if (lang) await updateCompany(ws, { lang });
  await writeFile(join(paths(ws).agents, 'ext.md'), '---\nname: 외부\nrunner: http\nendpoint: http://127.0.0.1:9/v1\n---\n외부 에이전트 크루\n');
}

test('runner: http 크루의 턴은 러너를 해석하기 전에 정직하게 멈춘다(ko)', async () => {
  await crewOn('rt-ko');
  await assert.rejects(chat('rt-ko', 'ext', '안녕'), (e) => {
    assert.match(e.message, /외부 에이전트\(HTTP\)로 실행하도록 설정돼 있는데, 이 방식은 더 이상 지원하지 않습니다/);
    assert.match(e.message, /봇으로 연결/);
    return true;
  });
});

test('runner: http 크루의 턴은 러너를 해석하기 전에 정직하게 멈춘다(en)', async () => {
  await crewOn('rt-en', 'en');
  await assert.rejects(chat('rt-en', 'ext', 'hi'), (e) => {
    assert.match(e.message, /external agent over HTTP, which is no longer supported/);
    assert.match(e.message, /as a bot/);
    return true;
  });
});
