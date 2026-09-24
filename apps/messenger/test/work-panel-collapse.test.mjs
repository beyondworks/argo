// 업무 > 자동화 카드 접기(유건 결정 2026-09-24) — 처음엔 전부 접힘, 눌러서 개별 펼침(여럿 동시 가능), 상태는 기억하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toggleId } from '../src/collapse-set.mjs';

test('toggleId — 없으면 넣고 있으면 빼는 순수 토글, 입력을 바꾸지 않는다', () => {
  const a = new Set(['x']);
  const b = toggleId(a, 'y');
  assert.deepEqual([...b].sort(), ['x', 'y']);
  assert.deepEqual([...a], ['x'], '원본 불변');
  const c = toggleId(b, 'x');
  assert.deepEqual([...c], ['y']);
});

test('배선 — 카드는 기본 접힘(useState(() => new Set())), 윗줄은 실제 button(aria-expanded/aria-controls), 편집 폼은 카드 목록과 별개 위치', () => {
  const src = readFileSync(new URL('../src/work-panel.jsx', import.meta.url), 'utf8');
  assert.match(src, /const \[expanded, setExpanded\] = useState\(\(\) => new Set\(\)\);/, '기본값은 빈 집합 — 전부 접힘, 리마운트마다 초기화(패널 다시 열면 잊음)');
  assert.match(src, /const toggleCard = \(id\) => setExpanded\(\(cur\) => toggleId\(cur, id\)\);/);
  // 메신저 자동화 카드
  assert.match(src, /const open = expanded\.has\(automation\.id\); const bodyId = `work-body-msgr-\$\{automation\.id\}`;/);
  assert.match(src, /<button type="button" className="work-item-top work-item-toggle" aria-expanded=\{open\} aria-controls=\{bodyId\} onClick=\{\(\) => toggleCard\(automation\.id\)\}>/);
  assert.match(src, /<I name="caret" size=\{14\} className=\{`work-caret\$\{open \? ' open' : ''\}`\} \/><strong>\{automation\.title\}<\/strong>/);
  // Argo 루틴 카드
  assert.match(src, /const open = expanded\.has\(routine\.id\); const bodyId = `work-body-argo-\$\{routine\.id\}`;/);
  assert.match(src, /<button type="button" className="work-item-top work-item-toggle" aria-expanded=\{open\} aria-controls=\{bodyId\} onClick=\{\(\) => toggleCard\(routine\.id\)\}>/);
  // 편집 폼은 map() 밖, 카드 목록보다 앞에 — 접기와 무관하게 항상 같은 자리에 뜬다
  assert.match(src, /\{editing && <AutomationForm[^]*?onSaved=\{[^}]*\}\} \/>\}\n\s*\{editingRoutine && <RoutineForm/, '편집 폼은 카드 map 앞의 고정 위치');
  const editIdx = src.indexOf('{editing && <AutomationForm');
  const mapIdx = src.indexOf('(source.rows ?? []).map((automation)');
  assert.ok(editIdx > 0 && mapIdx > editIdx, '편집 폼 렌더가 카드 목록보다 앞');
  const css = readFileSync(new URL('../src/work-panel.css', import.meta.url), 'utf8');
  assert.match(css, /\.work-item-toggle \{ width: 100%; background: none; border: 0;/, '버튼 리셋(테두리 없는 원래 모습 유지)');
  assert.match(css, /\.work-caret\.open \{ transform: rotate\(180deg\); \}/, '펼치면 화살표 회전');
});
