// 예비 실행 기기(VPS, argo run --standby)에서 도는 에이전트 턴 — 주 컴퓨터(맥)의 고정 작업 폴더·로컬 파일은 이 기기에 없다
// (.workroots.json은 기기 로컬이라 동기화하지 않는다). 지시문에 그 사실을 한 줄 넣어, 맥 파일이 필요한 일을 받으면 지금은 못 한다고
// 사실대로 말하게 한다(없는 경로를 '없다'고만 하거나 서버 홈에 저장하고 끝내지 않게). 일반·우선 기기의 지시문은 바뀌지 않는다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-standby-directive-'));
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const { commonDirectives } = await import('../src/chat.mjs');
afterEach(() => { delete process.env.ARGO_STANDBY_LEADER; delete process.env.ARGO_PREFER_LEADER; });

const KO = /예비 실행 서버/;
const EN = /standby server/;

test('예비 기기(ARGO_STANDBY_LEADER=1)의 턴 — 주 컴퓨터 파일을 열 수 없다는 한 줄(ko·en)', () => {
  process.env.ARGO_STANDBY_LEADER = '1';
  const ko = commonDirectives({ hasTools: true, lang: 'ko' });
  const en = commonDirectives({ hasTools: true, lang: 'en' });
  assert.match(ko, KO);
  assert.match(ko, /고정 작업 폴더/);
  assert.match(en, EN);
  assert.match(en, /pinned work folder/);
});

test('일반·우선 기기의 턴 — 그 줄이 없다(지시문 변화 0)', () => {
  for (const env of [{}, { ARGO_PREFER_LEADER: '1' }]) {
    Object.assign(process.env, env);
    assert.doesNotMatch(commonDirectives({ hasTools: true, lang: 'ko' }), KO);
    assert.doesNotMatch(commonDirectives({ hasTools: true, lang: 'en' }), EN);
    assert.doesNotMatch(commonDirectives({ hasTools: true, lang: 'ko', pinnedFolder: '/Users/me/work' }), KO);
    delete process.env.ARGO_PREFER_LEADER;
  }
});
