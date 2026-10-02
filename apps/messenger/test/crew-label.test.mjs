// 친구의 개인 에이전트 참여 요청 — 친구(결재자) 화면에 에이전트 이름 대신 crew id 앞 8자리('bd125cca')가 보이던 결함(2026-10-01 유건 제보).
// 재현(로컬 QA 스택, 친구 계정, 친구가 연 그룹 방): 구성원 패널 대기 행 이름 = "bd125cca". 원인 = ChannelSheet가 크루 목록에서 못 찾으면 r.crew_id.slice(0, 8).
// 친구는 그 크루 행을 못 읽는다(msgr_crews는 주인만, msgr_personal_room_crews는 이미 방에 든 크루만) — 이름을 모르면 "○○님의 에이전트".
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingCrewLabel } from '../src/crew-label.mjs';
import { t as translate } from '../src/i18n.js';
import { koJosa } from '../src/ko-josa.mjs';

const crewId = 'bd125cca-1e2f-4a5b-9c8d-001122334455';
const tKo = (k, v) => translate(k, 'ko', v);
const tEn = (k, v) => translate(k, 'en', v);

test('크루 목록에 있으면 그 이름', () => {
  assert.equal(pendingCrewLabel({ crewId, crews: [{ id: crewId, display_name: '효일' }], requesterName: '유건', t: tKo }), '효일');
});

test('크루 행을 못 읽으면 id 조각이 아니라 요청한 사람의 에이전트(ko/en)', () => {
  for (const [t, want] of [[tKo, '유건님의 에이전트'], [tEn, "Yugeon's agent"]]) {
    const got = pendingCrewLabel({ crewId, crews: [{ id: 'other', display_name: '서윤' }], requesterName: t === tKo ? '유건' : 'Yugeon', t });
    assert.equal(got, want);
    assert.ok(!got.includes(crewId.slice(0, 8)), got);
  }
});

test('요청한 사람 이름도 없으면 일상어 대체 문구 — 사전에 두 언어 모두 있다', () => {
  for (const t of [tKo, tEn]) {
    const got = pendingCrewLabel({ crewId, crews: null, requesterName: '', t });
    assert.notEqual(got, 'crew.req.unknown', '사전에 없는 키가 그대로 보이면 안 된다');
    assert.ok(!/[0-9a-f]{8}/.test(got), got);
  }
});

test('허락 안내 문장 — 대체 이름에도 조사가 맞는다', () => {
  const name = pendingCrewLabel({ crewId, crews: [], requesterName: '유건', t: tKo });
  assert.equal(koJosa(tKo('ch.crew.join.approved', { name })), '유건님의 에이전트가 채널에 들어왔습니다.');
});
