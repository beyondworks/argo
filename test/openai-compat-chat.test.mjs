import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argoRoot = await mkdtemp(join(tmpdir(), 'argo-openai-chat-'));
process.env.ARGO_ROOT = argoRoot;
const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveAgentCard } = await import('../src/persona.mjs');
const { saveRunnerCred } = await import('../src/runners.mjs');
const { chat } = await import('../src/chat.mjs');

test.after(async () => { await rm(argoRoot, { recursive: true, force: true }); });

test('Qwen chat 통합 — 실제 chat 경로가 파일 tool_calls를 실행하고 일지·사용량·산출물을 남긴다', async () => {
  const wsId = 'qwen-tool-chat';
  await createCompany(wsId, 'Qwen Tool Co', 'Captain');
  const p = paths(wsId);
  const card = `---\nname: 지나\nslug: jina\nrole: 상품 리서처\nrunner: deepseeklocal\nmodel: qwen3.6-27b-q4\n---\n\n# 지나 — 상품 리서처\n\n## 전문성\n- 상품 비교\n\n## 일하는 방식\n- 파일 근거 우선\n\n## 톤\n간결함\n`;
  await saveRunnerCred(wsId, 'deepseeklocal', 'apikey', 'http://llama.fixture:8080|fixture-qwen-value');
  // saveAgentCard는 기존 카드만 편집하므로 스캐폴드의 agents 경로에 초깃값을 먼저 둔다.
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(p.agents, 'jina.md'), card));
  await saveAgentCard(wsId, 'jina', card);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(p.vault, 'input.md'), 'Alpha 평점 4.8\nBeta 평점 4.2\n'));

  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const n = requests.length;
    const message = n === 1
      ? { content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/input.md"}' } }] }
      : n === 2
        ? { content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{"path":"vault/projects/result.md","content":"Alpha를 선택합니다."}' } }] }
        : { content: '파일을 읽고 선정 결과를 저장했습니다.' };
    return new Response(JSON.stringify({
      model: 'qwen3.6-27b-q4', choices: [{ message, finish_reason: n < 3 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200 });
  };
  try {
    const result = await chat(wsId, 'jina', 'input.md를 읽고 평점이 높은 상품을 골라 result.md에 저장해줘');
    assert.equal(result.reply, '파일을 읽고 선정 결과를 저장했습니다.');
    assert.equal(await readFile(join(p.vault, 'projects', 'result.md'), 'utf8'), 'Alpha를 선택합니다.');
    assert.deepEqual(result.artifacts, ['projects/result.md']);
    assert.ok(result.handover?.file, '일지 생성');
    assert.ok(requests[0].tools.some((t) => t.function.name === 'read_file'));
    assert.equal(requests[1].messages.at(-1).role, 'tool');
    const usage = await readFile(p.usage, 'utf8');
    assert.match(usage, /"runner":"deepseeklocal"/);
    assert.match(usage, /"Read":1/);
    assert.match(usage, /"Write":1/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
