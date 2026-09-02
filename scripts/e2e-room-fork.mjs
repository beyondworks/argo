// 회의실 '새 회의' 분기 E2E — 격리 서버(임시 ARGO_ROOT + 별도 포트)에서 새 회의 → 레일 진행 중 → 전환(현재 방 자동
// 보관) → 마치기(회의록) → 발언 중 게이트(409 ROOM_BUSY)를 실제 HTTP로 실측한다. 러너(LLM) 불요 — 크루·방은
// 파일로 시드한다(테스트 관례). 사용: node scripts/e2e-room-fork.mjs   (E2E_PORT 기본 3113, E2E_SKIP_BUILD=1로 빌드 생략)
//       KEEP_SERVER=1이면 성공 후 서버를 유지(브라우저 시각 확인용 — 루트·회사 id를 출력) — ctrl-c로 종료.
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PORT = Number(process.env.E2E_PORT || 3113);
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-roomfork-'));
const WS = 'e2e-roomfork';
let server = null;
const fail = (msg) => { console.error(`E2E FAIL: ${msg}`); cleanup(1); };
function cleanup(code) {
  if (process.env.KEEP_SERVER && code === 0) { console.log(`[e2e] KEEP_SERVER — http://127.0.0.1:${PORT}/c/${WS}/room 유지(루트 ${ROOT})`); return; }
  try { server?.kill('SIGTERM'); } catch { /* 종료됨 */ }
  rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
const env = { ...process.env, ARGO_ROOT: ROOT, PORT: String(PORT), NODE_ENV: 'production' };
for (const k of Object.keys(env)) if (/SUPABASE|ARGO_TENANT|ARGO_ENFORCE|ARGO_SYNC/i.test(k)) delete env[k];

// 시드 — 회사·크루 2명·현재 회의(사장 안건 + 크루 답)·마친 회의 보관본 1건. 서버 기동 전에 써 둔다.
{
  const ws = join(ROOT, WS);
  await mkdir(join(ws, 'chats', '.archive'), { recursive: true });
  await mkdir(join(ws, 'agents'), { recursive: true });
  await writeFile(join(ws, 'company.json'), JSON.stringify({ id: WS, name: 'E2E 회의실', lang: 'ko', createdAt: new Date().toISOString() }));
  await writeFile(join(ws, 'agents', 'pepper.md'), '---\nname: 페퍼\nrole: 검증\nrunner: claude\n---\n검증용.\n');
  await writeFile(join(ws, 'agents', 'nova.md'), '---\nname: 노바\nrole: 기획\nrunner: claude\n---\n기획용.\n');
  await writeFile(join(ws, 'chats', 'room-main.json'), JSON.stringify({ sid: 1, messages: [
    { who: 'user', text: '@페퍼 3분기 계획 초안 잡아줘', ts: Date.now() - 60_000 },
    { who: 'pepper', text: '초안입니다. 1) 매출 목표 2) 채널 3) 일정', ts: Date.now() - 50_000 },
  ] }));
  await writeFile(join(ws, 'chats', '.archive', '_room-1753500000000.json'), JSON.stringify({ title: '지난 주간 회의', messages: [
    { who: 'user', text: '@노바 지난주 회고', ts: 1753500000000 }, { who: 'nova', text: '잘 된 것 3가지…', ts: 1753500001000 },
  ] }));
}

// 선행 빌드 — 낡은 .next로 옛 코드가 도는 가짜 통과 방지. 반복 실행은 E2E_SKIP_BUILD=1.
if (!process.env.E2E_SKIP_BUILD) {
  console.log('[e2e] next build (E2E_SKIP_BUILD=1로 생략 가능)…');
  const b = spawnSync('npx', ['next', 'build'], { stdio: 'inherit' });
  if (b.status !== 0) fail('next build 실패 — 낡은 .next로는 E2E를 신뢰할 수 없다');
}
server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const api = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts,
    ...(opts.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) } : {}),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 비JSON */ }
  return { status: r.status, json: j, text };
};
{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); up = await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false); }
  if (!up) fail(`서버 기동 실패\n${serverLog.slice(-800)}`);
  // 포트 충돌 게이트(레시피 실사고) — 남의 서버가 응답하면 내 시드 회사가 없다
  const me = await api(`/api/companies/${WS}/room`);
  if (me.status !== 200 || me.json?.messages?.length !== 2) fail(`내 서버가 아니거나 시드 미반영(${me.status}): ${me.text.slice(0, 120)} — E2E_PORT를 옮겨 보라`);
  console.log(`[e2e] 서버 기동 :${PORT} · 시드 방 2건 확인`);
}
const R = `/api/companies/${WS}/room`;
const list = async () => (await api(`${R}/sessions`)).json?.sessions ?? [];

// ① 새 회의 — 현재 회의가 '진행 중'으로 레일에 적재되고 방은 빈다. 회의록(일지) 없음.
{
  const r = await api(`${R}/sessions`, { method: 'POST' });
  if (r.status !== 200 || r.json?.parked !== true) fail(`새 회의 실패(${r.status}): ${r.text.slice(0, 150)}`);
  const room = (await api(R)).json;
  if (room.messages.length !== 0) fail('새 회의 뒤 방이 비지 않았다');
  const l = await list();
  const open = l.filter((s) => s.open);
  if (l.length !== 2 || open.length !== 1 || open[0].topic !== '3분기 계획 초안 잡아줘') fail(`레일 기대 불일치: ${JSON.stringify(l)}`);
  if (l[0] !== open[0]) fail('진행 중 회의가 레일 최상단이 아니다');
  const journal = await readdir(join(ROOT, WS, 'vault', 'journal')).catch(() => []);
  if (journal.length) fail(`새 회의가 회의록을 남겼다: ${journal.join(', ')}`);
  console.log('[e2e] ① 새 회의 → 레일 진행 중 1건(최상단) · 방 비움 · 회의록 없음');
}
// ② 새 회의에서 안건을 올린 뒤(사장 발언은 서버가 크루 실행 전에 저장) 지난 회의로 전환 → 현재 회의가 진행 중으로 자동 보관
{
  await writeFile(join(ROOT, WS, 'chats', 'room-main.json'), JSON.stringify({ ...(await api(R)).json, messages: [{ who: 'user', text: '@노바 새 안건: 채용 계획', ts: Date.now() }] }));
  const before = await list();
  const target = before.find((s) => !s.open);
  const r = await api(`${R}/sessions`, { method: 'PATCH', body: { id: target.id, reopen: true } });
  if (r.status !== 200 || r.json?.parked !== true || r.json?.reopened !== true) fail(`전환 실패(${r.status}): ${r.text.slice(0, 150)}`);
  const room = (await api(R)).json;
  if (room.title !== '지난 주간 회의' || room.messages.length !== 2) fail(`전환 뒤 방 불일치: ${JSON.stringify(room).slice(0, 200)}`);
  const after = await list();
  if (after.length !== 2 || !after.every((s) => s.open)) fail(`전환 뒤 레일 기대 불일치(둘 다 진행 중이어야): ${JSON.stringify(after)}`);
  if (after.some((s) => s.id === target.id)) fail('전환한 회의가 레일에 중복으로 남았다');
  console.log('[e2e] ② 전환 → 지난 회의가 현재 방 · 종전 현재 회의는 진행 중으로 보관 · 중복 없음');
}
// ③ 진행 중 회의 열람(읽기 전용 GET) → 그 회의로 전환 → 마치기(회의록 1건)
{
  const l = await list();
  const pick = l.find((s) => s.topic.includes('채용 계획'));
  const view = await api(`${R}/sessions?id=${encodeURIComponent(pick.id)}`);
  if (view.status !== 200 || view.json?.open !== true || view.json?.messages?.length !== 1) fail(`진행 중 회의 열람 실패: ${view.text.slice(0, 150)}`);
  const sw = await api(`${R}/sessions`, { method: 'PATCH', body: { id: pick.id, reopen: true } });
  if (sw.status !== 200 || sw.json?.parked !== true) fail(`두 번째 전환 실패: ${sw.text.slice(0, 150)}`);
  const end = await api(R, { method: 'DELETE' });
  if (end.status !== 200 || end.json?.archived !== true || !end.json?.journal) fail(`마치기 실패: ${end.text.slice(0, 150)}`);
  const journal = await readdir(join(ROOT, WS, 'vault', 'journal'));
  if (journal.length !== 1) fail(`회의록 1건 기대, 실제 ${journal.length}`);
  const md = await readFile(join(ROOT, WS, 'vault', 'journal', journal[0]), 'utf8');
  if (!md.includes('채용 계획')) fail('회의록 내용이 마친 회의가 아니다');
  const l2 = await list();
  if (l2.filter((s) => s.open).length !== 2 || l2.filter((s) => !s.open).length !== 1) fail(`마치기 뒤 레일: ${JSON.stringify(l2)}`);
  console.log(`[e2e] ③ 진행 중 열람 → 전환 → 마치기 → 회의록 ${journal[0]} · 레일 진행 중 2 + 마침 1`);
}
// ④ 발언 중 게이트 — 신선한 턴 마커가 있으면 새 회의·전환·마치기 전부 409 + errorCode, 방·레일 불변. 낡은 마커는 통과.
{
  const marker = join(ROOT, WS, 'chats', 'room-main.status.json');
  await writeFile(join(ROOT, WS, 'chats', 'room-main.json'), JSON.stringify({ sid: 9, messages: [{ who: 'user', text: '@페퍼 게이트 확인', ts: Date.now() }] }));
  await writeFile(marker, JSON.stringify({ stage: 'room', detail: 'pepper', partial: '', startedAt: Date.now(), ts: Date.now() }));
  const turn = (await api(R)).json?.turn;
  if (!turn?.active) fail('GET /room turn.active가 아니다(마커 시드 실패)');
  const l = await list();
  const rs = [
    ['새 회의', await api(`${R}/sessions`, { method: 'POST' })],
    ['전환', await api(`${R}/sessions`, { method: 'PATCH', body: { id: l[0].id, reopen: true } })],
    ['마치기', await api(R, { method: 'DELETE' })],
  ];
  for (const [name, r] of rs) if (r.status !== 409 || r.json?.errorCode !== 'room_busy') fail(`${name} 게이트 실패(${r.status}): ${r.text.slice(0, 150)}`);
  if ((await api(R)).json.messages.length !== 1 || (await list()).length !== l.length) fail('게이트 거절이 방·레일을 바꿨다');
  await writeFile(marker, JSON.stringify({ stage: 'room', detail: 'pepper', partial: '', startedAt: Date.now() - 10 * 60_000, ts: Date.now() - 5 * 60_000 }));
  const ok = await api(`${R}/sessions`, { method: 'POST' });
  if (ok.status !== 200 || ok.json?.parked !== true) fail(`낡은 마커인데 게이트가 안 풀렸다(${ok.status})`);
  console.log('[e2e] ④ 발언 중 게이트: 새 회의·전환·마치기 409 room_busy · 방·레일 불변 · 낡은 마커 통과');
}
console.log('E2E OK: 새 회의 → 진행 중 레일 → 전환(자동 보관) → 마치기(회의록) → 발언 중 게이트');
cleanup(0);
