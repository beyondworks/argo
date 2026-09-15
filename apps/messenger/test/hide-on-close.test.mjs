// 데스크톱 창 닫기 = 가리기(macOS) — 유건 요청 2026-09-15. Argo 본체(src-tauri/src/lib.rs)와 같은 관례를 메신저에도.
// 행동은 Tauri 런타임이라 여기서는 배선 핀: CloseRequested에서 앱 hide + prevent_close, macOS 한정, 다른 OS는 기본 동작.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rs = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
test('macOS 창 닫기 → 앱 가리기(prevent_close), 다른 OS는 기본 동작', () => {
  const start = rs.indexOf('.on_window_event(|window, event| {');
  assert.ok(start > 0, 'on_window_event 배선이 없다');
  const block = rs.slice(start, rs.indexOf('.setup(', start));
  assert.match(block, /#\[cfg\(target_os = "macos"\)\]\s*if let tauri::WindowEvent::CloseRequested \{ api, \.\. \} = event \{\s*let _ = tauri::Manager::app_handle\(window\)\.hide\(\);\s*api\.prevent_close\(\);\s*\}/, 'CloseRequested → hide + prevent_close(macOS cfg)');
  assert.match(block, /#\[cfg\(not\(target_os = "macos"\)\)\]/, '다른 OS는 기본 동작(트레이 없음)');
  assert.ok(start < rs.indexOf('.run(tauri::generate_context!())'), '빌더 체인 안(run 전)');
  const argo = readFileSync(new URL('../../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(argo, /\.hide\(\);\s*api\.prevent_close\(\);/, 'Argo 본체와 같은 관례(둘 중 하나가 바뀌면 같이 본다)');
});
