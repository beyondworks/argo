import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionCandidates, mentionsFromBody } from '../src/mention-candidates.mjs';

const crews = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, display_name: `크루${i}`, role_text: '역할' }));
const members = [{ user_id: 'me', display_name: '나', role: 'owner' }, { user_id: 'u2', display_name: 'lean8kim', role: 'member' }];

test('상한 없음: 채널 참여 구성 전원이 뜬다(크루 13명 전부), 사람이 먼저; 나 자신은 빠진다 — 유건 제보 2026-09-11 밤(Walter가 목록에 없음)', () => {
  const list = mentionCandidates({ q: '', crews, members, uid: 'me' });
  assert.equal(list.length, 15, '@all 1 + 사람 1 + 크루 13 — 상한에 잘리지 않는다(맨 위 @all은 2026-09-12 추가)');
  assert.equal(list[0].kind, 'all', '맨 위는 @all');
  assert.deepEqual(list[1], { kind: 'user', id: 'u2', name: 'lean8kim', sub: 'member' }, '그 다음 사람');
  assert.ok(!list.some((x) => x.id === 'me'));
  assert.deepEqual(list.filter((x) => x.kind === 'crew').map((x) => x.id), crews.map((c) => c.id), '크루 순서 보존');
  assert.equal(mentionCandidates({ q: '', crews, members, uid: 'me', max: 3 }).length, 3, 'max를 주면 그때만 자른다');
});

test('검색어는 사람·크루 이름에 대소문자 없이 부분 일치한다', () => {
  assert.deepEqual(mentionCandidates({ q: 'LEAN', crews, members, uid: 'me' }).map((x) => x.id), ['u2']);
  assert.deepEqual(mentionCandidates({ q: '크루1', crews, members, uid: 'me' }).map((x) => x.id), ['c1', 'c10', 'c11', 'c12']);
});

test('본문 멘션: "@페퍼 (VPS)"는 페퍼 (VPS)만 — 앞부분이 같은 "페퍼"로 새지 않는다(실사고 2026-09-11); 둘 다 부르면 둘 다', () => {
  const cands = [{ kind: 'crew', id: 'p', name: '페퍼' }, { kind: 'crew', id: 'v', name: '페퍼 (VPS)' }, { kind: 'user', id: 'u', name: '민수' }];
  assert.deepEqual(mentionsFromBody('@페퍼 (VPS) 응답 테스트', cands), [{ kind: 'crew', id: 'v' }]);
  assert.deepEqual(mentionsFromBody('@페퍼 안녕', cands), [{ kind: 'crew', id: 'p' }]);
  assert.deepEqual(mentionsFromBody('@페퍼 (VPS) 그리고 @페퍼 @민수', cands).map((m) => m.id).sort(), ['p', 'u', 'v']);
  assert.deepEqual(mentionsFromBody('페퍼 (VPS) 응답', cands), [], '@ 없으면 멘션 아님');
  assert.deepEqual(mentionsFromBody('@페퍼 (VPS)', cands, [{ kind: 'crew', id: 'v', name: '페퍼 (VPS)' }]), [{ kind: 'crew', id: 'v' }], '팝업 선택도 본문에 남아 있어야 멘션');
  assert.deepEqual(mentionsFromBody('안녕', cands, [{ kind: 'crew', id: 'v', name: '페퍼 (VPS)' }]), [], '팝업에서 골랐어도 본문에서 지웠으면 멘션 아님');
});

test('본문 멘션 대소문자 무시: "@edna"도 Edna(끝말잇기 실사고 2026-09-11 밤)', () => {
  const cands = [{ kind: 'crew', id: 'e', name: 'Edna' }, { kind: 'crew', id: 'o', name: 'Ogilvy' }];
  assert.deepEqual(mentionsFromBody('@edna 디자인 @OGILVY', cands).map((m) => m.id).sort(), ['e', 'o']);
});

test('mentionsFromBody — 본문 등장 순서로 돌려준다(서버가 이 순서로 차례를 정한다, 실측 2026-09-12)', () => {
  const cands = [{ kind: 'crew', id: 'o', name: 'Ogilvy' }, { kind: 'crew', id: 'e', name: 'Edna' }];
  assert.deepEqual(mentionsFromBody('@Edna @Ogilvy 번갈아 세어봐', cands).map((x) => x.id), ['e', 'o']);
  assert.deepEqual(mentionsFromBody('@Ogilvy 먼저, 그 다음 @Edna', cands).map((x) => x.id), ['o', 'e']);
  assert.deepEqual(mentionsFromBody('@edna 1부터', cands), [{ kind: 'crew', id: 'e' }], '반환 모양은 그대로(at 없음)');
});

test('후보 목록 — 본문에 이미 있는 멘션은 빠지고, 맨 위에 @all(유건 2026-09-12)', () => {
  const crews = [{ id: 'o', display_name: 'Ogilvy', role_text: '카피' }, { id: 'e', display_name: 'Edna', role_text: '디자인' }];
  const members = [{ user_id: 'me', display_name: '나', role: 'owner' }, { user_id: 'u2', display_name: '민수', role: 'member' }];
  const all = mentionCandidates({ q: '', crews, members, uid: 'me' });
  assert.deepEqual(all.map((x) => `${x.kind}:${x.id}`), ['all:all', 'user:u2', 'crew:o', 'crew:e'], '@all이 맨 위, 나 제외');
  const ex = mentionCandidates({ q: '', crews, members, uid: 'me', exclude: new Set(['crew:o', 'user:u2']) });
  assert.deepEqual(ex.map((x) => x.id), ['all', 'e'], '고른 것은 목록에서 빠진다');
  assert.deepEqual(mentionCandidates({ q: 'ed', crews, members, uid: 'me' }).map((x) => x.id), ['e'], '검색어가 all과 안 맞으면 @all도 안 뜬다');
  assert.deepEqual(mentionCandidates({ q: 'al', crews, members, uid: 'me' }).map((x) => x.id), ['all'], '"al"까지 치면 @all만');
  assert.deepEqual(mentionCandidates({ q: '', crews, members, uid: 'me', exclude: new Set(['all:all']) }).map((x) => x.id), ['u2', 'o', 'e'], '@all을 이미 썼으면 안 뜬다');
  assert.deepEqual(mentionCandidates({ q: '', crews: [], members: [{ user_id: 'me' }], uid: 'me' }), [], '부를 사람이 없으면 @all도 없다');
});

test('mentionsFromBody — @all 은 후보 전원(사람 먼저·크루 순)으로 펼쳐진다', () => {
  const cands = [{ kind: 'user', id: 'u2', name: '민수' }, { kind: 'crew', id: 'o', name: 'Ogilvy' }, { kind: 'crew', id: 'e', name: 'Edna' }];
  assert.deepEqual(mentionsFromBody('@all 오늘 회의 정리해줘', cands), [{ kind: 'user', id: 'u2' }, { kind: 'crew', id: 'o' }, { kind: 'crew', id: 'e' }]);
  assert.deepEqual(mentionsFromBody('메일 x@all.com 확인', cands), [], '이메일 속 @all 은 아니다');
  assert.deepEqual(mentionsFromBody('@ALL', cands).length, 3, '대소문자 무시');
});
