import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepseekLocalCall,
  parseDeepseekLocalCredential,
  runOpenAICompatToolLoop,
  verifyDeepseekLocal,
} from '../src/runners/deepseek-local.mjs';
import { DEEPSEEK_LOCAL_DEFAULT_MODEL, RUNNERS } from '../src/runners/catalog.mjs';

test('DeepSeek Local 카탈로그 — 서버의 Qwen 3.6 27B 모델을 기본값으로 사용', () => {
  assert.equal(DEEPSEEK_LOCAL_DEFAULT_MODEL, 'qwen3.6-27b-q4');
  assert.equal(RUNNERS.deepseeklocal.name, 'Qwen 3.6 27B');
  assert.deepEqual(RUNNERS.deepseeklocal.models, [
    { id: 'qwen3.6-27b-q4', label: 'Qwen 3.6 27B (Q4)' },
  ]);
});

test('DeepSeek Local 자격 파싱 — URL-only, API-key-only, URL|API-key', () => {
  assert.deepEqual(parseDeepseekLocalCredential('http://llama.local:8080/'), {
    baseUrl: 'http://llama.local:8080/', apiKey: '',
  });
  assert.deepEqual(parseDeepseekLocalCredential('http://llama.local:8080/v1|fixture-value'), {
    baseUrl: 'http://llama.local:8080/v1', apiKey: 'fixture-value',
  });
  assert.deepEqual(parseDeepseekLocalCredential('fixture-value'), {
    baseUrl: 'http://100.103.65.62:8080', apiKey: 'fixture-value',
  });
  assert.deepEqual(parseDeepseekLocalCredential('http://llama.local:8080|fixture|value'), {
    baseUrl: 'http://llama.local:8080', apiKey: 'fixture|value',
  });
});

test('DeepSeek Local 검증 — 인증 실패 401은 거절하고 인증 통과 후 400 형식 오류는 통과', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'server-model' }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
  };
  try {
    assert.deepEqual(await verifyDeepseekLocal('http://llama.local:8080', 'fixture-value'), { ok: false });
    assert.equal(calls[1].body.model, 'server-model');
    assert.equal(calls[1].body.messages, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('DeepSeek Local 검증 — messages 누락 400은 인증 통과로 판정', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith('/v1/models')
    ? new Response(JSON.stringify({ data: [{ id: 'server-model' }] }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: "'messages' is required" } }), { status: 400 });
  try {
    assert.deepEqual(await verifyDeepseekLocal('http://llama.local:8080/v1', 'fixture-value'), { ok: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('DeepSeek Local 호출 — Bearer 자격과 서버 모델을 completion에 전달', async () => {
  const realFetch = globalThis.fetch;
  let request = null;
  let requestUrl = '';
  globalThis.fetch = async (url, init = {}) => {
    requestUrl = String(url);
    request = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 1 } }), { status: 200 });
  };
  try {
    const result = await deepseekLocalCall('http://llama.local:8080', {
      userMessage: 'ping', model: 'server-model', apiKey: 'fixture-value', timeoutMs: 1000,
    });
    assert.equal(result.text, 'OK');
    assert.equal(requestUrl, 'http://llama.local:8080/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer fixture-value');
    assert.equal(JSON.parse(request.body).model, 'server-model');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 호출 — 외부 중단 신호가 있어도 요청 시간 제한을 유지', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  try {
    await assert.rejects(
      deepseekLocalCall('http://llama.local:8080', {
        userMessage: 'hang', timeoutMs: 10, signal: new AbortController().signal,
      }),
      (error) => error?.name === 'TimeoutError',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — tools 전달 → tool_calls 실행 → role=tool 재주입 → 최종 답변', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  let round = 0;
  globalThis.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(init.body));
    round += 1;
    if (round === 1) {
      return new Response(JSON.stringify({
        model: 'server-model',
        choices: [{ message: { content: null, tool_calls: [{
          id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/a.md"}' },
        }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model: 'server-model', choices: [{ message: { content: '파일을 확인했다.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }), { status: 200 });
  };
  const executed = [];
  try {
    const result = await runOpenAICompatToolLoop('http://llama.local:8080', {
      systemPrompt: 'system', userMessage: '파일 읽어', model: 'server-model', apiKey: 'fixture-value',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      executeTool: async (name, args) => { executed.push({ name, args }); return '1: hello'; },
    });
    assert.equal(result.text, '파일을 확인했다.');
    assert.deepEqual(executed, [{ name: 'read_file', args: { path: 'vault/a.md' } }]);
    assert.equal(requests[0].tool_choice, 'auto');
    assert.equal(requests[0].tools[0].function.name, 'read_file');
    assert.deepEqual(requests[1].messages.slice(-2), [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/a.md"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: '1: hello' },
    ]);
    assert.deepEqual(result.usage, { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 });
    assert.equal(result.model, 'server-model');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 잘못된 JSON 인자는 오류 tool 결과로 모델에 돌려보낸다', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return new Response(JSON.stringify(requests.length === 1
      ? { choices: [{ message: { tool_calls: [{ id: 'bad-1', type: 'function', function: { name: 'read_file', arguments: '{bad' } }] } }] }
      : { choices: [{ message: { content: '인자를 고쳐야 한다.' } }] }), { status: 200 });
  };
  try {
    const result = await runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: 'read', tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      executeTool: async () => { throw new Error('호출되면 안 됨'); },
    });
    assert.equal(result.text, '인자를 고쳐야 한다.');
    assert.match(requests[1].messages.at(-1).content, /도구 호출 오류\(read_file\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 증거 없는 최종 답변을 폐기하고 required 도구 호출로 재시도', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  const replies = [
    { content: '두 파일을 모두 읽었다.' },
    { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/a.md"}' } }] },
    { content: '이제 모두 확인했다.' },
    { content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/b.md"}' } }] },
    { content: '실제 두 파일을 확인했다.' },
  ];
  globalThis.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }), { status: 200 });
  };
  try {
    const result = await runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: 'a와 b를 읽어',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      executeTool: async (_name, args) => `read:${args.path}`,
      validateFinal: ({ calls }) => {
        const read = new Set(calls.map((call) => call.args.path));
        const missing = ['vault/a.md', 'vault/b.md'].filter((path) => !read.has(path));
        return missing.length ? `missing ${missing.join(', ')}` : null;
      },
    });
    assert.equal(result.text, '실제 두 파일을 확인했다.');
    assert.deepEqual(result.calls.map((call) => call.args.path), ['vault/a.md', 'vault/b.md']);
    assert.equal(requests[0].tool_choice, 'required');
    assert.equal(requests[1].tool_choice, 'required');
    assert.equal(requests[2].tool_choice, 'required');
    assert.equal(requests[3].tool_choice, 'required');
    assert.match(requests[1].messages.at(-1).content, /vault\/a\.md/);
    assert.match(requests[3].messages.at(-1).content, /vault\/b\.md/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 증거 재시도 상한 뒤 거짓 성공 대신 실패', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '읽었다.' } }] }), { status: 200 });
  try {
    await assert.rejects(runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: '파일 읽어', maxEvidenceRetries: 1,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      executeTool: async () => 'unused', validateFinal: () => 'vault/a.md 누락',
    }), /필수 도구 증거를 확보하지 못했다/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 증거 강제 라운드는 read_file 외 도구를 노출하거나 실행하지 않음', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  const replies = [
    { content: '읽었다.' },
    { content: null, tool_calls: [{ id: 'wrong-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/wrong.md"}' } }] },
    { content: null, tool_calls: [{ id: 'bad-write', type: 'function', function: { name: 'write_file', arguments: '{"path":"vault/input.md","content":"overwrite"}' } }] },
    { content: '완료했다.' },
  ];
  const executed = [];
  globalThis.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }), { status: 200 });
  };
  try {
    await assert.rejects(runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: 'input.md를 읽어', maxEvidenceRetries: 1, maxRounds: 4,
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } },
      ],
      executeTool: async (name) => { executed.push(name); return '실행됨'; },
      validateFinal: () => 'input.md 누락',
    }), /필수 도구 증거를 확보하지 못했다/);
    assert.deepEqual(requests[1].tools.map((tool) => tool.function.name), ['read_file']);
    assert.deepEqual(requests[2].tools.map((tool) => tool.function.name), ['read_file']);
    assert.equal(requests[2].tool_choice, 'required');
    assert.deepEqual(executed, ['read_file']);
    assert.deepEqual(requests[3].tools.map((tool) => tool.function.name), ['read_file']);
    assert.equal(requests[3].tool_choice, 'required');
    assert.match(requests[3].messages.at(-1).content, /허용되지 않은 도구/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 기존 입력 증거 뒤 출력 쓰기와 재읽기를 순서대로 허용', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  const replies = [
    { content: null, tool_calls: [{ id: 'read-in', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/in.md"}' } }] },
    { content: null, tool_calls: [{ id: 'write-out', type: 'function', function: { name: 'write_file', arguments: '{"path":"vault/out.md","content":"result"}' } }] },
    { content: null, tool_calls: [{ id: 'read-out', type: 'function', function: { name: 'read_file', arguments: '{"path":"vault/out.md"}' } }] },
    { content: '입력과 저장 결과를 모두 확인했다.' },
  ];
  const read = new Set();
  globalThis.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: replies.shift() }] }), { status: 200 });
  };
  try {
    const result = await runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: 'read vault/in.md, write vault/out.md, then read vault/out.md',
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } },
      ],
      executeTool: async (name, args) => {
        if (name === 'read_file') read.add(args.path);
        return `${name}:${args.path}`;
      },
      forceEvidence: () => read.has('vault/in.md') ? null : 'input missing',
      validateFinal: () => ['vault/in.md', 'vault/out.md'].every((path) => read.has(path)) ? null : 'read missing',
    });
    assert.equal(result.text, '입력과 저장 결과를 모두 확인했다.');
    assert.deepEqual(result.calls.map((call) => call.name), ['read_file', 'write_file', 'read_file']);
    assert.deepEqual(requests.map((request) => request.tool_choice), ['required', 'auto', 'auto', 'auto']);
    assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ['read_file']);
    assert.deepEqual(requests[1].tools.map((tool) => tool.function.name), ['read_file', 'write_file']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 전체 턴 제한이 도구 실행 시간까지 중단 신호로 묶음', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [{
      id: 'slow-1', type: 'function', function: { name: 'run_command', arguments: '{"command":"slow"}' },
    }] } }],
  }), { status: 200 });
  let toolAborted = false;
  try {
    await assert.rejects(runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: 'slow', timeoutMs: 15,
      tools: [{ type: 'function', function: { name: 'run_command', parameters: { type: 'object' } } }],
      executeTool: async (_name, _args, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { toolAborted = true; resolve('중단됨'); }, { once: true });
      }),
    }), (error) => error?.name === 'TimeoutError');
    assert.equal(toolAborted, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenAI 호환 도구 루프 — 사용자 중단 뒤 같은 배치의 나머지 도구를 실행하지 않음', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: null, tool_calls: [
      { id: 'first', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'second', type: 'function', function: { name: 'write_file', arguments: '{}' } },
    ] } }],
  }), { status: 200 });
  const controller = new AbortController();
  const executed = [];
  try {
    await assert.rejects(runOpenAICompatToolLoop('http://llama.local:8080', {
      userMessage: 'stop', signal: controller.signal,
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      executeTool: async (name) => {
        executed.push(name);
        controller.abort(new DOMException('사용자 중단', 'AbortError'));
        throw controller.signal.reason;
      },
    }), (error) => error?.name === 'AbortError');
    assert.deepEqual(executed, ['read_file']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
