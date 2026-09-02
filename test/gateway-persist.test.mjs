// 게이트웨이 영속(persist) 단위 — offset·슬랙 커서·하트비트의 저장/로드/손상 안전.
// 기존 gateway.test.mjs(슬랙 분류·큐 소유권·연결 필드·typing)와 중복 없음.
// 실행: npm test (node --test). 임시 ARGO_ROOT — 실데이터 미접촉.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 워크스페이스 루트를 임시 폴더로 — WS_ROOT는 모듈 로드 시 확정되므로 import보다 먼저 심는다.
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gwpersist-'));
const { loadOffset, saveOffset, loadSlackCursor, saveSlackCursor, beatGateway } = await import('../src/gateway/persist.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'persistco';
await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });

/* ── 폴러 offset — 재시작·리더 교체 시 마지막 배치 재수신을 막는 유일한 기록 ── */
test('offset: 저장 → 로드 왕복 (재시작 이어받기)', async () => {
  await saveOffset(WS, 'telegram', 987654321);
  assert.equal(await loadOffset(WS, 'telegram'), 987654321);
});

test('offset: 파일 없음 → 0부터 (최초 기동)', async () => {
  assert.equal(await loadOffset(WS, 'never-saved'), 0);
});

test('offset: 손상 파일 → 0부터 재개(lenient) — 크래시 잔재가 폴러를 죽이지 않는다', async () => {
  await writeFile(join(paths(WS).root, '.gw-offset-tg-luca.json'), '{"offset": 12'); // 부분 쓰기 재현
  assert.equal(await loadOffset(WS, 'tg-luca'), 0, '손상 시 0 — 재수신은 디스크 큐 멱등 재적재가 방어');
});

test('offset: 키별 분리 — 회사 게이트웨이와 크루 봇 offset이 서로 침범하지 않는다', async () => {
  await saveOffset(WS, 'telegram', 100);
  await saveOffset(WS, 'tg-pepper', 200);
  assert.equal(await loadOffset(WS, 'telegram'), 100);
  assert.equal(await loadOffset(WS, 'tg-pepper'), 200);
});

/* ── 슬랙 커서 — 서버측 수신 확정이 없어 이 파일이 유일한 재개 지점 ── */
test('슬랙 커서: 저장 → 로드 왕복, 없으면 null(최초 = "지금부터" 신호)', async () => {
  assert.equal(await loadSlackCursor(WS), null, '파일 없음 = null — startSlack이 지금 시각으로 초기화');
  await saveSlackCursor(WS, '1753600000.000123');
  assert.equal(await loadSlackCursor(WS), '1753600000.000123', 'ts 문자열 그대로 보존(정밀도 유실 없음)');
});

test('슬랙 커서: 손상 파일 → null — 과거 이력 전체 재실행 대신 지금부터로 복원', async () => {
  const WS2 = 'persistco2';
  await mkdir(join(process.env.ARGO_ROOT, WS2), { recursive: true });
  await writeFile(join(paths(WS2).root, 'gw-cursor-slack.json'), 'not-json!!');
  assert.equal(await loadSlackCursor(WS2), null);
});

/* ── 하트비트 — 연결 카드 "가동 중 · N초 전 응답"의 원천 ── */
test('하트비트: ts·ok·error 기록 + error 200자 절단(카드 표시용 파일이 비대해지지 않는다)', async () => {
  const before = Date.now();
  await beatGateway(WS, 'telegram', false, 'x'.repeat(500));
  const j = JSON.parse(await readFile(join(paths(WS).root, '.gateway-telegram.json'), 'utf8'));
  assert.equal(j.ok, false);
  assert.equal(j.error.length, 200, '오류 문자열은 200자에서 잘린다');
  assert.ok(j.ts >= before, 'ts는 기록 시각');
  await beatGateway(WS, 'telegram', true);
  const j2 = JSON.parse(await readFile(join(paths(WS).root, '.gateway-telegram.json'), 'utf8'));
  assert.equal(j2.ok, true);
  assert.equal(j2.error, '', '성공 비트는 오류를 비운다(마지막 상태가 곧 표시)');
});
