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
const { chat, requiredReadPlan, requiredReadTargets, unsupportedOpenAICompatReadPath } = await import('../src/chat.mjs');

test.after(async () => { await rm(argoRoot, { recursive: true, force: true }); });

test('Qwen 파일 증거 경로 — 현재 지시의 명시 경로만 절대경로로 추출', () => {
  assert.deepEqual(requiredReadTargets(
    'vault/a.md와 skills/상품-선정.md를 실제로 읽고 /tmp/out/report.csv도 확인해. https://example.com/not-a-file.md와 input.md는 참고.',
    '/company',
  ), ['/company/vault/a.md', '/company/skills/상품-선정.md', '/tmp/out/report.csv']);
  assert.deepEqual(requiredReadTargets(
    'vault/input 파일을 읽고 vault/output.md로 저장한 뒤 /etc/hosts도 확인해',
    '/company',
  ), ['/company/vault/input', '/etc/hosts']);
  assert.deepEqual(requiredReadTargets('read vault/in.md and write vault/out.md', '/company'), ['/company/vault/in.md']);
  assert.deepEqual(requiredReadTargets('결과를 `vault/My Report.md` 파일에 저장하고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('write "vault/My Report.md", then read it', '/company'), ['/company/vault/My Report.md']);
  assert.deepEqual(requiredReadTargets('write vault/out.md and then read vault/out.md', '/company'), ['/company/vault/out.md']);
  assert.deepEqual(requiredReadTargets('write vault/out.md. Then read vault/out.md', '/company'), ['/company/vault/out.md']);
  assert.deepEqual(requiredReadTargets('vault/out.md에 저장한 뒤 vault/out.md를 읽어', '/company'), ['/company/vault/out.md']);
  assert.deepEqual(requiredReadTargets('vault/out.md에 저장해. 그런 다음 vault/out.md를 읽어', '/company'), ['/company/vault/out.md']);
  assert.deepEqual(requiredReadPlan('read vault/in.md, write vault/out.md, then read vault/out.md', '/company'), {
    targets: ['/company/vault/in.md', '/company/vault/out.md'], initialTargets: ['/company/vault/in.md'],
  });
  assert.deepEqual(requiredReadPlan('After writing vault/new.md, read it.', '/company'), {
    targets: ['/company/vault/new.md'], initialTargets: [],
  });
  assert.deepEqual(requiredReadPlan('Before writing vault/out.md, read it.', '/company'), {
    targets: ['/company/vault/out.md'], initialTargets: ['/company/vault/out.md'],
  });
  assert.deepEqual(requiredReadPlan('vault/out.md를 쓰기 전에 읽어.', '/company'), {
    targets: ['/company/vault/out.md'], initialTargets: ['/company/vault/out.md'],
  });
  assert.deepEqual(requiredReadPlan('Read input.md before writing output.md.', '/company'), {
    targets: ['/company/vault/input.md'], initialTargets: ['/company/vault/input.md'],
  });
  assert.deepEqual(requiredReadPlan('output.md를 쓰기 전에 input.md를 읽어.', '/company'), {
    targets: ['/company/vault/input.md'], initialTargets: ['/company/vault/input.md'],
  });
  assert.deepEqual(requiredReadPlan('output.md는 input.md를 읽고 나서 써.', '/company'), {
    targets: ['/company/vault/input.md'], initialTargets: ['/company/vault/input.md'],
  });
  assert.deepEqual(requiredReadPlan('input.md는 읽고 output.md를 써.', '/company'), {
    targets: ['/company/vault/input.md'], initialTargets: ['/company/vault/input.md'],
  });
  assert.deepEqual(requiredReadTargets('`vault/My Report.md`를 읽어', '/company'), ['/company/vault/My Report.md']);
  assert.deepEqual(requiredReadTargets('input.md와 output.md를 읽어', '/company'), ['/company/vault/input.md', '/company/vault/output.md']);
  assert.deepEqual(requiredReadTargets('`첫 보고서.md`와 `두 번째 보고서.md`를 읽어', '/company'), ['/company/vault/첫 보고서.md', '/company/vault/두 번째 보고서.md']);
  assert.deepEqual(requiredReadTargets('read vault/in.md; do not create anything yet, just explain how to save the result as "vault/My Report.md"', '/company'), ['/company/vault/in.md']);
  assert.deepEqual(requiredReadTargets('https://example.com/?file=input.md를 확인해', '/company'), []);
  assert.deepEqual(requiredReadTargets('URL https://example.com/#vault/a.md와 vault/local.md를 확인해', '/company'), ['/company/vault/local.md']);
  assert.deepEqual(requiredReadTargets('Do not read secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md는 읽지 말고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Read input.md, but not secret.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Read neither first.md nor secret.md.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Summarize without reading secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md는 안 읽고 input.md만 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md 말고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md는 읽으면 안 되고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Skip secret.md and read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Avoid reading secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Do not ever read secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Read every file other than secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Under no circumstances read secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Read input.md instead of secret.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md 외에 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('I do not want you to read secret.md; read input.md.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md를 절대 열어 보지 말고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md는 보지 말고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('secret.md는 검토하지 말고 input.md를 읽어', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Read input.md. Then summarize it.', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('Check Python 3.12 compatibility.', '/company'), []);
  assert.deepEqual(requiredReadTargets('버전 0.1.40과 2026.08.12 일정을 확인해', '/company'), []);
  assert.deepEqual(requiredReadTargets('Check IP 192.168.1.1 and package.json.', '/company'), ['/company/vault/package.json']);
  assert.deepEqual(requiredReadTargets('Check Node.js 24.16.0 compatibility.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Verify Next.js 16 and package.json.', '/company'), ['/company/vault/package.json']);
  assert.deepEqual(requiredReadTargets('Check Node.js and Next.js compatibility.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Check example.com status.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Read app.js and package.json.', '/company'), ['/company/vault/app.js', '/company/vault/package.json']);
  assert.deepEqual(requiredReadTargets('Read ./vault/a.md and notes/a.md.', '/company'), ['/company/vault/a.md', '/company/notes/a.md']);
  assert.deepEqual(requiredReadTargets('Read "C:\\Users\\me\\report.md".', '/company'), ['C:\\Users\\me\\report.md']);
  assert.deepEqual(requiredReadTargets('Review vault/a.md and analyze notes/a.md.', '/company'), ['/company/vault/a.md', '/company/notes/a.md']);
  assert.deepEqual(requiredReadTargets('vault/a.md를 분석하고 notes/a.md를 요약해줘.', '/company'), ['/company/vault/a.md', '/company/notes/a.md']);
  assert.deepEqual(requiredReadTargets('Read about Node.js.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Read more about Node.js.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Read about Next.js and Node.js.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Review Node.js documentation.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Analyze Node.js performance.', '/company'), []);
  assert.deepEqual(requiredReadTargets('Tell me what package.json is and how to read it.', '/company'), []);
  assert.deepEqual(requiredReadTargets('How do I read CSV files in app.js?', '/company'), []);
  assert.deepEqual(requiredReadTargets('projects/result.md와 files/source.csv를 읽어', '/company'), ['/company/vault/projects/result.md', '/company/vault/files/source.csv']);
  assert.deepEqual(requiredReadTargets('input.md를 봐', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('input.md를 검토해', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('`vault/회의`를 읽어', '/company'), ['/company/vault/회의']);
  assert.deepEqual(requiredReadTargets('input.md를 읽고 output.md에 써줘', '/company'), ['/company/vault/input.md']);
  assert.deepEqual(requiredReadTargets('vault/a.md 이름만 답해', '/company'), []);
  assert.equal(unsupportedOpenAICompatReadPath('vault/report.docx'), true);
  assert.equal(unsupportedOpenAICompatReadPath('vault/report.md'), false);
  assert.equal(unsupportedOpenAICompatReadPath('vault/audio.m4a'), true);
  assert.equal(unsupportedOpenAICompatReadPath('vault/video.webm'), true);
  assert.deepEqual(requiredReadTargets('Read report.doc and report.ods.', '/company'), ['/company/vault/report.doc', '/company/vault/report.ods']);
});

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

test('Qwen chat 파일 증거 게이트 — 도구 없는 성공 답변을 저장하지 않고 대상별 read_file을 강제', async () => {
  const wsId = 'qwen-evidence-chat';
  await createCompany(wsId, 'Evidence Co', 'Captain');
  const p = paths(wsId);
  const card = `---\nname: 지나\nslug: jina\nrole: 검증자\nrunner: deepseeklocal\nmodel: qwen3.6-27b-q4\n---\n\n# 지나\n`;
  await saveRunnerCred(wsId, 'deepseeklocal', 'apikey', 'http://llama.fixture:8080|fixture-qwen-value');
  await import('node:fs/promises').then(({ writeFile }) => Promise.all([
    writeFile(join(p.agents, 'jina.md'), card),
    writeFile(join(p.vault, 'a.md'), '# A\n'),
    writeFile(join(p.vault, 'b.md'), '# B\n'),
  ]));
  await saveAgentCard(wsId, 'jina', card);

  const realFetch = globalThis.fetch;
  const requests = [];
  const replies = [
    { content: 'read_file로 두 파일을 읽었습니다.' },
    { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/a.md"}' } }] },
    { content: '두 파일 모두 확인했습니다.' },
    { content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/b.md"}' } }] },
    { content: 'A와 B 원문을 실제로 확인했습니다.' },
  ];
  globalThis.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      model: 'qwen3.6-27b-q4', choices: [{ message: replies.shift() }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  };
  try {
    const result = await chat(wsId, 'jina', 'vault/a.md와 vault/b.md를 각각 실제로 읽고 첫 줄을 확인해줘');
    assert.equal(result.reply, 'A와 B 원문을 실제로 확인했습니다.');
    assert.deepEqual(requests.map((request) => request.tool_choice), ['required', 'required', 'required', 'required', 'auto']);
    const usage = JSON.parse((await readFile(p.usage, 'utf8')).trim());
    assert.deepEqual(usage.tools, { Read: 2 });
    const events = (await readFile(join(p.root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).steps.filter((step) => step.stage === 'memory').length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
