// 앱 느낌 통일(유건 승인 초안 2026-09-29 — 뒤로 스와이프 스프링·큰 제목 접힘·햅틱). 초안: https://claude.ai/artifact/4yTtUHHr7ZENuBBYxNdbVR
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { springStep, headerCollapse, canStartSwipeBack } from '../src/use-phone.js';
import { longPressHandlers } from '../src/long-press.js';
import { rowSwipeRelease, replyOffset, REPLY_AT, ROW_LEAD_W, ROW_TRAIL_W } from '../src/row-swipe.js';

const run = (x, v, target, ms) => { const xs = []; for (let t = 0; t < ms; t += 16) { [x, v] = springStep(x, v, target, 0.016); xs.push(x); } return xs; };

test('스프링 — 넘침 없이 0.6초 안에 목표에 닿는다(되돌아올 때 화면 밖으로 튀지 않게)', () => {
  const back = run(150, 0, 0, 600);
  assert.ok(back.every((x) => x >= -0.5), `제자리로 돌아올 때 0 밑으로 넘지 않는다(min ${Math.min(...back).toFixed(2)})`);
  assert.ok(Math.abs(back.at(-1)) < 1, `0.6초면 거의 제자리(${back.at(-1).toFixed(2)})`);
  const out = run(150, 0, 390, 600);
  assert.ok(out.every((x) => x <= 390.5), '뒤로 넘어갈 때 화면 폭을 넘지 않는다');
});

test('스프링 — 손을 뗀 속도를 이어받는다(빠르게 튕기면 첫 프레임부터 더 멀리 간다)', () => {
  const still = run(100, 0, 390, 48), flick = run(100, 1500, 390, 48);
  assert.ok(flick[0] > still[0] + 10, `튕긴 쪽이 첫 프레임에서 더 나간다(${flick[0].toFixed(1)} > ${still[0].toFixed(1)})`);
  const reverse = run(200, -1500, 0, 48);
  assert.ok(reverse[0] < 200 - 20, '되돌리며 놓으면 그 방향 속도로 돌아온다');
});

test('큰 제목 접힘 — 8px까지는 큰 제목 그대로, 36px에서 작은 제목·반투명 재질이 다 드러난다', () => {
  assert.equal(headerCollapse(0), 0);
  assert.equal(headerCollapse(8), 0);
  assert.equal(headerCollapse(22), 0.5);
  assert.equal(headerCollapse(36), 1);
  assert.equal(headerCollapse(500), 1);
  assert.equal(headerCollapse(-40), 0, 'iOS 위쪽 고무줄(음수)은 큰 제목');
});

test('뒤로 스와이프는 왼쪽 끝 40px에서만 — 카카오톡·왓츠앱·라인·아이메시지 방식(유건 승인 2026-09-29)', () => {
  const el = { nodeType: 1, matches: () => false, parentElement: null };
  globalThis.getComputedStyle ??= () => ({ overflowX: 'visible' });
  assert.equal(canStartSwipeBack(el, 30, 390), true);
  assert.equal(canStartSwipeBack(el, 150, 390), false);
});

test('줄 밀기 판정 — 44px 넘게 밀면 칸이 열리고, 절반 넘게 밀면 바로 실행, 되돌리며 놓으면 닫힌다', () => {
  assert.deepEqual(rowSwipeRelease(30, 390, 0), { action: 'close', dir: 'lead', to: 0 }, '덜 밀면 닫힘');
  assert.deepEqual(rowSwipeRelease(60, 390, 0), { action: 'open', dir: 'lead', to: ROW_LEAD_W }, '오른쪽 = 즐겨찾기 칸');
  assert.deepEqual(rowSwipeRelease(-60, 390, 0), { action: 'open', dir: 'trail', to: -ROW_TRAIL_W }, '왼쪽 = 알림·읽음 칸');
  assert.equal(rowSwipeRelease(200, 390, 0).action, 'full', '절반(195px) 넘게 = 즐겨찾기 바로');
  assert.equal(rowSwipeRelease(-200, 390, 0).action, 'full', '절반 넘게 왼쪽 = 알림 끄기 바로');
  assert.equal(rowSwipeRelease(100, 390, -800).action, 'close', '되돌리며 놓으면 닫힘');
});

test('밀어서 답장 — 60px까지는 손가락 그대로, 넘으면 무거워져 90px 안에서 멈춘다. 오른쪽은 움직이지 않는다', () => {
  assert.equal(replyOffset(20), 0, '오른쪽(뒤로가기 방향)은 0');
  assert.equal(replyOffset(-40), -40);
  assert.equal(replyOffset(-60), -60);
  assert.ok(replyOffset(-200) >= -90 && replyOffset(-200) < -60, `끝까지 밀어도 90px 안(${replyOffset(-200)})`);
  assert.equal(REPLY_AT, 60);
});

test('길게 누르기가 울린 뒤에 메뉴·끌기가 열린다(햅틱은 이 한 곳 — 끌어 집기도 길게 누르기를 거친다)', async () => {
  const st = { timer: null, x: 0, y: 0 }; let fired = 0;
  const h = longPressHandlers(st, () => { fired += 1; }, 20);
  h.onPointerDown({ pointerType: 'touch', clientX: 10, clientY: 10 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, 1);
  const src = await readFile(new URL('../src/long-press.js', import.meta.url), 'utf8');
  assert.match(src, /haptic\('medium'\); onLongPress\(\);/, '진동이 메뉴보다 먼저(손끝에 먼저 닿게)');
});

test('햅틱은 모바일 앱에서만 — 네이티브 플러그인은 모바일 대상에만 넣고 권한도 모바일 파일에만', async () => {
  const cargo = await readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  const mobileDeps = cargo.split(`[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]`)[1]?.split('\n[')[0] ?? '';
  assert.match(mobileDeps, /tauri-plugin-haptics = "2"/);
  const cap = JSON.parse(await readFile(new URL('../src-tauri/capabilities/mobile.json', import.meta.url), 'utf8'));
  assert.ok(cap.permissions.includes('haptics:default'));
  const lib = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /#\[cfg\(mobile\)\]\n\s*let builder = builder\.plugin\(tauri_plugin_haptics::init\(\)\);/);
});
