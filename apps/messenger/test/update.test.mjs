// 데스크톱 업데이터 배선 — 실제 판정 로직은 update-schedule.test.mjs가 잠근다. 여기는 update.jsx가 그 판정을 실제로
// 쓰는지(포커스·주기·중복확인 금지·조용한 실패)와 "나중에" 억제가 실행 중 상태로만 유지되는지를 소스 대조로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/update.jsx', import.meta.url), 'utf8');

test('확인은 시작·포커스·visibilitychange·주기 네 갈래 모두 shouldCheckDesktop 판정을 거친다(중복 확인 금지 로직 우회 없음)', () => {
  assert.match(src, /check\('start'\)/);
  assert.match(src, /window\.addEventListener\('focus', onFocus\)/);
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisibility\)/);
  assert.match(src, /setInterval\(\(\) => check\('interval'\)/);
  assert.match(src, /shouldCheckDesktop\(\{ phase: r\.phase, now: Date\.now\(\), lastCheckAt: r\.lastCheckAt, reason \}\)/);
  assert.match(src, /if \(r\.busy \|\| !shouldCheckDesktop/, '진행 중(busy)이면 겹쳐 확인하지 않는다');
});

test('확인 실패는 막대(setSt)가 아니라 진단(diag)에만 남긴다 — 침묵은 아니되 매번 오류 막대로 방해하지 않는다', () => {
  assert.match(src, /pushDiag\('update-check', String\(e\?\.message \?\? e\)\)/);
  const catchBlock = src.slice(src.indexOf('} catch (e) {\n        r.lastCheckAt'), src.indexOf('} finally { r.busy = false; }'));
  assert.ok(!catchBlock.includes('setSt('), '확인 실패 catch에서 setSt를 부르면 매번 오류 막대가 뜬다');
});

test('"나중에"는 같은 버전만 억제하고, 설치·완료 상태는 ref.phase에도 반영해 다음 확인이 중복되지 않게 한다', () => {
  assert.match(src, /if \(st\.phase === 'available' && st\.version\) ref\.current\.dismissedVersion = st\.version;/);
  assert.match(src, /ref\.current\.phase = 'installing';/);
  assert.match(src, /ref\.current\.phase = 'ready';/);
  assert.match(src, /ref\.current\.phase = 'error';/);
  assert.match(src, /shouldShowVersion\(upd\.version, r\.dismissedVersion\)/);
});

test('안 쓰는 Update 리소스는 close()로 정리한다(30분마다 확인하는데 방치하면 쌓인다)', () => {
  assert.match(src, /old\.close\?\.\(\)\.catch/, '새 Update로 교체될 때 이전 것을 닫는다');
  assert.match(src, /upd\?\.close\?\.\(\)\.catch\(\(\) => \{\}\); \/\/ 이미 알고 있는 버전 그대로/, '같은 버전이면 새로 받은 Update를 바로 닫는다');
  assert.match(src, /ref\.current\.upd\?\.close\?\.\(\)\.catch\(\(\) => \{\}\); \/\/ 더 안 쓸 Update 자원 정리/, '"나중에"를 눌러도 정리한다');
});
