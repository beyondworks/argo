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

// D14: 방 밖 에이전트 멘션 — 후보는 방 안만(유건 0.1.29), 전송 뒤 안내용으로 방 밖 조직 에이전트를 찾는다
test('outsideCrewMentions: 방 밖 조직 에이전트만, 방 안 이름·동명 접두는 새지 않음, 멘션 없는 이름은 무시', async () => {
  const { outsideCrewMentions, canInstructCrew } = await import('../src/mention-candidates.mjs');
  const org = [{ id: 's', display_name: '서윤' }, { id: 'm', display_name: '민준' }, { id: 'p', display_name: '페퍼' }, { id: 'pv', display_name: '페퍼 (VPS)' }];
  const room = [{ kind: 'crew', id: 'm', name: '민준' }, { kind: 'user', id: 'u1', name: '비(동료)' }];
  assert.deepEqual(outsideCrewMentions('@서윤 여기서도 도와줄 수 있어?', room, org).map((c) => c.id), ['s'], '방 밖 서윤');
  assert.deepEqual(outsideCrewMentions('@민준 표 정리', room, org).map((c) => c.id), [], '방 안 민준은 안내 대상 아님');
  assert.deepEqual(outsideCrewMentions('서윤 얘기 좀 하자', room, org).map((c) => c.id), [], '@ 없이 이름만은 멘션이 아님');
  assert.deepEqual(outsideCrewMentions('@페퍼 (VPS) 상태?', [...room, { kind: 'crew', id: 'pv', name: '페퍼 (VPS)' }], org).map((c) => c.id), [], '방 안 "페퍼 (VPS)"의 접두 "페퍼"가 방 밖으로 새지 않는다');
  assert.deepEqual(outsideCrewMentions('@서윤 @페퍼 둘 다', room, org).map((c) => c.id).sort(), ['p', 's'], '여럿');
  // 같은 이름이 여럿이면 하나만, 진짜를 고른다 — 동기화 충돌 사본이 '페퍼' 크루로 미러돼 [이 방에 추가]가 사본을 넣었다(2026-10-04 실기기)
  const pick = (org) => outsideCrewMentions('@페퍼 봐 줘', room, org, 'me').map((c) => c.id);
  const p = (id, o) => ({ id, display_name: '페퍼', owner_user_id: 'me', status: 'active', slug: 'pepper', created_at: '2026-09-01', ...o });
  assert.deepEqual(pick([p('theirs', { owner_user_id: 'x', created_at: '2026-01-01' }), p('mine')]), ['mine'], '내 것이 먼저');
  assert.deepEqual(pick([p('new', { created_at: '2026-10-04' }), p('old')]), ['old'], '그다음은 먼저 만든 것');
  assert.equal(canInstructCrew({ owner_user_id: 'me', allow: 'owner' }, 'me'), true, '주인');
  assert.equal(canInstructCrew({ owner_user_id: 'x', allow: 'all' }, 'me'), true, '모두');
  assert.equal(canInstructCrew({ owner_user_id: 'x', allow: 'list', allow_users: ['me'] }, 'me'), true, '정한 사람');
  assert.equal(canInstructCrew({ owner_user_id: 'x', allow: 'owner' }, 'me'), false, '주인만');
});

// 재검수 #826 MEDIUM-2: 정렬만으로는 1:1 후보·@ 팝업·파견 전 목록·내 에이전트에 사본이 남았다 — 조회 단계에서 뺀다(withoutCopies).
test('withoutCopies·crewOrder: 충돌 사본은 목록에서 빠지고, 남은 목록은 회사 크루 먼저·이름순 — @페퍼는 진짜가 받는다', async () => {
  const { crewOrder, withoutCopies, mentionsFromBody } = await import('../src/mention-candidates.mjs');
  const c = (id, display_name, o = {}) => ({ id, display_name, slug: id, ...o });
  const list = [c('copy', '페퍼', { slug: 'pepper.conflict-mac-1759000000000' }), c('real', '페퍼', { slug: 'pepper' }), c('b', '가나'), c('co', '하늘', { company: true })];
  const sorted = withoutCopies(list).sort(crewOrder((x) => !!x.company)).map((x) => x.id);
  assert.deepEqual(sorted, ['co', 'b', 'real'], '사본은 빠지고 회사 크루 먼저·이름순');
  assert.equal(withoutCopies(null), null, '실패한 조회(null)는 그대로 — 호출부가 null을 판정한다');
  const cand = withoutCopies(list).sort(crewOrder((x) => !!x.company)).map((x) => ({ kind: 'crew', id: x.id, name: x.display_name }));
  assert.deepEqual(mentionsFromBody('@페퍼 봐 줘', cand), [{ kind: 'crew', id: 'real' }]);
});

// 검수 #826 LOW-3: Composer의 [이 방에 추가] 결과 판정이 CI 테스트 없이 App.jsx 안에만 있었다 — 순수 함수로 빼서 잠근다.
test('outsideAddDone·outsideRowView: 넣은 뒤엔 결과 줄만, 요청은 종전 줄 + "요청했어요", 버튼은 닫힐 때까지 같은 크기·자리', async () => {
  const { outsideAddDone, outsideRowView } = await import('../src/mention-candidates.mjs');
  assert.equal(outsideAddDone('joined'), 'joined');
  assert.equal(outsideAddDone('already'), 'already');
  assert.equal(outsideAddDone('requested'), 'requested');
  assert.equal(outsideAddDone(null), 'requested', '모르는 응답은 요청으로 본다(종전과 같다)');
  const mine = { owner_user_id: 'me' };
  const v = (done, o = {}) => outsideRowView({ crew: mine, uid: 'me', done, isDm: false, can: true, ...o });
  assert.deepEqual(v(undefined), { line: 'mention.outside', denied: false, suffix: null, request: 'on' });
  assert.deepEqual(v('pending'), { line: 'mention.outside', denied: false, suffix: null, request: 'busy' }, '응답 전에는 같은 글자로 꺼진 버튼(글자가 짧아지면 폰에서 줄바꿈이 바뀌었다)');
  assert.deepEqual(v('joined'), { line: 'mention.outside.joined', denied: false, suffix: null, request: 'slot' }, '결과 뒤에도 보이지 않는 같은 크기 자리 — 지우면 [1:1로 시키기]가 밀려와 더블탭 둘째 번이 1:1을 열었다(재검수 N2·NEW-1)');
  assert.deepEqual(v('already'), { line: 'mention.outside.already', denied: false, suffix: null, request: 'slot' });
  assert.deepEqual(v('requested'), { line: 'mention.outside', denied: false, suffix: 'mention.outside.requested', request: 'slot' });
  assert.equal(v(undefined, { isDm: true }).request, null, '1:1 방에는 [이 방에 추가]가 없다');
  assert.equal(v('joined', { crew: { owner_user_id: 'x' } }).request, null, '남의 에이전트는 주인만 데려온다 — 자리도 만들지 않는다');
  assert.equal(v(undefined, { can: false }).denied, true);
});
