// 풀 오토 모드(요구사항 1) — 크루가 셸로 company.json을 고쳐 스스로 풀 오토를 켜는 우회가
// 막혀 있는지 잠근다. company.json은 이미 기존 제어 파일 가드(permission-gate.mjs WS_CONTROL_FILES —
// capabilities.json과 같은 목록)에 있어 새 코드를 추가하지 않았다 — 이 테스트는 그 가드가
// fullAuto 필드가 사는 자리(company.json)에 실제로 걸려 있는지를 유건이 준 시나리오 그대로 확인한다.
// forbidden-zone.test.mjs가 company.json을 목록 차원에서 이미 재지만(CONTROL_FILES 배열 단언),
// 여기서는 "풀 오토를 켜려는 그 구체적 셸 명령"으로 직접 잰다(소스 문자열이 아니라 게이트 반환값).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fullauto-guard-'));
const { makePermissionGate, makeIsForbidden } = await import('../src/permission-gate.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');

const WS = 'my-co';
await createCompany(WS, '가드 테스트사', 'captain');
const wsRoot = paths(WS).root;
await mkdir(join(wsRoot, 'vault', 'notes'), { recursive: true });

test('Bash — 크루가 echo로 company.json에 fullAuto:true를 써넣는 시도는 막힌다', async () => {
  const gate = makePermissionGate(WS, 'crew-a', wsRoot);
  for (const cmd of [
    'echo \'{"fullAuto":true}\' > company.json',
    `echo '{"fullAuto":true}' > ${join(wsRoot, 'company.json')}`,
    'python3 -c "import json; json.dump({\'fullAuto\': True}, open(\'company.json\', \'w\'))"',
  ]) {
    assert.equal((await gate('Bash', { command: cmd })).behavior, 'deny', cmd);
  }
  assert.equal((await gate('Bash', { command: 'ls vault/notes' })).behavior, 'allow', '무관한 명령까지 막히면 과차단');
});

test('Write/Edit — company.json 직접 쓰기도 막힌다(같은 가드, 도구가 달라도 판정 일치)', async () => {
  const gate = makePermissionGate(WS, 'crew-a', wsRoot);
  const company = join(wsRoot, 'company.json');
  assert.equal((await gate('Write', { file_path: company, content: '{"fullAuto":true}' })).behavior, 'deny');
  assert.equal((await gate('Edit', { file_path: company, old_string: '{', new_string: '{"fullAuto":true,' })).behavior, 'deny');
});

test('isForbidden — company.json은 크루의 셸 능력·풀 오토 여부와 무관하게 항상 금지다', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(wsRoot, 'company.json')), true);
  // 실제로 fullAuto:true가 이미 저장돼 있어도(운영 승인 경로로 켠 뒤) 판정은 그대로다 — 값이 아니라
  // 파일 이름으로 막는다는 것을 보여준다(경합 조건·값 노출 없이 항상 결정적).
  await writeFile(join(wsRoot, 'company.json'), JSON.stringify({ id: WS, fullAuto: true }));
  assert.equal(await f(join(wsRoot, 'company.json')), true);
});
