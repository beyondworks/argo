import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCrewContext } from '../src/crew-actions.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-codex-crew-config-'));
process.env.ARGO_ROOT = join(root, 'workspaces');
const { writeCodexTurnConfig } = await import('../src/runners.mjs');
const { codexArgoCrewPrompt } = await import('../src/chat.mjs');

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('Codex 턴 config에 Argo crew MCP와 호스트 Orca 스킬 차단을 함께 기록한다', async () => {
  const home = join(root, 'turn-home');
  const blocked = [
    '/home/test/.agents/skills/orchestration/SKILL.md',
    '/home/test/.agents/skills/orca-cli/SKILL.md',
  ];
  const crewContext = {
    wsId: 'company-1',
    fromSlug: 'master',
    fromName: '마스터',
    colleagues: [{ slug: 'sw-cto', name: 'SW CTO' }],
    hop: 0,
    chain: [],
    lang: 'ko',
  };
  await import('node:fs/promises').then(({ mkdir }) => mkdir(home, { recursive: true }));
  await writeCodexTurnConfig(home, { fs: false, browser: false }, [], {
    crewContext,
    disabledSkillPaths: blocked,
  });
  const config = await readFile(join(home, 'config.toml'), 'utf8');

  assert.match(config, /\[mcp_servers\.argo_crew\]/);
  assert.match(config, /required = true/);
  assert.match(config, /enabled_tools = \["delegate", "send_to_crew"\]/);
  assert.match(config, /codex-crew-mcp\.mjs/);
  for (const path of blocked) {
    assert.ok(config.includes(`path = ${JSON.stringify(path)}`));
  }
  const encoded = /ARGO_CREW_CONTEXT = "([^"]+)"/.exec(config)?.[1];
  assert.equal(decodeCrewContext(encoded).colleagues[0].slug, 'sw-cto');
});

test('Codex 프롬프트는 Argo 동료 조율에서 Orca 대체 실행을 명시적으로 금지한다', () => {
  const prompt = codexArgoCrewPrompt([{ slug: 'sw-cto', name: 'SW CTO' }], 'ko');
  assert.match(prompt, /Argo 내부 `delegate`와 `send_to_crew`/);
  assert.match(prompt, /`orca-ide`.*절대 실행하지 마라/);

  const depthLimited = codexArgoCrewPrompt([], 'en');
  assert.match(depthLimited, /delegation-depth limit/);
  assert.match(depthLimited, /do not substitute an external orchestrator/);
});
