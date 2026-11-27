// 원격 모델 카탈로그(model-catalog.json, argo-agent 릴리스 자산) — 코드 목록에서 뺀 모델을 **옛 앱**에도 적용하는 길.
// 발행(release.yml server 잡)이 scripts/gen-model-catalog.mjs 산출물로 자산을 덮어쓰므로, 폐기 모델의 retire/alias가 LEGACY에 없으면
// 옛 앱의 그 에이전트는 벤더 종료일부터 실패한다. 새 앱은 catalog.mjs RETIRED_MODEL_ALIASES로 원격 없이도 옮긴다 — 두 표가 어긋나지 않게 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { RUNNERS, RETIRED_MODEL_ALIASES } from '../src/runners/catalog.mjs';
import { validateOverlay, applyOverlay } from '../src/runners/catalog-remote.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), 'argo-model-catalog-')), 'model-catalog.json');
execFileSync(process.execPath, [join(repo, 'scripts', 'gen-model-catalog.mjs'), out], { cwd: repo, stdio: 'pipe' });
const doc = JSON.parse(await readFile(out, 'utf8'));

test('GPT-5.5 종료 — 생성한 카탈로그가 옛 앱의 Codex 목록에서 gpt-5.5를 빼고 GPT-5.6 Sol로 옮긴다', () => {
  const v = validateOverlay(doc);
  assert.ok(v, '스키마 검증 통과');
  assert.deepEqual(v.runners.codex.retire, ['gpt-5.5']);
  assert.deepEqual(v.runners.codex.alias, { 'gpt-5.5': 'gpt-5.6-sol' });
  // 옛 앱(0.1.99 이하 — 코드 목록에 gpt-5.5가 있고, normalizeModelId는 오버레이 alias만 본다)의 판정을 흉내 낸다
  const oldCodex = [...RUNNERS.codex.models, { id: 'gpt-5.5', label: 'GPT-5.5' }];
  const listed = applyOverlay('codex', oldCodex, v);
  assert.equal(listed.some((m) => m.id === 'gpt-5.5'), false, '모델 목록에서 빠진다');
  assert.ok(listed.some((m) => m.id === v.runners.codex.alias['gpt-5.5']), 'alias 목적지가 옛 앱 목록에 있다(없으면 기본 모델로 강등)');
  assert.equal(doc.baseline.codex.includes('gpt-5.5'), false);
});

test('코드 대체표의 모든 항목이 생성 카탈로그에도 retire·alias로 있다 — 새 앱만 고치고 옛 앱을 빠뜨리지 않게', () => {
  const v = validateOverlay(doc);
  for (const [rid, map] of Object.entries(RETIRED_MODEL_ALIASES)) {
    for (const [from, { to, effort }] of Object.entries(map)) {
      assert.ok(['low', 'medium', 'high', 'xhigh'].includes(effort), `${rid}/${from} 옛 기본 강도는 대체 모델도 받는 값`);
      assert.ok(v.runners[rid].retire.includes(from), `${rid}/${from} retire`);
      assert.equal(v.runners[rid].alias[from], to, `${rid}/${from} alias`);
      assert.equal(RUNNERS[rid].models.some((m) => m.id === from), false, `${rid}/${from}는 코드 목록에서 빠져야 한다`);
      assert.ok(RUNNERS[rid].models.some((m) => m.id === to), `${rid}/${to}는 코드 목록에 있어야 한다`);
    }
  }
});

test('Codex alias 목적지는 핀 0.157.1 옛 앱에서도 도는 모델이다 — GPT-6.1 Sol은 그 핀에서 400(2026-10-07 실측)', () => {
  for (const to of Object.values(doc.runners.codex.alias)) assert.notEqual(to, 'gpt-6.1-sol');
});

test('Gemini 2.5 새 계정 404(2026-10-14) — 옛 앱 목록에 3.8 Flash를 넣고 2.5를 옮기되, 첫 항목은 그대로 둔다', () => {
  const v = validateOverlay(doc);
  assert.deepEqual(v.runners.gemini.alias, { 'gemini-2.5-pro': 'gemini-3.8-flash', 'gemini-2.5-flash': 'gemini-3.8-flash' });
  assert.deepEqual(v.runners.gemini.retire, [], '2.5를 빼면 옛 앱 첫 항목이 무료 등급 없는 게이트 모델이 된다');
  // 옛 앱(0.1.107) 코드 목록 그대로 — 2.5 둘이 앞, 3.8 Flash 없음
  const old = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash'].map((id) => ({ id, label: id, ...(id.startsWith('gemini-3') ? { gated: true } : {}) }));
  const listed = applyOverlay('gemini', old, v);
  assert.ok(listed.some((m) => m.id === 'gemini-3.8-flash' && !m.gated), 'alias 목적지가 옛 앱 목록에 있다(없으면 기본 2.5 Pro로 강등 — 404)');
  assert.equal(listed[0].gated, undefined, '러너 전환 때 고르는 첫 항목은 게이트 모델이 아니다');
  // 새 앱: 2.5는 코드 목록에 없고 첫 항목이 alias 목적지
  assert.equal(RUNNERS.gemini.models.some((m) => /^gemini-2\.5/.test(m.id)), false);
  assert.equal(RUNNERS.gemini.models[0].id, 'gemini-3.8-flash');
});

test('Antigravity 2026-11-27 — 종료·Enterprise 전용이 된 옛 id를 같은 사고 수준의 Gemini 4 Hydrogen으로, 가장 옛 앱에서도', () => {
  const v = validateOverlay(doc);
  const map = {
    'claude-sonnet-4-6': 'gemini-4-hydrogen-medium', 'claude-opus-4-6-thinking': 'gemini-4-hydrogen-high', 'gpt-oss-120b-medium': 'gemini-4-hydrogen-medium',
    'gemini-3.7-flash-medium': 'gemini-4-hydrogen-medium', 'gemini-3.7-flash-high': 'gemini-4-hydrogen-high', 'gemini-3.7-flash-low': 'gemini-4-hydrogen-low',
    'gemini-3.6-flash-medium': 'gemini-4-hydrogen-medium', 'gemini-3.6-flash-high': 'gemini-4-hydrogen-high', 'gemini-3.6-flash-low': 'gemini-4-hydrogen-low',
    'gemini-3.1-pro-high': 'gemini-4-hydrogen-high', 'gemini-3.1-pro-low': 'gemini-4-hydrogen-low',
  };
  assert.deepEqual(v.runners.antigravity.alias, map);
  assert.deepEqual([...v.runners.antigravity.retire].sort(), Object.keys(map).sort());
  // Antigravity가 처음 들어온 판(#129, 2026-07-27)과 3.7이 들어온 판(2026-09-01)의 코드 목록
  const firstApp = ['gemini-3.6-flash-medium', 'gemini-3.6-flash-high', 'gemini-3.6-flash-low', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];
  const sepApp = ['gemini-3.7-flash-medium', 'gemini-3.7-flash-high', 'gemini-3.7-flash-low', ...firstApp];
  for (const old of [firstApp, sepApp]) {
    const listed = applyOverlay('antigravity', old.map((id) => ({ id, label: id })), v);
    assert.equal(listed.some((m) => old.includes(m.id)), false, '옛 id는 옛 앱 목록에서 모두 빠진다');
    for (const to of new Set(Object.values(map))) assert.ok(listed.some((m) => m.id === to), `${to}가 옛 앱 목록에 들어간다(alias 목적지)`);
    assert.equal(listed[0].id, 'gemini-4-hydrogen-medium', '옛 앱의 러너 전환 기본값 = 무료 요금제도 쓰는 Hydrogen Medium');
  }
  // 새 앱: 옛 id는 코드 목록에 없고, 목적지는 모두 있고, 첫 항목은 무료 요금제 모델
  for (const id of Object.keys(map)) assert.equal(RUNNERS.antigravity.models.some((m) => m.id === id), false, `${id}는 코드 목록에서 빠진다`);
  for (const to of new Set(Object.values(map))) assert.ok(RUNNERS.antigravity.models.some((m) => m.id === to && !m.gated), `${to}는 코드 목록에 무료 모델로 있다`);
  assert.equal(RUNNERS.antigravity.models[0].id, 'gemini-4-hydrogen-medium');
  assert.equal(RUNNERS.antigravity.models[0].gated, undefined);
  assert.equal(doc.baseline.antigravity.some((id) => id in map), false);
});

test('OpenRouter nemotron-3-super 무료판 소멸(2026-11-16 공개 목록) — 무료 3.5 Lightning으로 옮긴다(무료↔유료 티어를 넘지 않게)', () => {
  const v = validateOverlay(doc);
  const gone = 'nvidia/nemotron-3-super-120b-a12b:free';
  assert.ok(v.runners.openrouter.retire.includes(gone));
  assert.equal(v.runners.openrouter.alias[gone], 'nvidia/nemotron-3.5-lightning:free');
  assert.ok(v.runners.openrouter.add.some((m) => m.id === 'nvidia/nemotron-3.5-lightning:free' && m.free), '목적지가 옛 앱 목록에 무료로 들어간다');
  // 코드 목록에는 대체 무료 모델이 스모크를 통과할 때까지 남는다(무료 2종 전제). 원격 retire가 새 앱 목록에서도 뺀다.
  assert.equal(applyOverlay('openrouter', RUNNERS.openrouter.models, v).some((m) => m.id === gone), false, '새 앱 유효 목록에서도 빠진다');
});
