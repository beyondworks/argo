// codex app-server 엔진 — 승인권 회수(P1)의 행동 계약.
// 소스 문자열 단언이 아니라 **세션을 실제로 태운다**: runAppServerSession은 스트림 이음매라
// PassThrough로 가짜 서버를 붙여 승인 왕복·한도 분류·타임아웃·fail-closed를 실행으로 잠근다.
// 판정자(makeApprovalJudge)는 실제 permission-gate에 임시 워크스페이스로 물린다(규칙 사본 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-codex-as-')); // import보다 먼저(레포 관례)
const { runAppServerSession, makeApprovalJudge, mapTurnError, codexEffortValue } = await import('../src/runners/codex-appserver.mjs');

/* ── 가짜 app-server — 클라이언트가 쓰는 스트림(input)을 읽고, 대본(script)대로 반응한다 ── */
function fakeServer({ onTurnStart }) {
  const input = new PassThrough();  // 클라 → 서버 (child.stdin 자리)
  const output = new PassThrough(); // 서버 → 클라 (child.stdout 자리)
  const received = [];
  const emit = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  input.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      received.push(m);
      if (m.method === 'initialize') emit({ id: m.id, result: { userAgent: 'fake' } });
      else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
      else if (m.method === 'turn/start') { emit({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress' } } }); onTurnStart(emit, received); }
      // 승인 응답(m.result.decision)은 대본이 received에서 관찰한다
    }
  });
  return { input, output, received, emit };
}
const decisionOf = (received) => received.find((m) => m.result?.decision)?.result?.decision ?? null;

test('승인 왕복 — 게이트 allow면 accept가 전송되고 턴이 완주한다', async () => {
  const srv = fakeServer({
    onTurnStart: (emit) => {
      emit({ id: 900, method: 'item/commandExecution/requestApproval', params: { itemId: 'c1', command: "/bin/zsh -lc 'echo hi'", cwd: '/w' } });
      // 승인 응답을 받은 뒤 완주하는 대본 — 실서버 순서와 동일(승인 → 실행 → 응답 → 완료)
      setTimeout(() => {
        emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: '했다' } } });
        emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
      }, 30);
    },
  });
  const { reply } = await runAppServerSession({
    input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000,
    judge: async (kind, payload) => { assert.equal(kind, 'exec'); assert.match(payload.command, /echo hi/); return 'accept'; },
  });
  assert.equal(reply, '했다');
  assert.equal(decisionOf(srv.received), 'accept');
});

test('승인 왕복 — 게이트 deny면 decline이 전송된다(집행권이 판정자에게 있다)', async () => {
  const srv = fakeServer({
    onTurnStart: (emit) => {
      emit({ id: 901, method: 'item/commandExecution/requestApproval', params: { itemId: 'c1', command: "cat .secrets.json" } });
      setTimeout(() => {
        emit({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: '거부됨을 보고' } } });
        emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      }, 30);
    },
  });
  const { reply } = await runAppServerSession({
    input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000,
    judge: async () => 'decline',
  });
  assert.equal(reply, '거부됨을 보고');
  assert.equal(decisionOf(srv.received), 'decline');
});

test('파일 패치 승인 — 경로는 선행 item/started에서 추적하고, 추적 실패는 decline(fail-closed)', async () => {
  const judged = [];
  const srv = fakeServer({
    onTurnStart: (emit) => {
      emit({ method: 'item/started', params: { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'vault/a.md', kind: 'add', diff: '' }] } } });
      emit({ id: 902, method: 'item/fileChange/requestApproval', params: { itemId: 'f1' } });
      emit({ id: 903, method: 'item/fileChange/requestApproval', params: { itemId: '없는아이템' } });
      setTimeout(() => emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } }), 30);
    },
  });
  await runAppServerSession({
    input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000,
    judge: async (kind, payload) => { judged.push(payload.paths); return payload.paths.length ? 'accept' : 'decline'; },
  });
  assert.deepEqual(judged, [['vault/a.md'], []], '추적된 경로가 판정자에게 전달되고, 미상은 빈 목록');
  const decisions = srv.received.filter((m) => m.result?.decision).map((m) => [m.id, m.result.decision]);
  assert.deepEqual(decisions, [[902, 'accept'], [903, 'decline']]);
});

test('한도 소진 — usageLimitExceeded가 limitReached 1급 분류로 던져진다(인증 오류와 구분)', async () => {
  const srv = fakeServer({
    onTurnStart: (emit) => {
      emit({ method: 'error', params: { error: { message: "You've hit your usage limit. Upgrade to Plus to continue using Codex (url), or try again at Sep 14th, 2026 12:27 PM.", codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } });
      emit({ method: 'turn/completed', params: { turn: { status: 'failed' } } });
    },
  });
  await assert.rejects(
    runAppServerSession({ input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000, judge: async () => 'decline' }),
    (e) => {
      assert.equal(e.limitReached, true);
      assert.match(e.message, /한도/, '정직한 한국어 안내');
      assert.match(e.message, /Sep 14th, 2026/, '재개 시각이 실린다');
      assert.doesNotMatch(e.message, /not logged in|401/i, 'AUTH_ERR_RE 자가치유를 오발동시키지 않는 문구');
      return true;
    },
  );
});

test('시간 초과 — turn/interrupt를 보내고 timedOut+killed로 던진다(상위 cliTurnFailure 계약)', async () => {
  const srv = fakeServer({ onTurnStart: () => { /* 영영 완주하지 않는 서버 */ } });
  await assert.rejects(
    runAppServerSession({ input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 300, judge: async () => 'accept' }),
    // killed:true — runners.mjs가 cliTurnFailure로 kind-aware 문구(잡=쪼개기/대화=SDK 위임)로 덮는 신호.
    // 이게 빠지면 잡 6시간 초과가 "이 턴이…"로 표기돼 분리 검수 H1·M4로 만든 안내가 러너별로 갈린다(MEDIUM-4).
    (e) => e.timedOut === true && e.killed === true,
  );
  assert.ok(srv.received.some((m) => m.method === 'turn/interrupt'), '중단 요청이 전송된다');
});

test('스트림 조기 종료 — stage:read로 던진다(상위가 "응답 없이 종료" 진단을 붙인다)', async () => {
  const srv = fakeServer({ onTurnStart: () => { setTimeout(() => srv.output.end(), 20); } });
  await assert.rejects(
    runAppServerSession({ input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000, judge: async () => 'accept' }),
    (e) => /스트림 종료/.test(e.message) && e.stage === 'read', // exec 경로의 read 단계 ENOENT와 동형(cliTurnFailure)
  );
});

/* ── 판정자 — 실제 permission-gate에 임시 워크스페이스로 물린다(사본 0) ── */
test('makeApprovalJudge: 셸은 Bash 판정 — 금고 리터럴은 decline, 평범한 명령은 accept', async () => {
  const ws = join(process.env.ARGO_ROOT, 'co-judge');
  await mkdir(ws, { recursive: true });
  const judge = makeApprovalJudge(ws);
  assert.equal(await judge('exec', { command: "/bin/zsh -lc 'echo hello'" }), 'accept');
  assert.equal(await judge('exec', { command: "/bin/zsh -lc 'cat .secrets.json'" }), 'decline', '회사 자격 파일 리터럴');
  assert.equal(await judge('exec', { command: "cat ~/.codex/auth.json" }), 'decline', '벤더 자격 하드라인');
  assert.equal(await judge('exec', { command: "echo x > chats/luca.json" }), 'decline', '대화 정본 위조 방향');
  assert.equal(await judge('exec', { command: '' }), 'decline', '명령 미상 = fail-closed');
});

test('makeApprovalJudge: 패치는 경로별 Write 판정 — 금고 경로 하나만 섞여도 decline', async () => {
  const ws = join(process.env.ARGO_ROOT, 'co-judge2');
  await mkdir(ws, { recursive: true });
  const judge = makeApprovalJudge(ws);
  assert.equal(await judge('patch', { paths: ['vault/note.md'] }), 'accept', '크루 책상은 허용');
  assert.equal(await judge('patch', { paths: ['agents/luca.md'] }), 'decline', '크루 카드는 금고');
  assert.equal(await judge('patch', { paths: ['vault/note.md', 'capabilities.json'] }), 'decline', '하나라도 금고면 전체 거부');
  assert.equal(await judge('patch', { paths: [] }), 'decline', '경로 미상 = fail-closed');
  assert.equal(await judge('없는종류', {}), 'decline', '미지의 승인 종류는 열지 않는다');
});

/* ── 순수 사상 ── */
test('codexEffortValue: CLI 인자와 같은 사상 — max→xhigh, 미지원은 null(모델 기본)', () => {
  assert.equal(codexEffortValue('high'), 'high');
  assert.equal(codexEffortValue('max'), 'xhigh');
  assert.equal(codexEffortValue(''), null);
  assert.equal(codexEffortValue('이상값'), null);
});

test('mapTurnError: 한도는 limitReached+재개 시각, 그 외는 원문 유지(자가치유 계약 보존)', () => {
  const lim = mapTurnError({ error: { message: 'usage limit... try again at Sep 14th, 2026 12:27 PM.', codexErrorInfo: 'usageLimitExceeded' } });
  assert.equal(lim.limitReached, true);
  assert.match(lim.message, /Sep 14th, 2026 12:27 PM에 재개/);
  const auth = mapTurnError({ error: { message: 'Missing bearer or basic authentication in header' } });
  assert.equal(auth.limitReached, undefined);
  assert.match(auth.message, /Missing bearer/, '인증 원문 보존 — chat AUTH_ERR_RE가 그대로 잡는다');
});
