// '실행기 연결'(유건 지시 2026-10-02, 아르고 패밀리 구조): 세 앱은 서로 독립 — 어떤 기능도 다른 앱 설치를 전제하지 않는다.
// 엔진은 argo 하나(데스크톱 앱 = 같은 엔진 + GUI). 에이전트·실행기가 없으면 '실행기 연결' 시트로 안내한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerOptions, RUNNER_INSTALL } from '../src/runner-sheet.mjs';

test('시트 선택지 — 내 컴퓨터 · 서버 24시간 · 외부 에이전트(조직이 없으면 뺀다), iOS는 앱 받기 버튼 없음', () => {
  assert.deepEqual(runnerOptions({ hasOrg: true }).map((o) => o.key), ['computer', 'server', 'external']);
  assert.deepEqual(runnerOptions({ hasOrg: false }).map((o) => o.key), ['computer', 'server'], '조직이 없으면 외부 에이전트 줄은 없다');
  assert.equal(runnerOptions({ hasOrg: true }).find((o) => o.key === 'computer').download, true);
  assert.equal(runnerOptions({ hasOrg: true, ios: true }).find((o) => o.key === 'computer').download, false, 'iOS는 다운로드 링크를 두지 않는다(App Store 3.1.1, 총괄 9/26)');
  assert.equal(RUNNER_INSTALL, 'curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash', 'docs/selfhost.md 계정 모드 설치와 같은 명령');
  assert.match(readFileSync(new URL('../../../docs/selfhost.md', import.meta.url), 'utf8'), new RegExp(RUNNER_INSTALL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
});

const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const entries = [...dict.matchAll(/^ {2}'([\w.]+)': \[(.*)\],?\s*(?:\/\/.*)?$/gm)].map((m) => ({ key: m[1], body: m[2] }));

test('설치 전제 문구 없음 — "Argo 앱에서 로그인하면"·"Argo 앱을 켜면"·"아르고 앱과 같은 계정" 같은 표현을 쓰지 않는다', () => {
  const banned = [/Argo 앱(에서|에|으로)? ?로그인/, /Argo 앱을 켜/, /아르고 앱(과|에|에서)/, /아르고에 로그인/, /Argo 앱이 있다면/, /같은 계정으로 로그인한 Argo 앱/,
    /Sign in to (the )?Argo( app)?\b/, /Signing in to Argo/, /Open the Argo app/, /same account as the Argo app/i, /Same themes as the Argo app/i, /from the Argo app/];
  for (const e of entries) for (const re of banned) assert.doesNotMatch(e.body, re, `${e.key}: 설치 전제 표현`);
});

test("'Argo 앱'이 남는 문구는 정말 데스크톱 GUI에서만 되는 일이거나 앱 받기 안내뿐이다(새로 넣으려면 여기 근거와 함께 추가)", () => {
  const allowed = new Set([
    'cmd.empty', // 스킬 설치·별칭 등록 — argo CLI에 명령 없음(bin/argo.mjs: run·chat·login·status·browser·service, 대화 안 /crew·/new·/hire·/ai·/serve·/browser·/status)
    'routine.schedule.readonly', // 여러 시각 루틴 편집 — CLI에 루틴 편집 없음
    'agentcard.lock.argo', // 에이전트 이름 바꾸기 — CLI는 /hire 때 이름만 정한다
    'ch.step3.download', 'runner.computer.desc', // 앱 받기 안내(실행기가 함께 설치된다)
  ]);
  const left = entries.filter((e) => /Argo 앱|Argo app/.test(e.body)).map((e) => e.key);
  assert.deepEqual(left.filter((k) => !allowed.has(k)), []);
});

test("에이전트가 없거나 실행기가 꺼졌다는 안내는 '실행기'라는 말을 쓴다", () => {
  for (const k of ['crew.dm.away.mine', 'ch.crews.none.personal', 'phone.agents.none', 'ch.add.crew.none']) {
    const e = entries.find((x) => x.key === k); assert.ok(e, k);
    if (k === 'crew.dm.away.mine') assert.match(e.body, /실행기.*runner/);
    else assert.match(e.body, /에이전트가 없어요/);
  }
});
