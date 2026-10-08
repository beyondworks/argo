// 웹뷰 CSP가 Tauri 내부 통신(ipc://localhost · http://ipc.localhost)을 막으면 Tauri는 postMessage로 물러나고,
// 그 통로에서는 invoke의 바이트 본문(Uint8Array)이 JSON으로 바뀐다 — save_download가 "raw body required"로 거절해
// 데스크톱 첨부 저장이 전부 "받지 못했습니다"가 됐다(2026-10-08 실사용 제보, 디버그 빌드로 단계별 재현·수정 확인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const csp = String(conf.app?.security?.csp ?? '');
const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src')) ?? '';

test('CSP connect-src가 Tauri 내부 통신 주소를 허용한다(바이트 invoke가 JSON으로 바뀌지 않게)', () => {
  const sources = connect.split(/\s+/);
  assert.ok(sources.includes('ipc:'), `connect-src에 ipc: 없음 — ${connect}`);
  assert.ok(sources.includes('http://ipc.localhost'), `connect-src에 http://ipc.localhost 없음 — ${connect}`);
});
