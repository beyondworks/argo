// 용어 변경 T2a(경우 표 B1) — 러너마다 **실제로 모델에게 가는 지시문**에 새 낱말만 있고, 옛 기록 해석 한 줄(M11)이 실린다.
// systemPromptFor는 한 함수지만 CLI(codex exec·gemini CLI·antigravity)·SDK(claude)·네이티브(openrouter·glm·kimi·grok·gemini 키·codex 키)가
// 각자 조립한다. 함수 단위 테스트로는 "어느 러너가 이 한 줄을 빠뜨렸나"를 못 본다 — chat()째 돌려 러너가 받은 글을 잡는다.
// 실벤더·실CLI 호출 0: 메시지 와이어·gemini·Responses는 로컬 가짜 서버, CLI는 externalExec만 로더 훅으로 바꾼다(chat-steer-cli와 같은 기법).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-terms-runner-'));
const home = await mkdtemp(join(tmpdir(), 'argo-terms-runner-home-'));
process.env.HOME = process.env.USERPROFILE = home; // 러너 env 조립(compatSdkEnv)이 실 홈에 폴더를 만들지 않게 — compat-runner-sdk-isolation 스위프 규칙
Object.assign(process.env, { ARGO_ROOT: root, ARGO_CACHE_DIR: join(root, 'cache'), ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', CLAUDE_CODE_MAX_RETRIES: '0' });
delete process.env.ARGO_NATIVE_RUNNERS;
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

// ── 가짜 서버 셋 — 받은 시스템 글을 러너 이름별로 모은다 ──
const seen = {}; // runner → [시스템 글]
let current = '?';
const listen = (handler) => new Promise((r) => { const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => handler(req, res, JSON.parse(b || '{}'))); }); s.listen(0, '127.0.0.1', () => r(s)); });
const textOf = (sys) => (Array.isArray(sys) ? sys.map((s) => s.text ?? '').join('\n') : String(sys ?? ''));
const messages = await listen((req, res, body) => {
  if ((body.tools ?? []).length) (seen[current] ??= []).push({ via: 'messages', text: textOf(body.system) }); // 도구 없는 요청 = SDK 세션 제목 생성 — 턴이 아니다
  const content = [{ type: 'text', text: '답' }];
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '답' } });
  ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }); ev('message_stop', {}); res.end();
});
const gemini = await listen((req, res, body) => {
  (seen[current] ??= []).push({ via: 'gemini', text: (body.systemInstruction?.parts ?? []).map((p) => p.text).join('\n') });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '답' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }));
});
const responses = await listen((req, res, body) => {
  (seen[current] ??= []).push({ via: 'responses', text: String(body.instructions ?? '') });
  const done = { type: 'response.completed', response: { id: 'r', model: body.model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '답' }] }], usage: { input_tokens: 1, output_tokens: 1 } } };
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: ${done.type}\ndata: ${JSON.stringify(done)}\n\n`);
});
const base = (s) => `http://127.0.0.1:${s.address().port}`;
for (const k of ['ARGO_CLAUDE_BASE_URL', 'OPENROUTER_BASE_URL', 'GLM_BASE_URL', 'KIMI_BASE_URL', 'GROK_BASE_URL']) process.env[k] = base(messages);
process.env.GEMINI_BASE_URL = base(gemini);
process.env.ARGO_OPENAI_BASE_URL = base(responses);

// ── CLI 러너 — 러너 해석·자격 형태·실행만 바꾼다(globalThis.__termsCli가 있을 때만. 없으면 실제 함수) ──
const real = new URL('../src/runners.mjs', import.meta.url).href;
const wrapper = `data:text/javascript,${encodeURIComponent(`import * as R from ${JSON.stringify(real)}; export * from ${JSON.stringify(real)};
  export const resolveRunner = async (...a) => globalThis.__termsCli ? ({ runner: globalThis.__termsCli, available: true, fellBack: false }) : R.resolveRunner(...a);
  export const runnerCredType = async (...a) => globalThis.__termsCli ? 'host' : R.runnerCredType(...a);
  export const runnerCredEnv = async (...a) => globalThis.__termsCli ? ({}) : R.runnerCredEnv(...a);
  export const isBilledRunner = async () => false;
  export const externalExec = async (args) => { (globalThis.__termsSeen[globalThis.__termsKey] ??= []).push({ via: 'cli', text: args.prompt }); return '답'; };`)}`;
const connectors = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(new URL('../src/connectors.mjs', import.meta.url).href)}; export const connectorBriefing = async () => [];`)}`;
globalThis.__termsSeen = seen;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './runners.mjs') return { url: wrapper, shortCircuit: true };
  if (context.parentURL?.endsWith('/src/chat.mjs') && specifier === './connectors.mjs') return { url: connectors, shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); for (const s of [messages, gemini, responses]) s.close(); delete globalThis.__termsCli; delete globalThis.__termsSeen; delete globalThis.__termsKey; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { LEGACY_RECORD_TERMS_NOTE, USER_ADDRESS_NOTE } = await import('../src/legacy-terms.mjs'); // 테스트 등록 사이에 await를 두지 않는다(앞 테스트가 끝나 after()가 서버를 닫는다)
const { userAddressNote } = await import('../src/user-name.mjs');
// T5(경우 표 B5) — 로그인한 기기(기기 세션에 프로필 이름)라 러너마다 같은 사용자 이름 한 줄을 받는다. url은 닫힌 포트(턴은 Supabase를 부르지 않는다 — test/user-name.test.mjs)
await writeFile(join(root, '.device-session.json'), JSON.stringify({ url: 'http://127.0.0.1:9', anonKey: 'anon', user: { id: 'u-terms', email: 't@example.invalid', name: '유건', nameAt: Date.now() }, access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });

const KEYS = {
  claude: ['apikey', `sk-ant-api03-${'x'.repeat(80)}`], openrouter: ['apikey', `sk-or-v1-${'f'.repeat(64)}`], glm: ['apikey', `glm-${'a'.repeat(40)}`],
  kimi: ['apikey', `sk-${'k'.repeat(48)}`], grok: ['apikey', `xai-${'g'.repeat(60)}`], gemini: ['apikey', `AIza${'x'.repeat(35)}`], codex: ['apikey', 'fake-openai-key-000000'],
}; // 형식만 맞춘 가짜 — 요청은 위 로컬 가짜 서버로만 간다

/** 한 러너로 한 턴 — 러너가 받은 시스템 글들(첫 요청부터) */
async function turnWith(runner, lang, { cli = false, rules = null, tag = '' } = {}) {
  const ws = `terms-${runner}-${cli ? 'cli' : 'api'}-${lang}${tag}`;
  await createCompany(ws, '용어', 'owner', null, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  if (rules != null) { await mkdir(paths(ws).skills, { recursive: true }); await writeFile(join(paths(ws).skills, 'captain-rules.md'), rules); } // 확정 규칙(교정 채택 — corrections.mjs RULES_SKILL)
  await writeFile(join(paths(ws).agents, 'a.md'), `---\nname: 에이\nrole: 검증\nrunner: ${runner}\n---\n검증용 카드.\n`);
  if (!cli) await saveRunnerCred(ws, runner, ...KEYS[runner]);
  const key = ws; // 턴마다 따로 모은다(앞 턴의 글을 다음 턴 결과로 읽지 않게)
  seen[key] = []; current = key; globalThis.__termsKey = key; globalThis.__termsCli = cli ? runner : undefined;
  try { await chat(ws, 'a', '안녕', null, { journal: { off: true } }); } finally { delete globalThis.__termsCli; current = '?'; }
  return seen[key];
}

/** 옛 낱말 — M11 한 줄(옛 낱말을 일부러 인용)과 기억 파일 경로(유지 — 계획 8절 질문 2)를 뺀 나머지에서 센다 */
const OLD = /크루|사장|선장|\b(crews?|captain|boss)\b/i;
const leftovers = (text, lang) => text.split(LEGACY_RECORD_TERMS_NOTE[lang]).join('').split(userAddressNote('유건', lang)).join('').replaceAll('사장-프로필.md', '').match(new RegExp(OLD.source, 'gi')) ?? [];

const CASES = [
  ['claude', 'SDK', 'messages'], ['openrouter', '네이티브', 'messages'], ['glm', '네이티브', 'messages'], ['kimi', '네이티브', 'messages'], ['grok', '네이티브', 'messages'],
  ['gemini', '네이티브(API 키)', 'gemini'], ['codex', 'CLI', 'cli'], ['gemini', 'CLI(구독)', 'cli'], ['antigravity', 'CLI', 'cli'],
];

for (const lang of ['ko', 'en']) {
  for (const [runner, path, via] of CASES) {
    test(`B1 ${lang} ${runner} ${path} — 지시문에 옛 기록 해석 한 줄(M11)이 있고, 그 밖에 옛 낱말이 없다`, { timeout: 120_000 }, async () => {
      const got = await turnWith(runner, lang, { cli: path.startsWith('CLI') });
      assert.ok(got?.length, `${runner}: 러너가 받은 지시문이 없다(경로를 못 탔다)`);
      assert.equal(got[0].via, via, `${runner}: 기대한 경로(${via})가 아니다`);
      const sys = got[0].text;
      assert.ok(sys.includes(LEGACY_RECORD_TERMS_NOTE[lang]), `${runner}: M11 한 줄이 없다`);
      assert.ok(sys.includes(userAddressNote('유건', lang)), `${runner}: 사용자 이름 한 줄(T5)이 없다`);
      assert.match(sys, lang === 'en' ? /The user's instructions/ : /사용자의 지시/, `${runner}: 새 낱말(지시 우선순위 줄)`);
      assert.deepEqual(leftovers(sys, lang), [], `${runner}: 옛 낱말이 남았다`);
    });
  }
}

// 호칭 8차(2026-10-08) — 호칭 규칙 판정은 정밀도가 먼저라 놓치는 모양이 있다. 확정 규칙에 그 모양(놓침)이나 오탐 후보가 있어도
// 러너마다 같은 이름 줄이 실리고, 그 끝에 "카드의 '일하는 방식'이나 회사 규칙(사용자 지침)에서 호칭을 정했으면 그 규칙을 따른다"가 붙는다(user-name.mjs userAddressNote 한 곳).
// 판정이 잡는 규칙이면 이름 줄 대신 그 규칙을 따르라는 줄만(우선 문구 없음).
const RULE_RUNNERS = [['claude', 'SDK', false, 'messages'], ['codex', 'CLI', true, 'cli'], ['openrouter', '네이티브', false, 'messages']];
const RULES = {
  ko: { missed: '- 사용자 호칭: 유건님 (2026-10-08 채택)', notRule: '- 사용자에게는 결론만 보고하고, 회의록은 "스탠드업 노트"라고 부른다 (2026-10-08 채택)', ruled: '- 나를 "유건님"이라고 불러 (2026-10-08 채택)' },
  en: { missed: '- Call me Yugeon (adopted 2026-10-08)', notRule: '- Call me ASAP when the build breaks (adopted 2026-10-08)', ruled: '- Call me "Yugeon" (adopted 2026-10-08)' },
};
const noteLine = (sys, lang) => sys.split('\n').find((l) => l.includes(USER_ADDRESS_NOTE.deferToRule[lang]) || l.includes(USER_ADDRESS_NOTE.ruled[lang]));
for (const lang of ['ko', 'en']) {
  for (const kind of ['missed', 'notRule', 'ruled']) {
    test(`호칭 8차 ${lang} ${kind} — 확정 규칙에 '${RULES[lang][kind]}'가 있을 때 SDK·CLI·네이티브가 같은 호칭 줄을 받는다`, { timeout: 120_000 }, async () => {
      const lines = [];
      for (const [runner, path, cli, via] of RULE_RUNNERS) {
        const got = await turnWith(runner, lang, { cli, rules: `# 사용자 규칙\n\n${RULES[lang][kind]}\n`, tag: `-addr-${kind.toLowerCase()}` });
        assert.equal(got?.[0]?.via, via, `${runner} ${path}: 경로`);
        const sys = got[0].text;
        assert.ok(sys.includes(RULES[lang][kind]), `${runner}: 확정 규칙 본문이 실린다`);
        if (kind === 'ruled') {
          assert.ok(sys.includes(USER_ADDRESS_NOTE.ruled[lang]), `${runner}: 정한 규칙을 따르라는 줄`);
          assert.ok(!sys.includes(USER_ADDRESS_NOTE.deferToRule[lang]), `${runner}: 우선 문구는 붙지 않는다`);
          assert.ok(!sys.includes('"유건"'), `${runner}: 표시 이름 지시 없음`);
        } else {
          assert.ok(sys.includes(userAddressNote('유건', lang)), `${runner}: 이름 줄 + 우선 문구`);
          assert.ok(sys.includes(`"유건". `) || sys.includes('"유건"이다.'), `${runner}: 이름은 그대로`);
          assert.ok(sys.includes(USER_ADDRESS_NOTE.deferToRule[lang]), `${runner}: 우선 문구`);
          assert.ok(!sys.includes(USER_ADDRESS_NOTE.ruled[lang]), `${runner}: 규칙 줄로 바뀌지 않는다`);
        }
        lines.push(noteLine(sys, lang));
      }
      assert.ok(lines[0], '호칭 줄을 찾지 못했다');
      assert.deepEqual(lines, lines.map(() => lines[0]), '러너마다 같은 호칭 줄');
    });
  }
}

test('B1 codex 네이티브(옵트인) — Responses 와이어 instructions에도 같은 한 줄', { timeout: 120_000 }, async () => {
  process.env.ARGO_NATIVE_RUNNERS = 'openrouter,glm,kimi,grok,gemini,codex';
  try {
    for (const lang of ['ko', 'en']) {
      const got = await turnWith('codex', lang);
      assert.equal(got?.[0]?.via, 'responses', 'codex 네이티브(Responses) 경로를 못 탔다');
      assert.ok(got[0].text.includes(LEGACY_RECORD_TERMS_NOTE[lang]), `${lang}: M11 한 줄이 없다`);
      assert.ok(got[0].text.includes(userAddressNote('유건', lang)), `${lang}: 사용자 이름 한 줄(T5)이 없다`);
      assert.deepEqual(leftovers(got[0].text, lang), [], `${lang}: 옛 낱말이 남았다`);
    }
  } finally { delete process.env.ARGO_NATIVE_RUNNERS; }
});

// 경우 표 D2 — 기억 파일 경로 notes/사장-프로필.md는 그대로(계획 8절 질문 2). 지시문은 그 경로를 가리키고, 새 머리말로 쓴 파일과
// 옛 머리말 그대로인 기존 파일을 같은 함수가 같은 항목으로 읽는다(머리말은 판정에 쓰지 않는다).
test('D2 기억 파일 경로 유지 — 지시문(ko/en)이 vault/notes/사장-프로필.md를 가리키고, 새·옛 머리말 파일을 같은 항목으로 읽는다', async () => {
  const { systemPromptFor } = await import('../src/chat.mjs');
  const { BOSS_PROFILE_REL, writeBossProfile, readBossProfile } = await import('../src/memory.mjs');
  assert.equal(BOSS_PROFILE_REL, 'notes/사장-프로필.md');
  for (const lang of ['ko', 'en']) assert.ok(systemPromptFor('# 카드', '/ws', '', { name: '에이', role: '검증' }, lang).includes('vault/notes/사장-프로필.md'), lang);
  const ws = 'terms-d2'; await createCompany(ws, '기억', 'owner', null, 'ko');
  const items = [{ section: '취향', text: '짧게 보고' }, { section: '금지', text: '주말 연락' }];
  const fresh = await writeBossProfile(ws, items);
  assert.match(fresh.md, /^# 사용자 프로필 — 회사가 아는 사용자\n/, '새 머리말');
  assert.deepEqual(fresh.items, items);
  const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
  const file = join(paths(ws).vault, BOSS_PROFILE_REL);
  await rf(file, 'utf8'); // 같은 경로에 썼다
  await wf(file, '# 사장 프로필 — 회사가 아는 사장\n\n(크루가 대화에서 알게 된 사장의 취향·확정 결정·금지사항을 기록한다. 사장이 크루 카드에서 직접 정정할 수 있다.)\n\n## 취향\n- 짧게 보고\n\n## 결정\n(아직 없음)\n\n## 금지\n- 주말 연락\n');
  assert.deepEqual((await readBossProfile(ws)).items, items, '옛 머리말 파일도 같은 항목');
});
