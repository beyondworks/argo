// 커넥터 결재 게이트 — 외부로 나가는 쓰기는 사장 승인 뒤에만 실행된다(설계서 US-5).
//
// 판정 정본은 **서버가 주는 annotations**다. 구글 3종은 전 도구에 readOnlyHint를 준다(실측 2026-08-01:
// Calendar 9/9 · Gmail 13/13 · Drive 8/8). 이름 휴리스틱(create_로 시작하면 쓰기)은 서버가 말해 주는데도
// 우리가 짐작하는 것이라 새 도구가 생길 때마다 조용히 틀린다.
//
// 여기서 잠그는 계약:
//  ① 서버가 "읽기 전용"이라 한 도구만 결재를 면제한다. 모르면 결재를 건다(안전한 방향으로 틀린다).
//  ② 게이트는 **러너 무관 단일 지점**(callConnectorTool)에 있다 — 표면마다 걸면 반드시 갈린다.
//  ③ 승인 후에는 **서버가 실행**한다. 크루에게 "이제 해라"라고 돌려주면 같은 게이트를 다시 만나
//     결재가 무한히 쌓인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-connap-')); // import보다 먼저
const { connectorToolNeedsApproval } = await import('../src/connectors.mjs');
const { CONNECTOR_CATALOG } = await import('../src/market.mjs');

// 실측 형태 그대로 — 구글이 주는 annotations 모양이다.
const CAL_TOOLS = [
  { name: 'list_events', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'list_calendars', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'search_events', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'suggest_time', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'get_event', annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: 'create_event', annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'update_event', annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'delete_event', annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'respond_to_event', annotations: { readOnlyHint: false, destructiveHint: false } },
];

test('읽기는 통과, 쓰기는 결재 — 서버 표시가 1순위', () => {
  for (const t of ['list_events', 'list_calendars', 'search_events', 'suggest_time', 'get_event']) {
    assert.equal(connectorToolNeedsApproval(t, CAL_TOOLS, []), false, `${t}는 조회인데 결재를 건다 — 크루가 아무것도 못 하고 사장은 승인 버튼에 파묻힌다`);
  }
  for (const t of ['create_event', 'update_event', 'delete_event', 'respond_to_event']) {
    assert.equal(connectorToolNeedsApproval(t, CAL_TOOLS, []), true, `${t}는 외부 쓰기인데 그냥 나간다`);
  }
});

test('서버가 말을 안 하면 카탈로그 보완 목록으로, 그것도 없으면 결재를 건다', () => {
  const mute = [{ name: 'send_thing' }, { name: 'read_thing' }]; // annotations 없는 서버
  assert.equal(connectorToolNeedsApproval('send_thing', mute, ['send_thing']), true);
  assert.equal(connectorToolNeedsApproval('read_thing', mute, ['send_thing']), false, '보완 목록 밖이면 통과 — 목록을 준 서버는 그 목록을 믿는다');
  // 순수함수는 "근거 없음 = 통과"다. **결재로 기우는 판단은 호출부(needsApprovalNow)의 몫**이고,
  // 거기서 "조회 성공했는데 목록에 없음"과 "조회 자체 실패"를 갈라 처리한다(아래 행동 테스트가 잰다).
  // 첫 판의 이 자리 주석은 반대로 적혀 있었다 — 백스톱이 있다고 믿게 만드는 주석이었다(분리 검수).
  assert.equal(connectorToolNeedsApproval('unknown_tool', [], []), false, '순수 판정은 근거가 없으면 통과 — 기우는 것은 호출부');
});

test('서버 표시가 카탈로그보다 세다 — 둘이 어긋나도 쓰기는 막힌다', () => {
  // 카탈로그에 안 적힌 새 쓰기 도구가 생겨도 서버가 readOnlyHint:false를 주면 잡힌다.
  assert.equal(connectorToolNeedsApproval('create_event', CAL_TOOLS, []), true);
  // 반대로 카탈로그엔 있는데 서버가 읽기 전용이라 하면 통과 — 서버가 자기 도구를 안다.
  assert.equal(connectorToolNeedsApproval('list_events', CAL_TOOLS, ['list_events']), false);
});

test('등재한 캘린더의 보완 목록이 실측 쓰기 4개와 맞다', () => {
  // annotations를 못 받는 상황(목록 조회 실패 직후 캐시 공백 등)에서 이 목록이 유일한 근거가 된다.
  const cal = CONNECTOR_CATALOG.find((c) => c.id === 'google-calendar');
  const writes = CAL_TOOLS.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name).sort();
  assert.deepEqual([...cal.dangerous].sort(), writes, '보완 목록이 실측 쓰기 도구와 어긋난다');
});

test('러너 중립성 — 게이트가 단일 지점에 있고, 두 표면이 크루를 넘긴다', () => {
  // 표면(SDK use_connector · CLI 지시 블록)마다 게이트를 걸면 반드시 한쪽이 빠진다. 그래서 둘이
  // 수렴하는 callConnectorTool 안에 건다 — 여기 있는 한 어느 러너로도 우회가 없다.
  const core = readFileSync(new URL('../src/connectors.mjs', import.meta.url), 'utf8');
  assert.match(core, /!approved && await needsApprovalNow\(/, '게이트가 단일 실행 경로에서 사라졌다');
  // 승인 후 실행은 approved 플래그로 한 번만 통과한다 — 이 우회구가 없으면 승인해도 다시 결재가 뜬다.
  const act = readFileSync(new URL('../src/approval-actions.mjs', import.meta.url), 'utf8');
  assert.match(act, /callConnectorTool\([^)]*approved: true/s, '승인 실행이 게이트를 통과하지 못한다 — 무한 결재');
  assert.match(act, /item\.kind === 'connector'/, '승인 시 서버가 실행하는 분기가 없다');

  // 두 표면 모두 slug를 넘겨야 승인 후 보고가 **요청한 그 크루**의 대화로 돌아간다(followUp이 item.slug로
  // 스레드를 찾는다). 한쪽만 넘기면 그 러너 사용자만 결과를 못 받는다.
  const sdk = readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const cli = readFileSync(new URL('../src/cli-directives.mjs', import.meta.url), 'utf8');
  for (const [name, src] of [['SDK(chat.mjs)', sdk], ['CLI(cli-directives.mjs)', cli]]) {
    const calls = [...src.matchAll(/callConnectorTool\([^;]*?\)/gs)].map((m) => m[0]);
    assert.ok(calls.length >= 1, `${name}에 커넥터 호출이 없다`);
    for (const c of calls) {
      assert.match(c, /slug:/, `${name}가 크루를 안 넘긴다 — 승인 후 보고가 엉뚱한 곳으로 간다: ${c.slice(0, 90)}`);
      assert.doesNotMatch(c, /slug:\s*(''|"")/, `${name}가 크루를 빈 값으로 넘긴다`);
    }
  }
});
