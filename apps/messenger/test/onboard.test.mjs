// 조직 시작 단계 판단(D1·D3) — 새 채널 기본 종류와 단계 표지
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPublicChannel, newChannelKind, stepMarks } from '../src/onboard.mjs';

test('새 채널 기본 종류 — 조직에 공개 채널이 없으면 공개, 있으면(참여 안 한 것 포함) 비공개(D1)', () => {
  assert.equal(newChannelKind([], []), 'public');
  assert.equal(newChannelKind([{ kind: 'dm' }, { kind: 'private' }], []), 'public', 'DM·비공개만 있으면 아직 공개 채널 없음');
  assert.equal(newChannelKind([{ kind: 'public' }], []), 'private');
  assert.equal(newChannelKind([], [{ kind: 'public' }]), 'private', '참여 안 한 공개 채널도 조직의 공개 채널');
  assert.equal(hasPublicChannel(undefined, undefined), false);
});

test('단계 표지 — 지금 할 일은 하나, 첫 채널 뒤에도 초대·에이전트가 남는다(D3)', () => {
  assert.deepEqual(stepMarks({ hasChannel: false, isAdmin: true, invited: false, hasCrew: false }), { channel: 'mark', invite: '', agent: '' });
  assert.deepEqual(stepMarks({ hasChannel: true, isAdmin: true, invited: false, hasCrew: false }), { channel: 'done', invite: 'mark', agent: '' });
  assert.deepEqual(stepMarks({ hasChannel: true, isAdmin: true, invited: true, hasCrew: false }), { channel: 'done', invite: 'done', agent: 'mark' });
  assert.deepEqual(stepMarks({ hasChannel: true, isAdmin: true, invited: true, hasCrew: true }), { channel: 'done', invite: 'done', agent: 'done' });
  assert.deepEqual(stepMarks({ hasChannel: true, isAdmin: false, invited: false, hasCrew: false }), { channel: 'done', agent: 'mark' }, '관리자 아니면 초대 단계 없음, 에이전트가 할 일');
});

test('배선 — 새 채널을 여는 입구(데스크톱 +·폰 채널 탭 + 메뉴)가 모두 같은 기본값을 쓴다, 시작 단계는 빈 조직·첫 채널 뒤·폰 채널 탭 세 곳', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setNewCh\(\{ name: '', kind: '(public|private)' \}\)/, '입구마다 다른 글자 기본값 없음');
  assert.ok((src.match(/setNewCh\(\{ name: '', kind: newChKind \}\)/g)?.length ?? 0) >= 1, '기본값은 newChKind 하나');
  assert.match(src, /const openNewCh = \(\) => \{ setNewCh\(\{ name: '', kind: newChKind \}\);/, '데스크톱 +와 폰 + 메뉴가 같은 openNewCh');
  assert.match(src, /onClick=\{\(\) => \{ setChPlus\(false\); setBrowse\(null\); openNewCh\(\); \}\}/, '폰 채널 탭 + 메뉴 → 새 채널 만들기');
  assert.match(src, /const steps = org \? orgSteps\(\{ t, \.\.\.onboard, hasChannel: false/, '빈 조직 안내');
  assert.match(src, /startCard=\{org && !isPersonal && org\.role !== 'guest' && channel\.kind !== 'dm' \? <OnboardCard/, '첫 채널 뒤 남은 단계 — 조직 채널에서만(DM 제외, #626 검수)');
  assert.match(src, /if \(!priv\) \{ await q\(supabase\.rpc\('msgr_join_channel', \{ ch: id \}\)\);/, '공개 채널을 만들면 만든 사람이 참여(서버는 참여 행을 안 넣는다 — 행동은 onboarding.browser.mjs)');
  assert.match(src, /<div className="msgr-phsteps"><OrgStepList steps=\{orgSteps\(\{ t, \.\.\.onboard, hasChannel: false/, '폰 채널 탭(본문 안내가 안 보이는 자리)');
});

test('iOS는 "Argo 앱 받기" 버튼을 숨긴다(3.1.1/3.1.3 — 앱에는 가격·결제로 이어지는 링크를 두지 않는다), 다른 플랫폼은 그대로', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const agentActs = <span key="c" className="acts">\{!isIos && <button[\s\S]{0,200}onClick=\{\(\) => openExternal\(LEGAL\.download\)\}/, 'download 버튼이 !isIos로 가려져야 한다');
  assert.match(src, /download: 'https:\/\/argo\.ceo\/download'/, '가격·결제 버튼 없는 전용 다운로드 페이지를 가리켜야 한다(총괄 지시 2026-09-26)');
});
