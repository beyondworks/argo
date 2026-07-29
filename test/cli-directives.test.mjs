// CLI 러너 능력 패리티 — 지시 블록 파싱·실행.
//
// 배경(유건 지시 2026-07-28): "어떤 러너를 쓰던 같은 환경이여야지." SDK 러너만 도구를 호출할 수
// 있어서 CLI 크루는 "루틴 화면에서 걸어 달라"고 안내만 했고, 실사용에서 "루틴이 실행 안 된다 /
// 크루가 예약했다고 말만 한다"로 돌아왔다. 이 테스트는 **말이 실제 실행으로 바뀌는지**를 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-cli-dir-'));
process.env.ARGO_ROOT = ROOT; // paths()가 읽기 전에 세팅되어야 한다 — import보다 먼저

const { parseDirectives, parseEvery, toSchedule, runDirectives } = await import('../src/cli-directives.mjs');
const { createCompany } = await import('../src/workspace.mjs');
let n = 0;
const newWs = async () => { const id = `co-t${++n}`; await createCompany(id, `cli-parity-${n}`, 'captain'); return id; };

test('지시 블록을 걷어내고 본문만 남긴다', () => {
  const { clean, directives, bad } = parseDirectives(
    '확인했습니다.\n\n```argo\n{"action":"schedule","every":"30m","prompt":"지표 점검"}\n```\n\n이상입니다.',
  );
  assert.equal(directives.length, 1);
  assert.equal(directives[0].action, 'schedule');
  assert.deepEqual(bad, []);
  assert.equal(clean.includes('argo'), false, '블록은 화면에서 지워진다');
  assert.match(clean, /확인했습니다[\s\S]*이상입니다/);
});

test('깨진 블록은 조용히 삼키지 않는다 — 그게 곧 거짓말이 된다', () => {
  const { directives, bad } = parseDirectives('네\n```argo\n{not json}\n```');
  assert.deepEqual(directives, []);
  assert.equal(bad.length, 1);
});

test('블록이 없으면 원문 그대로', () => {
  const { clean, directives } = parseDirectives('그냥 답변입니다.');
  assert.deepEqual(directives, []);
  assert.equal(clean, '그냥 답변입니다.');
});

test('every는 분·시간·영문 단위를 모두 읽는다', () => {
  assert.equal(parseEvery('30m'), 30);
  assert.equal(parseEvery('30분'), 30);
  assert.equal(parseEvery('2h'), 120);
  assert.equal(parseEvery('2시간'), 120);
  assert.equal(parseEvery(45), 45);
  assert.equal(parseEvery('내일'), null);
});

test('time/days는 daily·weekly로 갈린다', () => {
  assert.deepEqual(toSchedule({ time: '09:00' }), { type: 'daily', times: ['09:00'] });
  assert.deepEqual(toSchedule({ time: '09:00', days: [1, 3] }), { type: 'weekly', times: ['09:00'], dows: [1, 3] });
  assert.deepEqual(toSchedule({ every: '30분' }), { type: 'interval', everyMinutes: 30 });
  assert.throws(() => toSchedule({}), /every 또는 time/);
});

test('schedule 지시가 실제 루틴 파일을 만든다 — 말이 아니라 실행', async () => {
  const ws = await newWs();
  const notes = await runDirectives(ws, 'nobody', [
    { action: 'schedule', every: '30m', title: '지표 점검', prompt: '배포 상태 요약' },
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^✓ 루틴 등록됨/);
  const { loadRoutines } = await import('../src/routines.mjs');
  const rs = await loadRoutines(ws);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].schedule.everyMinutes, 30);
  assert.equal(rs[0].prompt, '배포 상태 요약');
});

test('실패한 지시는 실패로 보고된다 — 성공한 척하지 않는다', async () => {
  const ws = await newWs();
  const notes = await runDirectives(ws, 'nobody', [
    { action: 'schedule', every: '1m', prompt: '너무 잦음' },   // 하한 10분 위반
    { action: 'mail', to: '없는크루', message: '안녕' },
    { action: 'teleport', x: 1 },
  ], { bad: ['JSON 오류'] });
  assert.equal(notes.length, 4);
  assert.match(notes[0], /^⚠ 지시 블록을 읽지 못했습니다/);
  assert.match(notes[1], /^⚠ 지시 실행 실패 \(schedule\)/);
  assert.match(notes[2], /^⚠ 지시 실행 실패 \(mail\)/);
  assert.match(notes[3], /^⚠ 알 수 없는 지시/);
  const { loadRoutines } = await import('../src/routines.mjs');
  assert.deepEqual(await loadRoutines(ws), []);
});

test('mail 지시가 수신 크루 우편함에 실제로 적재된다', async () => {
  const ws = await newWs();
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { paths } = await import('../src/workspace.mjs');
  const p = paths(ws);
  await mkdir(p.agents, { recursive: true });
  await writeFile(join(p.agents, 'nova.md'), '---\nname: 노바\nslug: nova\nrole: 개발\n---\n\n본문\n');

  const notes = await runDirectives(ws, 'nobody', [{ action: 'mail', to: '노바', message: '이거 봐줘' }]);
  assert.match(notes[0], /^✓ 노바에게 쪽지 보냄/);
  const files = await readdir(join(p.root, 'mail', 'nova'));
  assert.equal(files.length, 1);
  const msg = JSON.parse(await readFile(join(p.root, 'mail', 'nova', files[0]), 'utf8'));
  assert.equal(msg.message, '이거 봐줘');
  assert.equal(msg.kind, 'to');
});
