// 결재 카드 쉬운 문장화 행동 테스트(유건 확정 2026-09-26).
// "무엇을 위해(목적)·무엇을 한다(할 일)·그러기 위해 무엇이 필요하다(필요한 것)" 세 항목을 크루가
// 채우면 카드가 쉬운 문장을 먼저 보이고, 하나도 안 채웠으면(폴백) 기존 action/reason 그대로다.
// 판정·권한 로직은 건드리지 않는다 — 여기서 확인하는 건 저장 모양과 표시 재료뿐이다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apv-plain-')); // import보다 먼저
const { addApproval, loadApprovals, approvalPlainText } = await import('../src/approvals.mjs');
const { makeCrewServer } = await import('../src/chat.mjs');
const { runDirectives } = await import('../src/cli-directives.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let n = 0;
const newWs = async () => { const id = `apv-plain-${++n}`; await createCompany(id, `plain-card-${n}`, 'captain'); return id; };

const clients = [];
after(async () => { for (const c of clients) await c.close().catch(() => {}); });

async function crewClient(wsId) {
  const server = makeCrewServer(wsId, 'pepper', '페퍼', []);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const cli = new Client({ name: 'plain-card-test', version: '1.0.0' });
  await server.instance.connect(serverSide);
  await cli.connect(clientSide);
  clients.push(cli);
  return cli;
}

// ── 1) addApproval — 저장 모양 ──────────────────────────────────────────
test('addApproval: 세 항목을 다 채우면 살균해서 plain으로 저장한다', async () => {
  const ws = await newWs();
  const it = await addApproval(ws, {
    slug: 'shuri', action: '뉴스레터 발송', reason: '이번 달 발행',
    plain: { purpose: '이번 달 뉴스레터 발송 완료', task: '구독자 1200명에게 메일 발송', need: 'Gmail 발송 권한' },
  });
  const saved = (await loadApprovals(ws)).find((a) => a.id === it.id);
  assert.deepEqual(saved.plain, { purpose: '이번 달 뉴스레터 발송 완료', task: '구독자 1200명에게 메일 발송', need: 'Gmail 발송 권한' });
  // 폴백 대상인 원래 필드는 그대로 남는다 — 표시 쪽이 "명령 보기"에 쓴다.
  assert.equal(saved.action, '뉴스레터 발송');
  assert.equal(saved.reason, '이번 달 발행');
});

test('addApproval: 세 항목이 비어 있으면(폴백) plain 자체가 없다', async () => {
  const ws = await newWs();
  const it = await addApproval(ws, { slug: 'shuri', action: '일반 결재', reason: '사유' });
  const saved = (await loadApprovals(ws)).find((a) => a.id === it.id);
  assert.ok(!('plain' in saved), 'plain을 안 보내면 저장물에 plain 키 자체가 없다');
});

test('addApproval: 빈 문자열·공백만 있는 plain도 폴백(생성하지 않는다)', async () => {
  const ws = await newWs();
  const it = await addApproval(ws, { slug: 'shuri', action: '일반 결재2', reason: '사유', plain: { purpose: '', task: '   ', need: '' } });
  const saved = (await loadApprovals(ws)).find((a) => a.id === it.id);
  assert.ok(!('plain' in saved), '공백뿐인 값은 폴백으로 취급한다');
});

test('addApproval: 세 항목 중 일부만 있으면 있는 것만 저장한다', async () => {
  const ws = await newWs();
  const it = await addApproval(ws, { slug: 'shuri', action: '부분 결재', reason: '사유', plain: { task: '자료 업로드' } });
  const saved = (await loadApprovals(ws)).find((a) => a.id === it.id);
  assert.deepEqual(saved.plain, { task: '자료 업로드' });
  assert.ok(!('purpose' in saved.plain) && !('need' in saved.plain), '없는 항목은 키 자체가 없다');
});

test('addApproval: plain 값의 개행·제어문자를 살균하고 200자로 자른다(카드 문구 조작 방어)', async () => {
  const ws = await newWs();
  const long = 'A'.repeat(250);
  const it = await addApproval(ws, { slug: 'shuri', action: 'x', reason: 'y', plain: { purpose: '줄1\n줄2\t\x01', task: long, need: 'ok' } });
  const saved = (await loadApprovals(ws)).find((a) => a.id === it.id);
  assert.equal(saved.plain.purpose, '줄1 줄2', '개행·탭·제어문자는 공백으로 치환되고 앞뒤 트림');
  assert.equal(saved.plain.task.length, 200, '200자로 잘린다');
});

test('addApproval: DEL(\\x7f)·줄/문단 구분자(U+2028/2029)·양방향 재정렬 제어문자(U+202A-202E·U+2066-2069)도 살균한다(분리 검수 LOW)', async () => {
  const ws = await newWs();
  // U+202E(RLO)로 문구 순서를 시각적으로 뒤집으려는 시도 — 살균되어야 카드 문구 조작 방어가 완결된다.
  const it = await addApproval(ws, { slug: 'shuri', action: 'x', reason: 'y',
    plain: { purpose: `앞\x7f뒤`, task: `줄1 줄2 끝`, need: `정상‮뒤집기⁩종료⁦` } });
  const saved = (await loadApprovals(ws)).find((a) => a.id === it.id);
  assert.equal(saved.plain.purpose, '앞 뒤');
  assert.equal(saved.plain.task, '줄1 줄2 끝');
  assert.equal(saved.plain.need, '정상 뒤집기 종료');
});

// ── 2) approvalPlainText — 텔레그램·슬랙 등 접힘 UI가 없는 창구용 문장 ──────
test('approvalPlainText: plain 없으면 null(호출부가 기존 action/reason으로 폴백)', () => {
  assert.equal(approvalPlainText({ action: 'a', reason: 'r' }, 'ko'), null);
});

test('approvalPlainText: 있는 항목만 줄로 만든다(ko/en) — 라벨은 UI 사전과 같은 "필요한 것"(분리 검수 LOW)', () => {
  const item = { plain: { purpose: '목적문장', need: '필요문장' } }; // task 없음
  assert.equal(approvalPlainText(item, 'ko'), '목적: 목적문장\n필요한 것: 필요문장');
  assert.equal(approvalPlainText(item, 'en'), 'Purpose: 목적문장\nNeeds: 필요문장');
});

// ── 3) request_approval 도구(SDK 표면) — 실제 MCP 왕복으로 확인 ────────────
test('request_approval 도구: purpose·task·need를 실으면 결재에 plain이 실린다', async () => {
  const ws = await newWs();
  const cli = await crewClient(ws);
  const r = await cli.callTool({ name: 'request_approval', arguments: {
    action: '외부 API 연동', reason: '고객 데이터 동기화', purpose: '주문 데이터 실시간 반영', task: '외부 API에 웹훅 등록', need: 'API 키',
  } });
  assert.ok(!r.isError, 'request_approval 호출 성공');
  const pending = (await loadApprovals(ws)).filter((a) => a.status === 'pending' && a.slug === 'pepper');
  const it = pending.find((a) => a.action === '외부 API 연동');
  assert.ok(it, '결재가 등록된다');
  assert.deepEqual(it.plain, { purpose: '주문 데이터 실시간 반영', task: '외부 API에 웹훅 등록', need: 'API 키' });
});

test('request_approval 도구: purpose·task·need를 안 실으면(기존 호출 패턴) plain 없이 폴백', async () => {
  const ws = await newWs();
  const cli = await crewClient(ws);
  const r = await cli.callTool({ name: 'request_approval', arguments: { action: '옛 방식 호출', reason: '테스트' } });
  assert.ok(!r.isError);
  const pending = (await loadApprovals(ws)).filter((a) => a.status === 'pending' && a.slug === 'pepper');
  const it = pending.find((a) => a.action === '옛 방식 호출');
  assert.ok(it, '결재가 등록된다(기존 계약 유지)');
  assert.ok(!('plain' in it), '필드를 안 채운 기존 호출은 회귀 없이 그대로 동작한다');
});

// ── 4) CLI 지시 블록(러너 중립성) — request_approval과 같은 원장에 같은 계약으로 ──
test('CLI 지시 블록 approval: purpose·task·need를 실으면 SDK와 같은 plain이 저장된다', async () => {
  const ws = await newWs();
  const notes = await runDirectives(ws, 'nobody', [
    { action: 'approval', request: 'CLI 크루의 결재', reason: '사유', purpose: 'CLI 목적', task: 'CLI 할 일', need: 'CLI 필요' },
  ]);
  assert.match(notes[0], /^✓ 결재 올림/);
  const list = await loadApprovals(ws);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].plain, { purpose: 'CLI 목적', task: 'CLI 할 일', need: 'CLI 필요' });
});

test('CLI 지시 블록 approval: 세 항목 없이 옛 형태로 보내면 폴백(회귀 없음)', async () => {
  const ws = await newWs();
  const notes = await runDirectives(ws, 'nobody', [
    { action: 'approval', request: 'CLI 옛 방식', reason: '사유' },
  ]);
  assert.match(notes[0], /^✓ 결재 올림/);
  const list = await loadApprovals(ws);
  assert.equal(list.length, 1);
  assert.ok(!('plain' in list[0]), '옛 형태 호출은 회귀 없이 그대로 폴백');
});
