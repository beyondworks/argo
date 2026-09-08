// 외부 에이전트 표기 층(순수) — 사용자는 "HTTP"가 아니라 어떤 에이전트인지 본다(유건 2026-09-08). 포맷은 agent에서 유추.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalAgentLabel, externalAgentFormat, externalAgentKind, endpointHost, EXTERNAL_AGENTS } from '../src/runners/external-agent.mjs';

test('라벨 — hermes/openclaw는 종류 이름, custom은 호스트를 덧붙임, 모르는 값은 custom, ko/en', () => {
  assert.equal(externalAgentLabel({ agent: 'hermes' }), '헤르메스 에이전트'); assert.equal(externalAgentLabel({ agent: 'Hermes ' }, 'en'), 'Hermes agent');
  assert.equal(externalAgentLabel({ agent: 'openclaw' }), '오픈클로 에이전트');
  assert.equal(externalAgentLabel({ agent: '', endpoint: 'http://127.0.0.1:9000/turn' }), '외부 에이전트(127.0.0.1:9000)');
  assert.equal(externalAgentLabel({ agent: 'zzz', endpoint: '"https://a.example/x"' }, 'en'), 'External agent(a.example)');
  assert.equal(externalAgentLabel({}), '외부 에이전트', '엔드포인트도 없으면 이름만');
  assert.equal(endpointHost('not a url'), '');
});
test('포맷 — 카드 format 우선, 없으면 agent 기본(hermes=openai-chat), 그것도 없으면 argo', () => {
  assert.equal(externalAgentFormat({ agent: 'hermes' }), 'openai-chat'); assert.equal(externalAgentFormat({ agent: 'hermes', format: 'argo' }), 'argo');
  assert.equal(externalAgentFormat({}), 'argo'); assert.equal(externalAgentKind({ agent: 'OPENCLAW' }), 'openclaw');
  for (const [k, v] of Object.entries(EXTERNAL_AGENTS)) assert.ok(v.ko && v.en && ['argo', 'openai-chat'].includes(v.format), k);
});
test('listAgents — 카드의 agent·endpoint 호스트를 싣는다(전체 URL·키는 밖으로 안 나간다)', async () => {
  const ROOT = await mkdtemp(join(tmpdir(), 'argo-ext-agent-')); process.env.ARGO_ROOT = ROOT;
  const { listAgents } = await import('../src/hub.mjs');
  await mkdir(join(ROOT, 'w', 'agents'), { recursive: true });
  await writeFile(join(ROOT, 'w', 'agents', 'h.md'), '---\nname: 헤르메스\nrunner: http\nagent: hermes\nendpoint: http://127.0.0.1:8642/v1/chat/completions?key=SECRET\n---\n외부.\n');
  const [a] = await listAgents('w');
  assert.equal(a.agent, 'hermes'); assert.equal(a.endpointHost, '127.0.0.1:8642'); assert.equal(a.endpoint, undefined); assert.ok(!JSON.stringify(a).includes('SECRET'));
});
test('배선 핀 — chat은 agent에서 포맷을 유추하고, 데크 배너·크루 피커·설정 행·활동은 http를 외부 에이전트 이름으로 부른다', async () => {
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.equal((chat.match(/format: externalAgentFormat\(meta\)/g) ?? []).length, 2);
  const deck = await readFile(new URL('../app/c/[ws]/page.jsx', import.meta.url), 'utf8');
  assert.match(deck, /state === 'missing' && externalAgents \? t\('deck\.runner\.external', \{ agents: externalAgents \}\)/, '데크 배너: 외부 에이전트만 있는 회사');
  assert.match(deck, /<AiKeyBanner ws=\{ws\} agents=\{data\?\.agents \?\? \[\]\} \/>/);
  const crew = await readFile(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  assert.match(crew, /sel\.runner === 'http' \? externalAgentLabel\(/, '크루 러너 메뉴 이름');
  assert.equal((crew.match(/r\.id === 'http' \? t\('runner\.external'\) : r\.name/g) ?? []).length, 2, '피커 목록 2곳');
  assert.equal((crew.match(/r\.retired \? ` — \$\{t\('runner\.retired'\)\}` : r\.hidden \? ''/g) ?? []).length, 2, '제공 종료만 retired 라벨(카드 전용 숨김은 이름만)');
  const rc = await readFile(new URL('../app/runner-connect.jsx', import.meta.url), 'utf8');
  assert.match(rc, /\{id === 'http' \? t\('runner\.external'\) : RUNNER_NAMES\[id\]\}/, '설정 행 이름');
  const act = await readFile(new URL('../app/c/[ws]/activity/page.jsx', import.meta.url), 'utf8');
  assert.equal((act.match(/e\.runner === 'http' \? t\('runner\.external'\)/g) ?? []).length, 2, '활동 피드 2곳');
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['runner.external', 'agent.state.connecting', 'agent.state.ok', 'agent.state.fail', 'deck.runner.external']) { const line = i18n.split('\n').find((l) => l.startsWith(`  '${k}': [`)); assert.ok(line && /', '/.test(line), `i18n ko/en ${k}`); }
});
