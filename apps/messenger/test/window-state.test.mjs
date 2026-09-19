// D53(2026-09-19 설치본 T8): 옮긴 창이 재실행 때 기본 자리(1100×760)로 돌아갔다 — 창 위치·크기를 기억한다.
// 행동은 설치 번들로 확인(별도 식별자 앱: 420,160/980×700 → ⌘Q → 재실행 같은 자리, 숨긴 채 ⌘Q → visible로 복원). 여기서는 배선만 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
test('데스크톱 빌더에 창 상태 플러그인 — 표시 여부(VISIBLE)는 저장·복원하지 않는다(닫기=가리기)', () => {
  const rs = read('../src-tauri/src/lib.rs');
  assert.match(rs, /#\[cfg\(desktop\)\]\s*let builder = builder\.plugin\(tauri_plugin_window_state::Builder::default\(\)\s*\.with_state_flags\(tauri_plugin_window_state::StateFlags::all\(\) & !tauri_plugin_window_state::StateFlags::VISIBLE & !tauri_plugin_window_state::StateFlags::FULLSCREEN\)\.build\(\)\);/);
  assert.ok(rs.indexOf('tauri_plugin_window_state') < rs.indexOf('.setup('), '빌더 단계에 달아야 설정 파일의 main 창에도 복원이 걸린다');
  const cargo = read('../src-tauri/Cargo.toml');
  const desktop = cargo.slice(cargo.indexOf(`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`));
  assert.match(desktop.split('\n[')[0], /tauri-plugin-window-state = "2"/, '데스크톱 전용 의존성');
});
