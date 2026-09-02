// OpenRouter 첫 게이트 — 실키 tool_use 스모크 (설계 2026-07-27의 "구현 첫 게이트").
// 카탈로그 규칙: RUNNERS.openrouter.models·OPENROUTER_DEFAULT_MODEL·OPENROUTER_ONBOARD_MODEL에는 **이 스모크를
// 통과한 id만** 넣는다. 문서·감으로 추가 금지.
//
// 사용법(키는 env로만 — 채팅·파일에 평문 금지):
//   OPENROUTER_API_KEY=... node scripts/openrouter-smoke.mjs [모델id ...]
// 모델 인자를 생략하면 후보 셋(아래 CANDIDATES)을 전부 돌린다.
// 검사 3종: ① Anthropic 호환 /v1/messages 일반 응답 ② tool_use 블록 왕복(도구 결과 재투입)
// ③ 스트리밍 여부는 SDK가 관리하므로 비스트리밍 왕복만 본다(SDK 실턴은 이후 격리 E2E가 담당).
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY env가 필요합니다 (키를 채팅·파일에 쓰지 말 것)'); process.exit(2); }
const BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api';

const CANDIDATES = process.argv.slice(2).length ? process.argv.slice(2) : [
  // 카탈로그와 동기화(2026-09-02) — 이 목록이 낡으면 인자 없는 실행이 신규 등재분을 검증하지 않는다(검수 MEDIUM-3).
  // 카탈로그를 바꾸면 여기도 같이: RUNNERS.openrouter.models의 id 전부.
  'minimax/minimax-m3:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'minimax/minimax-m2.7:free',
  'anthropic/claude-haiku-4.5', 'openai/gpt-5.5', 'google/gemini-3.7-flash', 'x-ai/grok-4.6', 'x-ai/grok-4.5',
  'minimax/minimax-m3', 'qwen/qwen3.7-max', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k3', 'z-ai/glm-5.3', 'z-ai/glm-5.2',
];

const TOOL = {
  name: 'get_ship_name',
  description: 'Returns the name of the ship. Call this to answer.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

async function messages(body) {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 비JSON 응답 그대로 보고 */ }
  return { status: r.status, json, text };
}

async function smoke(model) {
  // ① 일반 응답 — max_tokens는 추론형(thinking) 모델의 사고 예산까지 포함해 넉넉히(32면 오탐 FAIL 실측)
  const a = await messages({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'reply with exactly: ok' }] });
  const aText = a.json?.content?.find((c) => c.type === 'text')?.text ?? '';
  if (a.status !== 200 || !aText) return { model, pass: false, stage: 'basic', detail: `${a.status} ${a.text.slice(0, 120)}` };

  // ② tool_use 왕복 — 도구 호출을 내고, tool_result를 돌려줬을 때 답을 완성하는가
  const req = {
    model, max_tokens: 1024, tools: [TOOL], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: 'Use the get_ship_name tool, then tell me the ship name.' }],
  };
  const b = await messages(req);
  const toolUse = b.json?.content?.find((c) => c.type === 'tool_use');
  if (b.status !== 200 || !toolUse) return { model, pass: false, stage: 'tool_use', detail: `${b.status} ${(b.json?.stop_reason ?? '')} ${b.text.slice(0, 120)}` };
  const c = await messages({
    ...req,
    messages: [
      ...req.messages,
      { role: 'assistant', content: b.json.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'Argo' }] },
    ],
  });
  const cText = (c.json?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join(' ');
  if (c.status !== 200 || !/argo/i.test(cText)) return { model, pass: false, stage: 'tool_result', detail: `${c.status} ${cText.slice(0, 120)}` };
  return { model, pass: true };
}

const results = [];
for (const m of CANDIDATES) {
  const r = await smoke(m).catch((e) => ({ model: m, pass: false, stage: 'error', detail: String(e.message ?? e).slice(0, 120) }));
  results.push(r);
  console.log(r.pass ? `PASS ${r.model}` : `FAIL ${r.model} [${r.stage}] ${r.detail}`);
}
const passed = results.filter((r) => r.pass).map((r) => r.model);
console.log(`\n통과 ${passed.length}/${results.length} — 카탈로그 반영 후보:`);
console.log(passed.map((m) => `  { id: '${m}', label: '${m.split('/')[1]}' },`).join('\n') || '  (없음 — 카탈로그 비워 둘 것)');
process.exit(passed.length === results.length && results.length > 0 ? 0 : 1); // 전수 통과만 green — 카탈로그 확정 게이트
