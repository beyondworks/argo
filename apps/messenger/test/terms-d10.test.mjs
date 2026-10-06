// 기능 점검 D10(2026-10-02): 화면 용어가 어긋났다 — 복사 안내는 '초대 링크·코드로 참여'인데 메뉴는 '초대 코드로 참여',
// 숨김 메뉴는 '크루', 확인 창은 '에이전트', 안내는 v2에 없는 '숨긴 크루 목록'. v2 용어는 '에이전트'로 통일한다.
// 2026-10-06 용어 변경 T3(rc-0195 terminology-plan.md 2-4절): 사장·선장·captain·boss까지 넓히고 조사·관사 오류도 본다.
//   크루→에이전트, 사장→사용자(받침이 없어 조사가 바뀐다), Crew→Agent, Captain→User. 'Owner'는 '사장' 뜻일 때만 바꾸는데
//   메신저의 Owner는 모두 조직 소유자·에이전트 주인 뜻이라 그대로 둔다(계획 8절 질문 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { DICT } = await import(process.env.I18N_PATH ?? '../src/i18n.js');

const strip = (s) => s.replace(/\{\w+\}/g, ''); // 자리표시({crew} 등)는 코드 이름이라 검사에서 뺀다
export const KO_BAD = { '옛 낱말': /크루|사장|선장/, '조사(사용자+은/을/과/으로)': /사용자(은|을|과|으로)(?![가-힣])/, '조사(사용자이)': /사용자이(?=[\s,.)])/, '겹침': /에이전트\((에이전트|크루)\)/ };
export const EN_BAD = { '옛 낱말': /\b(crews?|captain|boss)\b/i, '관사(a agent)': /\ba agent/i, '관사(an user)': /\ban user\b/i };
export function badTerms(dict) {
  const out = [];
  for (const [k, [ko, en]] of Object.entries(dict)) {
    for (const [why, re] of Object.entries(KO_BAD)) if (re.test(strip(ko))) out.push(`${k} ko ${why}`);
    for (const [why, re] of Object.entries(EN_BAD)) if (re.test(strip(en))) out.push(`${k} en ${why}`);
  }
  return out;
}

test("화면 문구에 옛 낱말('크루'·'사장'·'선장', crew·captain·boss)과 조사·관사 오류가 없다 — 용어는 에이전트·사용자", () => {
  assert.deepEqual(badTerms(DICT), []);
});

test('검사기가 실제로 잡는다(변이) — 사전 값 하나를 옛 낱말로 되돌리면 빨강', () => {
  const bump = (k, i, v) => ({ ...DICT, [k]: i === 0 ? [v, DICT[k][1]] : [DICT[k][0], v] });
  assert.deepEqual(badTerms(bump('ch.add.crew', 0, '크루 추가')), ['ch.add.crew ko 옛 낱말']);
  assert.deepEqual(badTerms(bump('ch.add.crew', 0, '사장 추가')), ['ch.add.crew ko 옛 낱말']);
  assert.deepEqual(badTerms(bump('ch.add.crew', 1, 'Add Crew')), ['ch.add.crew en 옛 낱말']);
  assert.deepEqual(badTerms(bump('ch.add.crew', 1, 'Ask the captain')), ['ch.add.crew en 옛 낱말']);
  assert.deepEqual(badTerms(bump('ch.add.crew', 1, 'Add a agent')), ['ch.add.crew en 관사(a agent)']);
  assert.deepEqual(badTerms(bump('ch.add.crew', 0, '사용자을 추가')), ['ch.add.crew ko 조사(사용자+은/을/과/으로)']);
  assert.deepEqual(badTerms(bump('ch.add.crew', 0, '에이전트(크루) 추가')), ['ch.add.crew ko 옛 낱말', 'ch.add.crew ko 겹침']);
  assert.deepEqual(badTerms({ x: ['{crew}을(를) 넣기', 'Add {crew}'] }), [], '자리표시는 코드 이름이라 통과');
});

// C4(용어 경우 표): '+ 초대하기 → 에이전트 추가' — 메뉴 이름과 연동 안내(T4가 integrations README를 이 이름으로 맞춤)가 같아야 한다.
test("초대 메뉴 이름은 '초대하기 → 에이전트 추가'이고 연동 README 안내와 같다", (t) => {
  assert.deepEqual(DICT['ch.add'], ['초대하기', 'Invite']);
  assert.deepEqual(DICT['ch.add.crew'], ['에이전트 추가', 'Add agent']);
  const menu = `"+ ${DICT['ch.add'][0]} → ${DICT['ch.add.crew'][0]}"`, direct = `"+ ${DICT['ch.add.crew'][0]}"`;
  const readmes = ['hermes-argo-msgr', 'openclaw-argo-msgr'].map((d) => fileURLToPath(new URL(`../../../integrations/${d}/README.md`, import.meta.url)));
  if (!readmes.every(existsSync)) { t.skip('integrations/ 가 없는 체크아웃(메신저만 받은 경우)'); return; }
  for (const f of readmes) {
    const md = readFileSync(f, 'utf8');
    assert.ok(md.includes(menu), `${f}에 ${menu}`);
    assert.ok(md.includes(direct), `${f}에 ${direct}(사람을 넣을 권한이 없을 때 버튼 이름)`);
  }
});

test('초대 참여 이름은 메뉴와 같고, 숨김 안내는 실제 설정 경로, 방 사람 버튼은 초대하기', () => {
  assert.equal(DICT['phone.org.join'][0], '초대 코드로 참여');
  assert.match(DICT['inv.pasteHint'][0], /'초대 코드로 참여'/);
  assert.match(DICT['org.step.invite.sub'][0], /'초대 코드로 참여'/);
  assert.equal(DICT['crew.mute'][0], '에이전트 숨기기');
  assert.match(DICT['crew.muted'][0], /설정 > 친구 관리 > 숨김/);
  assert.equal(DICT['msg.mutedCrew'][0], '숨긴 에이전트의 메시지입니다.');
  assert.doesNotMatch(DICT['profile.quiet.desc'][0], /알림함 배지/);
  assert.deepEqual(DICT['ch.add'], ['초대하기', 'Invite']);
});
