import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionCandidates, mentionsFromBody } from '../src/mention-candidates.mjs';

const crews = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, display_name: `크루${i}`, role_text: '역할' }));
const members = [{ user_id: 'me', display_name: '나', role: 'owner' }, { user_id: 'u2', display_name: 'lean8kim', role: 'member' }];

test('상한 없음: 채널 참여 구성 전원이 뜬다(크루 13명 전부), 사람이 먼저; 나 자신은 빠진다 — 유건 제보 2026-09-11 밤(Walter가 목록에 없음)', () => {
  const list = mentionCandidates({ q: '', crews, members, uid: 'me' });
  assert.equal(list.length, 14, '사람 1 + 크루 13 — 상한에 잘리지 않는다');
  assert.deepEqual(list[0], { kind: 'user', id: 'u2', name: 'lean8kim', sub: 'member' });
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
