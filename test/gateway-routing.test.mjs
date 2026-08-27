// 라우팅 판정 단위 — @멘션 파싱·기본 크루·사장 지시의 크루 배정 경계·결재 주체 표기.
// routeMessage는 기존 테스트에 케이스가 없다(export만 있었음). 임시 ARGO_ROOT — 실데이터 미접촉.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-gwroute-'));
const { routeMessage, crewStatusReply, approvalWho, defaultCrew } = await import('../src/gateway/routing.mjs');

// 크루 2명 픽스처 — 파일명 sort로 luca가 첫 번째(=defaultCrew 미지정 시 기본 크루)
const WS = 'routeco';
const agentsDir = join(process.env.ARGO_ROOT, WS, 'agents');
await mkdir(agentsDir, { recursive: true });
await writeFile(join(process.env.ARGO_ROOT, WS, 'company.json'), JSON.stringify({ id: WS, name: '항해 상사', lang: 'ko' }));
await writeFile(join(agentsDir, 'luca.md'), '---\nname: 루카\nrole: 항해사\n---\n');
await writeFile(join(agentsDir, 'pepper.md'), '---\nname: 페퍼\n---\n');

test('멘션 없음 → 기본 크루(defaultCrew 지정 시 그 크루, 아니면 첫 번째)', async () => {
  const r1 = await routeMessage(WS, {}, '오늘 항로 보고해');
  assert.equal(r1.slug, 'luca', 'defaultCrew 미지정 = 명단 첫 크루');
  assert.equal(r1.msg, '오늘 항로 보고해');
  assert.deepEqual(r1.cc, []);
  const r2 = await routeMessage(WS, { defaultCrew: 'pepper' }, '오늘 항로 보고해');
  assert.equal(r2.slug, 'pepper', 'defaultCrew가 기본을 바꾼다');
});

test('@멘션 — slug·한글 이름 모두, 대소문자 무시, 지시문에서 멘션 제거', async () => {
  const byName = await routeMessage(WS, {}, '@루카 항로 점검');
  assert.equal(byName.slug, 'luca');
  assert.equal(byName.msg, '항로 점검');
  const bySlug = await routeMessage(WS, {}, '@Pepper 재고 정리');
  assert.equal(bySlug.slug, 'pepper', 'slug 대소문자 무시');
});

test('@멘션 — NFD(맥 자소 분리) 입력도 NFC 이름과 매칭된다', async () => {
  const r = await routeMessage(WS, {}, `@${'루카'.normalize('NFD')} 점검`);
  assert.equal(r.slug, 'luca', '한글 정규화 불일치 방어');
});

test('다중 멘션 — 첫 번째가 to, 나머지는 cc(중복 제거)', async () => {
  const r = await routeMessage(WS, {}, '@루카 @페퍼 회의 준비');
  assert.equal(r.slug, 'luca');
  assert.deepEqual(r.cc.map((a) => a.slug), ['pepper']);
  assert.equal(r.msg, '회의 준비');
  const dup = await routeMessage(WS, {}, '@루카 @루카 회의 준비');
  assert.deepEqual(dup.cc, [], '같은 크루 반복 멘션은 한 번만');
});

test('미등록 @이름 경계 — 단독이면 오류+명단 안내, 유효 멘션 뒤면 본문으로 남긴다', async () => {
  const bad = await routeMessage(WS, {}, '@함장 보고해');
  assert.ok(bad.error?.includes('"함장" 크루를 못 찾았습니다'), '오타 멘션은 조용히 기본 크루로 넘기지 않는다');
  assert.ok(bad.error.includes('루카') && bad.error.includes('페퍼'), '오류에 실제 명단을 보여준다');
  const mixed = await routeMessage(WS, {}, '@루카 @함장 에게 전달해');
  assert.equal(mixed.slug, 'luca');
  assert.equal(mixed.msg, '@함장 에게 전달해', '크루가 아닌 @단어는 본문의 일부');
});

test('그룹방 봇 멘션(@봇이름) 접두는 벗겨지고 그 뒤 @크루가 라우팅된다', async () => {
  const cfg = { botUsername: 'argo_bot' };
  const r = await routeMessage(WS, cfg, '@argo_bot @페퍼 하이');
  assert.equal(r.slug, 'pepper');
  assert.equal(r.msg, '하이');
  const plain = await routeMessage(WS, cfg, '@argo_bot 하이');
  assert.equal(plain.slug, 'luca', '봇 멘션만 있으면 기본 크루');
  assert.equal(plain.msg, '하이');
});

test('크루 없는 회사 — 오류 안내(모델 호출 없이 즉답)', async () => {
  const WS0 = 'routeco-empty';
  await mkdir(join(process.env.ARGO_ROOT, WS0), { recursive: true });
  const r = await routeMessage(WS0, {}, '아무거나');
  assert.ok(r.error?.includes('아직 크루가 없습니다'));
});

test('crewStatusReply: 명단·기본 크루 표기·역할 표기', async () => {
  const s = await crewStatusReply(WS, {});
  assert.ok(s.includes('연결된 크루 2명'));
  assert.ok(s.includes('• 루카 (@luca) — 항해사 · 기본'), '첫 크루 = 기본 표기 + 역할');
  assert.ok(s.includes('• 페퍼 (@pepper)') && !s.includes('페퍼 (@pepper) · 기본'), '기본이 아닌 크루엔 표기 없음');
});

test('approvalWho: 위임 결재는 "크루명 (위임자명 위임)" — 결재 흐름 가시화', async () => {
  assert.equal(await approvalWho(WS, { slug: 'luca' }, 'ko'), '루카');
  assert.equal(await approvalWho(WS, { slug: 'luca', from: 'pepper' }, 'ko'), '루카 (페퍼 위임)');
  assert.equal(await approvalWho(WS, { slug: 'luca', from: 'pepper' }, 'en'), '루카 (delegated by 페퍼)');
  assert.equal(await approvalWho(WS, { slug: 'ghost' }, 'ko'), 'ghost', '명단에 없으면 slug 그대로(빈칸 방지)');
});

/* ── 기본 크루 정본 — routeMessage·crewStatusReply·inbox 폴백(gateway.mjs)이 공유하는 단일 판정 ── */
test('defaultCrew: 지정 크루 우선 → 첫 크루 폴백 → 명단 비면 null(사본 두 벌을 단일화한 계약)', () => {
  const agents = [{ slug: 'luca' }, { slug: 'pepper' }];
  assert.equal(defaultCrew(agents, { defaultCrew: 'pepper' }).slug, 'pepper');
  assert.equal(defaultCrew(agents, { defaultCrew: '없는크루' }).slug, 'luca', '지정이 명단에 없으면 첫 크루');
  assert.equal(defaultCrew(agents, {}).slug, 'luca');
  assert.equal(defaultCrew([], { defaultCrew: 'pepper' }), null, '명단이 비면 null — 호출부 옵셔널 체이닝과 짝');
  assert.equal(defaultCrew(agents, null).slug, 'luca', 'cfg null 안전');
});
