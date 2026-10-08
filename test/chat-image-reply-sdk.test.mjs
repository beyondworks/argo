// 대화창 그림(정비사 10/5 전달) — 실제 SDK 턴(claude-agent-sdk)을 로컬 가짜 Messages 엔드포인트로 돌려(ARGO_CLAUDE_BASE_URL — 실자격·비용 0)
// ① 본체 채팅 턴 시스템 프롬프트에 "그림은 vault 경로 마크다운 이미지로" 규칙이 실려 나가는지 ② 답이 가리킨 **기존** 그림(이번 턴에 안 바뀜)이
// 반환 artifacts(채팅 칩)에 드는지를 행동으로 잠근다. 격리 서버 재현(origin/main): 같은 답에 artifacts: [], 프롬프트에 그림 규칙 없음.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-imgreply-'));
const home = await mkdtemp(join(tmpdir(), 'argo-imgreply-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const AVATAR = 'projects/20261002_페퍼-아바타/페퍼-아바타.png';
let replyText = 'done'; const systems = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}');
      if ((body.tools ?? []).length > 0) systems.push(typeof body.system === 'string' ? body.system : (body.system ?? []).map((x) => x?.text ?? '').join('\n')); // 크루 턴만(제목 생성 같은 도구 없는 요청 제외)
      return sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: replyText } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const ws = 'img-reply';
await createCompany(ws, '그림 답', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'pepper.md'), '---\nname: 페퍼\nrole: 운영\nrunner: claude\n---\n# 페퍼\n운영 크루.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
await mkdir(join(p.vault, 'projects', '20261002_페퍼-아바타'), { recursive: true });
await writeFile(join(p.vault, AVATAR), 'png'); // 턴 전부터 있던 그림(이번 턴에 안 바뀐다)
await writeFile(join(p.vault, 'notes', 'outside.png'), 'png');

test('SDK 본체 채팅 턴: 지시문에 그림 규칙이 실리고, 답이 가리킨 기존 그림이 칩(artifacts)에 든다 — 구역 밖·없는 파일은 안 든다', async () => {
  replyText = `페퍼 아바타입니다.\n\n![페퍼 아바타](${AVATAR})\n\n참고: ![노트](notes/outside.png) ![없음](projects/x/없는그림.png)`;
  const r = await chat(ws, 'pepper', '산출물에 저장된 페퍼 아바타 이미지를 채팅창에 첨부해줘. 파일로 말고 이미지로.', null, {});
  assert.equal(r.reply.trim(), replyText.trim());
  assert.deepEqual(r.artifacts, [AVATAR], '기존 그림이 칩에 — notes·없는 파일은 빠진다');
  assert.ok(systems.length >= 1, '크루 턴 요청이 있었다');
  const sys = systems.at(-1);
  assert.match(sys, /마크다운 이미지로 적어라 — 예: !\[시안\]\(projects\/20261002_x\/시안\.png\)/, '본체 채팅 턴 지시문에 그림 규칙');
  assert.match(sys, /그 줄 없이 "표시했다·첨부했다"고 말하지 마라/);
});

test('SDK: 그림을 가리키지 않는 답은 칩이 비어 있다(종전 동작 — 기존 파일을 아무 근거 없이 붙이지 않는다)', async () => {
  replyText = '표시했습니다.';
  const r = await chat(ws, 'pepper', '아바타 보여줘', null, {});
  assert.deepEqual(r.artifacts, []);
});

test('SDK: 이번 턴 사용자 첨부를 답이 되짚어도 칩(만든 문서)에 안 든다 — 같은 답의 다른 기존 그림은 든다(IMG 1차 검수 LOW, 배선: runChat → attributeArtifacts exclude)', async () => {
  const ATT = 'files/20261008_첨부/계약서.pdf';
  await mkdir(join(p.vault, 'files', '20261008_첨부'), { recursive: true });
  await writeFile(join(p.vault, ATT), 'pdf'); // 라우트가 턴 전에 저장해 둔 첨부(diff에는 안 잡힌다)
  replyText = `첨부하신 [계약서](${ATT})를 봤습니다. 시안은 ![페퍼](${AVATAR}) 입니다. 첨부 원본 경로: vault/${ATT}`;
  const r = await chat(ws, 'pepper', '이 계약서 보고 시안도 보여줘', null, { attachments: [{ rel: ATT, name: '계약서.pdf', mime: 'application/pdf', isImage: false }] });
  assert.deepEqual(r.artifacts, [AVATAR]);
});
