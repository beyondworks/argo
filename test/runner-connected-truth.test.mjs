// "연결됨인데 안 됨" 클래스 회귀 테스트(감사 2026-07-20) — ① 웹 브리지 완료 폴링이 자격 존재를
// 완료로 오판 ② 동기화된 새 자격이 격리 홈에 영영 미주입(write-if-absent) ③ gemini host 1회 스냅샷
// 동결 ④ detectRunners 60초 캐시가 host 옵트인 클릭 오거절.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT + 임시 HOME — 격리 홈(~/.argo/*-home-*)·호스트 파일(~/.gemini)이 실 홈을 오염하지 않게.
// homedir()는 POSIX에서 $HOME을 호출 시점에 읽으므로 import 전에 심으면 전 경로가 격리된다.
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-truthtest-'));
process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-truthhome-'));
const {
  startRunnerWebAuth, submitRunnerWebAuth, webAuthDone,
  saveRunnerCred, runnerCredEnv, detectRunners,
} = await import('../src/runners.mjs');

const WS = 'truthco';
await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });

function mockFetchOnce(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = real; };
}

test('webAuthDone: 자격 존재가 아니라 "이번 브리지 세션의 저장 완료"만 완료다', async () => {
  // 사전에 자격이 이미 존재하는 상태(재연결·방식 전환 시나리오)
  await saveRunnerCred(WS, 'codex', 'apikey', 'sk-old-key');
  startRunnerWebAuth('codex');
  assert.equal(webAuthDone('codex', WS), false, '기존 자격이 있어도 새 브리지 세션은 미완료 — 거짓 연결됨 차단');
  // 토큰 교환 성공 모사 → 저장 완료
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: 'a.b.c' }), { status: 200 }));
  try {
    const r = await submitRunnerWebAuth(WS, 'codex', 'somecode');
    assert.equal(r.ok, true, '교환 성공');
  } finally { restore(); }
  assert.equal(webAuthDone('codex', WS), true, '실제 저장 완료 후에만 완료');
  assert.equal(webAuthDone('codex', 'other-ws'), false, '다른 스코프의 완료로 오판하지 않는다');
  startRunnerWebAuth('codex');
  assert.equal(webAuthDone('codex', WS), false, '새 세션 시작은 완료 마커를 리셋(fail-closed)');
});

test('codex 격리 홈: 저장 자격 변경(동기화 모사)은 재시드, CLI 갱신은 보존', async () => {
  const v2 = JSON.stringify({ tokens: { access_token: 'v2' } });
  await saveRunnerCred(WS, 'codex', 'oauth', v2); // 홈 rm(기존 동작) 후
  const dir = join(process.env.HOME, '.argo', `codex-home-${WS}`);
  await runnerCredEnv(WS, 'codex');
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), v2, '저장 자격으로 시드');
  // CLI 토큰 갱신 모사 — 저장 자격이 그대로면 갱신분 보존(write-if-absent의 원래 목적 유지)
  const refreshed = JSON.stringify({ tokens: { access_token: 'v2-refreshed' } });
  await writeFile(join(dir, 'auth.json'), refreshed);
  await runnerCredEnv(WS, 'codex');
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), refreshed, 'CLI 갱신 토큰은 덮지 않는다');
  // 동기화 도착 모사 — 저장 자격은 v3인데 격리 홈은 옛 상태(마커=hash(v2)). saveRunnerCred의 rm 훅은
  // 저장한 기기에서만 도니, 수신 기기 상태를 "저장만 바뀜"으로 재구성한다.
  const v3 = JSON.stringify({ tokens: { access_token: 'v3-from-other-device' } });
  const s = await import('node:fs/promises');
  const marker = await s.readFile(join(dir, '.argo-seed-auth.json'), 'utf8');
  await saveRunnerCred(WS, 'codex', 'oauth', v3); // 저장 갱신(홈 rm됨)
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'auth.json'), refreshed); // 수신 기기의 옛 파일 복원
  await writeFile(join(dir, '.argo-seed-auth.json'), marker); // 옛 마커 복원 = 동기화 수신 직후 상태
  await runnerCredEnv(WS, 'codex');
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), v3, '동기화된 새 자격이 격리 홈에 재시드 — 죽은 토큰 영구화 차단');
});

test('gemini host: 호스트 재로그인·계정 교체를 따라간다(1회 스냅샷 동결 해동)', async () => {
  const hostG = join(process.env.HOME, '.gemini');
  await mkdir(hostG, { recursive: true });
  await writeFile(join(hostG, 'oauth_creds.json'), '{"acct":"A"}');
  await saveRunnerCred(WS, 'gemini', 'host', 'host');
  const gdir = join(process.env.HOME, '.argo', `gemini-home-${WS}`, '.gemini');
  await runnerCredEnv(WS, 'gemini');
  assert.equal(await readFile(join(gdir, 'oauth_creds.json'), 'utf8'), '{"acct":"A"}', '옵트인 시점 호스트 로그인 시드');
  // 호스트 계정 교체(재로그인) — 다음 턴에 즉시 따라가야 한다(구현 전엔 A 스냅샷 동결 = 전 턴 인증 실패)
  await writeFile(join(hostG, 'oauth_creds.json'), '{"acct":"B"}');
  await runnerCredEnv(WS, 'gemini');
  assert.equal(await readFile(join(gdir, 'oauth_creds.json'), 'utf8'), '{"acct":"B"}', '호스트 변경 추종 — codex 심링크와 의미 대칭');
  // 호스트 그대로 + CLI가 격리 사본에 갱신 토큰 기록 → 보존
  await writeFile(join(gdir, 'oauth_creds.json'), '{"acct":"B","refreshed":true}');
  await runnerCredEnv(WS, 'gemini');
  assert.equal(await readFile(join(gdir, 'oauth_creds.json'), 'utf8'), '{"acct":"B","refreshed":true}', '호스트 불변이면 CLI 갱신 보존');
});

test('detectRunners: force=true는 60초 캐시를 우회한다(host 옵트인 클릭 경로)', async () => {
  const a = await detectRunners();
  const b = await detectRunners();
  assert.equal(a, b, '기본 호출은 캐시 재사용(동일 참조)');
  const c = await detectRunners(true);
  assert.notEqual(c, a, 'force는 재감지(새 객체) — 방금 로그인한 CLI가 즉시 반영');
});
