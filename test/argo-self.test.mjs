// 에이전트 아르고 자기 인식(argo_status·argo_help·argo_settings — src/argo-self.mjs, chat.mjs makeCrewServer).
// ① 데크 '기억 연결' — 도구 값 = 화면 셈(회사 API stats → 화면 linkedPercent → Dial 반올림)과 같은 픽스처에서 같은 숫자
// ② (능동 비서 상태 — 2026-10-13 오피스 분리 때 기능과 함께 지움) ③ 자기 루틴 목록과 회차 결과
// ④ 설정 바꾸기 권한 표 — 주인 1:1 바로 / 채널·다른 사람·루틴·위임 결재 카드 / 금지 키 거절 / 에이전트가 적어 보낸 출처는 무시
// ⑤ 결재 승인 → 시스템 적용(카드 문구 대조) ⑥ 출처 판정 표(settingsDirectTurn) ⑦ 러너별(SDK·네이티브·Codex 다리) 도구 부착
// ⑧ 도움말 검색·내부 전용 문자열 없음 ⑨ 지시문
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { register } from 'node:module';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-self-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off — 회사 API를 실제로 부른다
globalThis.__argoScheduler = true; globalThis.__argoGateway = true; // 라우트 임포트가 상주 루프를 띄우지 않게
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

const { createCompany, paths, loadCompany } = await import('../src/workspace.mjs');
const { makeCrewServer, systemPromptFor } = await import('../src/chat.mjs');
const { crewToolSpecs } = await import('../src/engine/native-query.mjs');
const { createCrewMcpBridge } = await import('../src/engine/crew-mcp.mjs');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const self = await import('../src/argo-self.mjs');
const { settingsDirectTurn } = await import('../src/gateway/msgr-handoff.mjs');
const { linkedPercent, dialPercent, deckMetrics } = await import('../src/deck-metrics.mjs');
const { listDocs } = await import('../src/hub.mjs');
const { addRoutine, loadRoutines } = await import('../src/routines.mjs');
const { loadApprovals, resolveApproval } = await import('../src/approvals.mjs');
const { _followUpForTest } = await import('../src/approval-actions.mjs');
const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
const { searchHelp, TOPICS } = await import('../src/help/index.mjs');
const { msgrRuntimeState } = await import('../src/connections.mjs');

const bridges = [];
after(async () => { for (const b of bridges) await b.close(); });

const card = (name, role) => `---\nname: ${name}\nrole: ${role}\n---\n# ${name}\n`;
async function company(ws, { owner = null, agents = [['pepper', '페퍼', '비서']] } = {}) {
  await createCompany(ws, `${ws} 회사`, 'me', owner);
  for (const [slug, name, role] of agents) await writeFile(join(paths(ws).agents, `${slug}.md`), card(name, role));
  return ws;
}
/** 크루 서버의 처리기 표 — SDK·네이티브·다리가 같은 정의를 쓴다(sink). */
function handlers(ws, { slug = 'pepper', ctx = null, direct = false, origin = null, chain = [] } = {}) {
  const sink = [];
  makeCrewServer(ws, slug, slug, [], chain.length, chain, ctx, 'ko', [], '', sink, null, false, undefined, null, null, null, origin, { settingsDirect: direct });
  const by = Object.fromEntries(sink.map((d) => [d.name, d]));
  const call = async (name, args) => (await by[name].handler(args, {})).content.map((c) => c.text).join('\n');
  return { sink, by, call };
}

// 메신저 맥락 — 주인 u-owner. 조직 채널(공개), 주인 혼자 1:1(게이트웨이가 방을 확인한 표지 ownerSolo), 다른 사람(u-guest)이 시킨 채널 글
const msgrCtx = (ws, extra = {}) => ({ kind: 'msgr', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1', threadRoot: 'm1', sourceMsgId: 'm1', uid: 'u-owner', origin: 'u-owner', wsId: ws, hop: 0, channelKind: 'public', peers: [], handoffs: [], ...extra });

/* ── ① 데크 '기억 연결' — 화면 셈 = 도구 값 ─────────────────────────────── */
test('데크 기억 연결 — 회사 API stats → 화면 linkedPercent → Dial 반올림 값과 argo_status 값이 같다(소수 둘째 자리까지 같은 픽스처)', async () => {
  const ws = await company('as-deck');
  const notes = paths(ws).notes;
  // 노트 3개 중 2개가 서로 이어진다(alpha↔beta), gamma는 고립 — 스캐폴드 안내 노트는 셈 밖
  await writeFile(join(notes, 'alpha.md'), '# Alpha\n[[Beta]]\n');
  await writeFile(join(notes, 'beta.md'), '# Beta\n본문\n');
  await writeFile(join(notes, 'gamma.md'), '# Gamma\n본문\n');
  const route = await import('../app/api/companies/[ws]/route.js');
  const res = await route.GET(new Request(`http://localhost/api/companies/${ws}`), { params: Promise.resolve({ ws }) });
  const data = await res.json();
  const screen = dialPercent(linkedPercent(data.stats)); // 화면: const linkedPct = linkedPercent(stats) → <Dial value={linkedPct}> → Math.round
  const d = deckMetrics({ docs: await listDocs(ws), agentCount: data.agents.length });
  assert.equal(d.linked, 2, '연결된 기억 = alpha·beta');
  assert.equal(d.isolated, 1, '고립 = gamma(안내 노트 제외)');
  assert.equal(screen, 67, '2/3 = 66.7% → 화면 67%');
  assert.equal(d.linkedPercentShown, screen);
  assert.equal(d.links, data.stats.links);
  const out = await handlers(ws, { direct: true }).call('argo_status', { section: 'deck' });
  assert.match(out, new RegExp(`연결된 기억 ${screen}%`), out);
  assert.match(out, /2건 ÷ \(연결된 기억 2 \+ 고립된 기억 1\) = 66\.7%/);
  assert.match(out, /연결 1쌍/);
  assert.match(out, new RegExp(`기억: ${data.memoryCount}건`));
  assert.match(out, /안내 노트 \d+건은 기억이 아니라 셈에서 뺀다/);
});

test('데크 화면·라우트가 같은 정본 함수를 쓴다 — 화면이 셈을 다시 만들지 않는다', () => {
  const page = readFileSync(new URL('../app/c/[ws]/page.jsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../app/api/companies/[ws]/route.js', import.meta.url), 'utf8');
  assert.match(page, /import \{ linkedPercent, learnedThisWeek \} from '\.\.\/\.\.\/\.\.\/src\/deck-metrics\.mjs';/);
  assert.match(page, /const linkedPct = linkedPercent\(stats\);[\s\S]*?<Dial value=\{linkedPct\} label=\{t\('deck\.linked'\)\} \/>/);
  assert.match(page, /const learned = learnedThisWeek\(docs\);/);
  assert.doesNotMatch(page, /stats\.linked \/ \(stats\.linked \+ stats\.isolated\)/, '화면에 셈 사본이 남으면 도구와 갈라진다');
  assert.match(route, /import \{ docStats \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/deck-metrics\.mjs';/);
  const ui = readFileSync(new URL('../app/ui.jsx', import.meta.url), 'utf8');
  assert.match(ui, /\{dialPercent\(v\)\}%<\/span>/, '다이얼 글자도 같은 반올림 함수(dialPercent)');
  assert.doesNotMatch(ui, /Math\.round\(v\)\}%/);
  assert.doesNotMatch(route, /function docStats\(/, '라우트에 셈 사본 금지');
});

/* ── ③ 자기 루틴 ────────────────────────────────────────────────────── */
test('자기 루틴 — me 구획은 내 루틴만, routines 구획은 전부. 마지막 실행 결과·실패·요약을 싣는다', async () => {
  const ws = await company('as-rout', { agents: [['pepper', '페퍼', '비서'], ['mina', '미나', '리서처']] });
  const a = await addRoutine(ws, { agentSlug: 'pepper', title: '아침 브리핑', prompt: '브리핑', schedule: { type: 'daily', time: '09:00', tz: 'Asia/Seoul' } });
  await addRoutine(ws, { agentSlug: 'mina', title: '가격 조사', prompt: '조사', schedule: { type: 'weekly', time: '10:00', dows: [1], tz: 'Asia/Seoul' } });
  const rs = await loadRoutines(ws);
  Object.assign(rs.find((r) => r.id === a.id), { lastRun: new Date(Date.now() - 2 * 3_600_000).toISOString(), lastOk: false, lastResult: '메일 서버 응답 없음으로 실패' });
  await writeJsonAtomic(paths(ws).routines, rs);
  const me = await handlers(ws, { direct: true }).call('argo_status', { section: 'me' });
  assert.match(me, /내 루틴 1개/);
  assert.match(me, /아침 브리핑 \[r[0-9a-z]+\] — 매일 09:00 · 담당 pepper · 가동 · 마지막 실행 .+\(2시간 전\) 실패/);
  assert.match(me, /결과 요약: 메일 서버 응답 없음으로 실패/);
  assert.doesNotMatch(me, /가격 조사/, '남의 루틴은 me에 없다');
  const all = await handlers(ws, { direct: true }).call('argo_status', { section: 'routines' });
  assert.match(all, /루틴 2개/);
  assert.match(all, /가격 조사 .* 매주 월 10:00 · 담당 mina · 가동 · 아직 실행 전/);
});

/* ── ④ 설정 바꾸기 권한 표 ──────────────────────────────────────────── */
// 예시 설정 = routine.time(루틴 실행 시각, needsId) — 시험마다 08:00 매일 루틴을 하나 만들고 그 id를 넘긴다(하트비트 알림 설정은 2026-10-13 능동 비서와 함께 지웠다)
const RT_LABEL = '루틴 실행 시각\\(시각 하나인 1회·매일·매주 루틴\\)';
const newRoutine = async (ws, slug = 'pepper') => (await addRoutine(ws, { agentSlug: slug, title: '아침 정리', prompt: '정리', schedule: { type: 'daily', time: '08:00', tz: 'Asia/Seoul' } })).id;
const timeOf = async (ws, id) => { const sc = (await loadRoutines(ws)).find((r) => r.id === id).schedule; return (Array.isArray(sc.times) && sc.times.length ? sc.times : [sc.time])[0]; };
const pendingSettings = async (ws) => (await loadApprovals(ws)).filter((a) => a.kind === 'setting' && a.status === 'pending');

test('권한 표 — 주인 1:1(서버 판정 direct)이면 바로 바꾸고 이전 값 → 새 값·되돌리는 법을 돌려준다, 결재는 없다', async () => {
  const ws = await company('as-set-direct');
  const rid = await newRoutine(ws);
  assert.equal(await timeOf(ws, rid), '08:00');
  const out = await handlers(ws, { direct: true }).call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '7:00' });
  assert.equal(await timeOf(ws, rid), '07:00', '실제 저장(루틴 화면과 같은 updateRoutine)');
  assert.match(out, new RegExp(`바꿨다 — ${RT_LABEL} — 아침 정리: 08:00 → 07:00`));
  assert.match(out, /되돌리는 법: "08:00\(으\)로 되돌려 줘"/);
  assert.match(out, /루틴 화면 → 그 루틴 편집 → 시각/, '화면 위치');
  assert.equal((await pendingSettings(ws)).length, 0);
  const same = await handlers(ws, { direct: true }).call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '07:00' });
  assert.match(same, /이미 07:00\(으\)로 되어 있다 — 바꾸지 않았다/, '같은 값이면 쓰지 않는다(쓰기 0)');
  // 화면 검증 규칙을 그대로 받는다 — 시각 형식이 아니거나 시각이 없는 루틴(N분마다)은 저장하지 않는다
  assert.match(await handlers(ws, { direct: true }).call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '25:00' }), /시각은 HH:MM/);
  const iv = (await addRoutine(ws, { agentSlug: 'pepper', title: '자주 확인', prompt: '확인', schedule: { type: 'interval', everyMinutes: 30, tz: 'Asia/Seoul' } })).id;
  assert.match(await handlers(ws, { direct: true }).call('argo_settings', { action: 'set', key: 'routine.time', id: iv, value: '09:00' }), /N분마다 도는 루틴은 시각이 없다/);
  assert.equal(await timeOf(ws, rid), '07:00');
  assert.equal((await pendingSettings(ws)).length, 0);
});

test('권한 표 — 채널(주인이 써도 1:1 아님)·다른 사람·루틴·위임은 결재 카드, 값은 그대로', async () => {
  const cases = [
    ['as-set-channel', { ctx: (ws) => msgrCtx(ws) }, '조직 채널(주인)'],
    ['as-set-guest', { ctx: (ws) => msgrCtx(ws, { origin: 'u-guest' }) }, '다른 사람'],
    ['as-set-routine', { origin: 'mina' }, '루틴·작업 턴(notOwnerDirect)'],
    ['as-set-deleg', { chain: ['mina'] }, '위임받은 턴'],
  ];
  for (const [ws, o, label] of cases) {
    await company(ws, { agents: [['pepper', '페퍼', '비서'], ['mina', '미나', '리서처']] });
    const rid = await newRoutine(ws);
    const h = handlers(ws, { ctx: o.ctx?.(ws) ?? null, origin: o.origin ?? null, chain: o.chain ?? [], direct: false });
    const guest = label === '다른 사람';
    const out = await h.call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '07:00', why: '아침이 이르다' });
    assert.equal(await timeOf(ws, rid), '08:00', `${label}: 결재 전에는 바뀌지 않는다`);
    if (guest) {
      // 다른 사람(손님)은 루틴을 결재로도 올리지 못한다(cancel_routine과 같은 규칙) — 결재 흐름은 루틴이 아닌 남은 설정(company.lang)으로 본다
      assert.match(out, /루틴은 이 에이전트의 주인만 바꿀 수 있다/, label);
      assert.equal((await pendingSettings(ws)).length, 0, `${label}: 루틴 결재 카드 없음`);
      assert.match(await h.call('argo_settings', { action: 'set', key: 'company.lang', value: 'en', why: '영어로' }), /주인 결재로 올렸다/, label);
      assert.equal((await loadCompany(ws)).lang ?? 'ko', 'ko', `${label}: 결재 전에는 바뀌지 않는다`);
    } else assert.match(out, /주인 결재로 올렸다/, label);
    const [ap] = await pendingSettings(ws);
    assert.ok(ap, `${label}: 결재 카드`);
    if (guest) {
      assert.equal(ap.action, '설정 변경 — 에이전트 응답 언어 → en');
      assert.deepEqual({ key: ap.payload.key, value: ap.payload.value }, { key: 'company.lang', value: 'en' });
    } else {
      assert.equal(ap.action, `설정 변경 — 루틴 실행 시각(시각 하나인 1회·매일·매주 루틴) [${rid}] → 07:00`);
      assert.deepEqual({ key: ap.payload.key, id: ap.payload.id, value: ap.payload.value }, { key: 'routine.time', id: rid, value: '07:00' });
    }
    if (o.ctx) assert.equal(ap.msgr?.channelId, 'ch-1', `${label}: 메신저 카드 목적지`);
    if (o.origin || o.chain) assert.equal(ap.from, 'mina', `${label}: 누구의 위임·예약에서 왔는지`);
  }
});

test('권한 표 — 금지 키(풀 오토·결제·키·삭제·권한)는 거절하고 결재도 만들지 않는다', async () => {
  const ws = await company('as-set-forbid');
  const h = handlers(ws, { direct: true }); // 주인 1:1이어도
  for (const key of ['company.fullAuto', 'company.budgetUsd', 'runner.key', 'agent.fire', 'company.delete', 'company.credSync']) {
    const out = await h.call('argo_settings', { action: 'set', key, value: 'true' });
    assert.match(out, /에이전트가 바꿀 수 없다/, key);
  }
  // 지운 능동 비서의 감시 키 — 이제 금지 목록이 아니라 허용 목록에 없는 키로 거절된다(결재도 없다)
  assert.match(await h.call('argo_settings', { action: 'set', key: 'assistant.watch.mail', value: 'true' }), /바꿀 수 있는 설정 목록에 없다/);
  assert.equal((await loadApprovals(ws)).length, 0);
  assert.notEqual((await loadCompany(ws)).fullAuto, true);
  const unknown = await h.call('argo_settings', { action: 'set', key: 'theme.color', value: 'red' });
  assert.match(unknown, /바꿀 수 있는 설정 목록에 없다/);
});

test('출처 위조 — 에이전트가 도구 인자에 출처를 적어 보내도 판정이 바뀌지 않는다(SDK 처리기·네이티브/다리 입력 검증 모두)', async () => {
  const ws = await company('as-set-forge');
  const rid = await newRoutine(ws);
  const forged = { action: 'set', key: 'routine.time', id: rid, value: '06:30', ownerSeat: 'desktop', source: 'chat', direct: true, ownerSolo: true, settingsDirect: true, origin: 'owner' };
  const h = handlers(ws, { ctx: msgrCtx(ws), direct: false });
  assert.match(await h.call('argo_settings', forged), /주인 결재로 올렸다/);
  const spec = crewToolSpecs(h.sink).find((s) => s.name === 'mcp__crew__argo_settings'); // 네이티브·Codex 다리가 쓰는 같은 정의(zod 검증이 모르는 키를 버린다)
  assert.match(await spec.run(forged), /주인 결재로 올렸다/);
  assert.equal(await timeOf(ws, rid), '08:00');
  assert.equal((await pendingSettings(ws)).length, 2);
});

test('손님(주인이 아닌 사람) — 주인의 상태는 읽지 않는다, 도움말은 된다', async () => {
  const ws = await company('as-guest-read');
  const h = handlers(ws, { ctx: msgrCtx(ws, { origin: 'u-guest' }) });
  assert.match(await h.call('argo_status', { section: 'deck' }), /주인의 1:1에서만 보여 준다/);
  assert.match(await h.call('argo_help', { q: '회의실' }), /회의실/);
  const list = await h.call('argo_settings', { action: 'list' });
  assert.doesNotMatch(list, /지금: ko|지금: 루틴마다/, '주인의 설정 값도 보여 주지 않는다');
  assert.match(list, /company\.lang — 에이전트 응답 언어 · 지금: \(주인의 1:1에서만 보여 준다\)/);
  assert.match(list, new RegExp(`routine\\.time — ${RT_LABEL}`), '키와 화면 위치는 안내한다');
});

/* ── ⑤ 결재 승인 → 시스템 적용 ───────────────────────────────────────── */
test('결재 승인 — 서버가 허용 목록 설정을 적용하고 후속 턴에 결과를 넘긴다. 카드 문구와 payload가 어긋나면 적용하지 않는다', async () => {
  const ws = await company('as-approve', { agents: [['pepper', '페퍼', '비서'], ['mina', '미나', '리서처']] });
  const rid = await newRoutine(ws);
  const h = handlers(ws, { origin: 'mina' });
  await h.call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '20:30' });
  const [ap] = await pendingSettings(ws);
  let seen = null;
  const runChat = async (_ws, _slug, msg, _sid, opts) => { seen = { msg, opts }; return { reply: 'ok', sessionId: null }; };
  const item = await resolveApproval(ws, ap.id, true);
  await _followUpForTest(ws, item, true, { runChat });
  assert.equal(await timeOf(ws, rid), '20:30');
  assert.match(seen.msg, new RegExp(`적용 완료 — ${RT_LABEL} → 20:30\\(화면: 루틴 화면 → 그 루틴 편집 → 시각\\)`));
  assert.doesNotMatch(seen.msg, /08:00/, '후속 보고(원래 방으로 간다)에 이전 값을 싣지 않는다');
  assert.equal(seen.opts.notOwnerDirect, 'mina', '후속 턴도 주인 직접 턴이 아니다');
  // 문구 조작 — 카드에는 20:00으로 보였는데 payload가 23:00이면 적용하지 않는다
  await h.call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '20:00' });
  const [ap2] = await pendingSettings(ws);
  const tampered = { ...(await resolveApproval(ws, ap2.id, true)), payload: { ...ap2.payload, value: '23:00' } };
  await _followUpForTest(ws, tampered, true, { runChat });
  assert.match(seen.msg, /적용 취소 — 결재 내용/);
  assert.equal(await timeOf(ws, rid), '20:30');
});

/* ── ⑥ 출처 판정 표 ─────────────────────────────────────────────────── */
test('출처 판정 표 — 데스크톱 대화 라우트 표지 + 주인 혼자 1:1만 바로, 나머지는 결재', () => {
  const owner = { kind: 'msgr', uid: 'u1', origin: 'u1', channelKind: 'dm', ownerSolo: true, orgId: null };
  const rows = [
    [{ ownerSeat: 'desktop' }, true, '데스크톱 1:1 대화'],
    [{}, false, '표지 없음 — 결재 후속·argo CLI'],
    [{ source: 'messenger' }, false, '텔레그램·슬랙 1:1'],
    [{ ownerSeat: 'desktop', source: 'room' }, false, '회의실'],
    [{ ownerSeat: 'desktop', from: 'mina', hop: 1 }, false, '위임받은 턴'],
    [{ ownerSeat: 'desktop', notOwnerDirect: 'mina' }, false, '에이전트가 건 루틴·작업'],
    [{ ownerSeat: 'desktop', chain: ['mina'] }, false, '위임 사슬'],
    [{ ownerSeat: 'desktop', mirrorCtx: { kind: 'scope', scope: { kind: 'shared' } } }, false, '자동 턴 범위'],
    [{ mirrorCtx: owner }, true, '메신저 주인 혼자 1:1'],
    [{ mirrorCtx: { ...owner, ownerSolo: false } }, false, '메신저 1:1인데 방 확인 표지 없음'],
    [{ mirrorCtx: { ...owner, origin: 'u2' } }, false, '다른 사람이 쓴 글'],
    [{ mirrorCtx: { ...owner, channelKind: 'public' } }, false, '메신저 채널'],
    [{ mirrorCtx: { ...owner, handoffFrom: 'crew-x' } }, false, '에이전트가 넘긴 턴'],
    [{ mirrorCtx: { ...owner, office: true } }, false, '오피스에서 맡긴 글'],
    [{ mirrorCtx: { ...owner, hop: 1 } }, false, '메신저 넘김 단계'],
  ];
  for (const [input, want, label] of rows) assert.equal(settingsDirectTurn(input), want, label);
});

test('데스크톱 표지는 대화 라우트만 붙이고(요청 본문에서 받지 않는다) 재시도 재귀만 잇는다', () => {
  const route = readFileSync(new URL('../app/api/companies/[ws]/chat/route.js', import.meta.url), 'utf8');
  assert.match(route, /const \{ slug, message, sessionId, attachments: rawAtt \} = await req\.json\(\);/, '본문에서 표지를 받지 않는다');
  assert.match(route, /await chat\(ws, slug, message\.trim\(\), sessionId \|\| null, \{ attachments, ownerSeat: 'desktop',/);
  const chatSrc = readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.equal((chatSrc.match(/await chat\(wsId, agentSlug, userMsg, (?:sessionId|null), \{ __turnControl, from, source, ownerSeat,/g) ?? []).length, 8, '재시도 재귀 8곳(2026-10-15 같은 계정 codex 구독 회복의 같은 러너 1회 재시도 포함 — 크래시 재시도와 같은 인자로 표지를 잇는다)');
  assert.doesNotMatch(chatSrc.match(/chatOpts: \{[^}]*\}/)[0], /ownerSeat/, '도구 결과 후속 턴은 잇지 않는다(외부 결과가 담긴 턴)');
  // runChat의 두 크루 서버 생성(Codex 다리 갈래·SDK/네이티브 갈래)이 모두 서버 판정값을 싣는다 — SDK 갈래의 행동은 argo-self-sdk.test.mjs가 잠근다
  assert.match(chatSrc, /const settingsDirect = settingsDirectTurn\(\{ ownerSeat, source, from, notOwnerDirect, hop, chain, mirrorCtx \}\);/);
  assert.equal((chatSrc.match(/makeCrewServer\(wsId, agentSlug, meta\.name \|\| agentSlug, \w+, hop, chain, mirrorCtx, lang, \w+, workFolder, \w+, journal, fullAuto, lim, tree, turnCounters, await sessionToolFor\([^)]*\), notOwnerDirect, \{ settingsDirect, goalTurn, autoTurn: [^}]*\}\)/g) ?? []).length, 2); // 목표 하트비트 회차 자리(goalTurn)·회차/루틴/작업 턴 표지(autoTurn)도 같은 두 곳이 싣는다
});

/* ── ⑦ 러너별 부착 ──────────────────────────────────────────────────── */
test('러너별 부착 — SDK 크루 서버·네이티브 sink·Codex 다리(실제 stdio 자식)에 같은 세 도구가 있고 처리기가 돈다', async () => {
  const ws = await company('as-runners');
  const want = ['argo_help', 'argo_settings', 'argo_status'];
  const sdk = makeCrewServer(ws, 'pepper', '페퍼', [], 0, [], null, 'ko', [], '', null, null, false, undefined, null, null, null, null, { settingsDirect: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await sdk.instance.connect(st);
  const sdkClient = new Client({ name: 't', version: '1' }); await sdkClient.connect(ct);
  const sdkNames = (await sdkClient.listTools()).tools.map((t) => t.name);
  const viaSdk = await sdkClient.callTool({ name: 'argo_status', arguments: { section: 'agents' } });
  await sdkClient.close();
  for (const n of want) assert.ok(sdkNames.includes(n), `SDK ${n}`);
  assert.match(viaSdk.content[0].text, /에이전트 1명/);

  const { sink } = handlers(ws);
  for (const n of want) assert.ok(sink.some((d) => d.name === n), `네이티브 ${n}`);
  assert.ok(crewToolSpecs(sink).some((s) => s.name === 'mcp__crew__argo_status'));

  const bridge = await createCrewMcpBridge(crewToolSpecs(sink)); bridges.push(bridge);
  const transport = new StdioClientTransport({ command: bridge.server.command, args: bridge.server.args, env: { ...process.env, ...bridge.server.env }, stderr: 'pipe' });
  const client = new Client({ name: 'codex-like', version: '1' }); await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of want) assert.ok(names.includes(n), `Codex 다리 ${n}`);
    const r = await client.callTool({ name: 'argo_help', arguments: { q: '연결 밀도' } });
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /# 데크 — 회사 계기판/);
  } finally { await client.close(); }
});

/* ── ⑧ 도움말 ──────────────────────────────────────────────────────── */
test('도움말 검색 — 사용자 말투로 물어도 맞는 주제가 먼저 온다', () => {
  assert.match(searchHelp('지금 연결 밀도가 몇%지?'), /^# 데크 — 회사 계기판/);
  assert.match(searchHelp('하트비트 돌고 있어?'), /^# 목표 하트비트/); // 남은 하트비트 = 목표 하트비트(능동 비서 주제는 2026-10-13 지웠다)
  assert.match(searchHelp('루틴 시각 7시로 바꿔줘'), /^# 루틴/);
  assert.match(searchHelp('Memory Links', { lang: 'en' }), /^# Deck/);
  assert.match(searchHelp(''), /아르고 도움말 주제/);
  assert.match(searchHelp('zzqq없는말'), /맞는 도움말이 없다/);
});

test('도움말 — 모든 주제가 ko·en을 갖고, 내부 전용 문자열(이메일·사람 이름·PR 번호·내부 경로·환경변수·옛 낱말)이 없다', () => {
  assert.ok(TOPICS.length >= 18, `주제 수 ${TOPICS.length}`);
  const ids = new Set();
  const banned = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '이메일'],
    [/유건|효원|페퍼|김효율|yoogeon|leankim/i, '사람 이름'],
    [/#\d{2,}|\bPR\s?\d+/, 'PR 번호'],
    [/(?:^|[\s(`'"])(?:docs|artifacts|src|app|supabase|scripts)\/[\w./[\]-]+/m, '내부 경로'],
    [/~\/|\/Users\/|lean-projects/, '홈 경로'],
    [/\b(?:ARGO|OFFICE|NEXT_PUBLIC|SUPABASE)_[A-Z_]+/, '환경변수 이름'],
    [/크루|사장|선장|\b(?:crews?|captain|boss)\b/i, '옛 낱말'],
    [/결함|버그 목록|사고 이력|취약|known issue|incident/i, '결함·사고 이력'],
    [/\b[0-9a-f]{8,40}\b/, '커밋 해시'],
  ];
  for (const t of TOPICS) {
    assert.ok(!ids.has(t.id), `중복 id ${t.id}`); ids.add(t.id);
    for (const L of ['ko', 'en']) {
      const v = t[L];
      assert.ok(v?.title && v.body?.length > 200 && Array.isArray(v.keywords) && v.keywords.length >= 3, `${t.id}.${L} 모양`);
      const all = `${v.title}\n${v.keywords.join(' ')}\n${v.body}`;
      for (const [re, what] of banned) assert.doesNotMatch(all, re, `${t.id}.${L}: ${what}`);
    }
  }
});

/* ── ⑨ 메신저 응답 상태 판정(카드와 같은 함수) ───────────────────────── */
test('메신저 응답 상태 — 카드 라우트와 도구가 같은 판정 함수를 쓴다', () => {
  assert.deepEqual(msgrRuntimeState({ alive: true, lastTs: 5 }), { state: 'alive', lastTs: 5 });
  assert.deepEqual(msgrRuntimeState({ alive: false, error: '기기 세션 없음' }), { state: 'login' });
  assert.deepEqual(msgrRuntimeState({ alive: false, error: '소유자 계정이 아님' }), { state: 'owner' });
  assert.deepEqual(msgrRuntimeState({ alive: false, error: 'x', lastTs: 1 }), { state: 'offline' });
  assert.deepEqual(msgrRuntimeState(null), { state: 'waiting' });
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  assert.match(route, /const runtimeState = msgrRuntimeState;/);
});

test('상태 구획 — 러너는 키 값을 싣지 않고, 메신저·동기화·요금제 구획은 로컬 값으로 답한다', async () => {
  const ws = await company('as-sections');
  const { call } = handlers(ws, { direct: true });
  const runners = await call('argo_status', { section: 'runners' });
  assert.match(runners, /러너 연결/);
  assert.doesNotMatch(runners, /sk-|\*\*\*/, '가려진 키 조각도 싣지 않는다');
  // 기본(0.1.115+) = 새 메신저 연결만 — 옛 브리지 응답 상태('응답을 확인하지 못함')로 읽지 않는다(2026-10-28 제보)
  assert.match(await call('argo_status', { section: 'messenger' }), /Argo 메신저 응답 상태: 새 Argo 메신저로 연결/);
  const legacyBefore = process.env.ARGO_MSGR_LEGACY;
  process.env.ARGO_MSGR_LEGACY = 'on'; // 옛 브리지를 켠 기기는 종전 판정 그대로
  try { assert.match(await call('argo_status', { section: 'messenger' }), /Argo 메신저 응답 상태: 아직 첫 응답을 기다리는 중/); }
  finally { if (legacyBefore === undefined) delete process.env.ARGO_MSGR_LEGACY; else process.env.ARGO_MSGR_LEGACY = legacyBefore; }
  assert.match(await call('argo_status', { section: 'sync' }), /기기 간 동기화/);
  assert.match(await call('argo_status', { section: 'plan' }), /요금제·사용량/);
  assert.match(await call('argo_status', { section: 'approvals' }), /결재 대기 0건/);
  const overview = await call('argo_status', {});
  assert.match(overview, /나 — 에이전트 카드와 같은 값\n- 이름: 페퍼 \[pepper\]/); // me 구획 — 카드 화면과 같은 칸(argo-self-card.test.mjs가 칸별로 잠근다)
  assert.match(overview, /데크 계기판/);
  assert.doesNotMatch(overview, /하트비트\(능동 알림\)/, '지운 능동 비서 구획이 개요에 남지 않는다');
});

test('설정 목록 — 이 턴이 바로 바뀌는 턴인지와 허용 키·지금 값·화면 위치를 보여 준다', async () => {
  const ws = await company('as-list');
  const direct = await handlers(ws, { direct: true }).call('argo_settings', { action: 'list' });
  assert.match(direct, /이 턴은 주인이 1:1에서 직접 시킨 턴이다/);
  assert.match(direct, new RegExp(`routine\\.time — ${RT_LABEL} · 지금: 루틴마다 다름\\(argo_status section=routines\\) · HH:MM · id`));
  assert.match(direct, /company\.lang — 에이전트 응답 언어 · 지금: ko/);
  assert.match(direct, /풀 오토/);
  const viaApproval = await handlers(ws, { ctx: msgrCtx(ws) }).call('argo_settings', { action: 'list' });
  assert.match(viaApproval, /주인 결재 카드로 올라간다/);
});

test('지시문 — 도구가 있는 러너는 아르고 질문을 도구로 확인하라, 없는 러너는 확인할 수 없다고 말하라', () => {
  const withTools = systemPromptFor('# 페퍼', '/tmp/x', '', { name: '페퍼' }, 'ko', { hasTools: true });
  assert.match(withTools, /argo_status\(너 자신은 section=me\)·argo_help로 확인하라/);
  assert.match(withTools, /네가 대화 밖에서 보낸 글\(하트비트 알림·루틴 결과 — 네 글이다\)/);
  const noTools = systemPromptFor('# 페퍼', '/tmp/x', '', { name: '페퍼' }, 'ko', { hasTools: false });
  assert.match(noTools, /이 러너에는 아르고 상태 도구가 없다/);
  const en = systemPromptFor('# Pepper', '/tmp/x', '', { name: 'Pepper' }, 'en', { hasTools: true });
  assert.match(en, /checked with argo_status \(section=me for yourself\) \/ argo_help before you answer/);
});

test('언어 설정 — 주인 1:1에서 바꾸면 회사 언어가 바뀐다(updateCompany에는 lang 하나만)', async () => {
  const ws = await company('as-lang');
  const before = JSON.parse(await readFile(paths(ws).company, 'utf8'));
  const out = await handlers(ws, { direct: true }).call('argo_settings', { action: 'set', key: 'company.lang', value: 'en' });
  assert.match(out, /ko → en/);
  const afterCo = JSON.parse(await readFile(paths(ws).company, 'utf8'));
  assert.equal(afterCo.lang, 'en');
  assert.deepEqual(Object.keys(afterCo).sort(), Object.keys(before).sort(), '다른 칸을 만들지 않는다');
});

/* ── ⑩ 누가 물었나로 범위를 정한다(총괄 보안 지적 2026-10-09) ─────────────── */
// 주인 1:1(데스크톱 1:1·메신저 주인 혼자 1:1 — 서버 판정 settingsDirect)만 전체 상태. 그 밖은 그 방 사람이 이미 볼 수 있는 것과 도움말만.
// 판정 재료는 runChat이 정한 값(makeCrewServer의 settingsDirect·mirrorCtx·chain·origin)뿐 — 도구 인자로 받지 않는다.
test('범위 표 — 칸마다 돌려주는 것: 주인 1:1만 전체 상태·설정 값, 나머지는 도움말만(상태·설정 값 없음)', async () => {
  const ws = await company('as-scope', { owner: 'u-owner', agents: [['pepper', '페퍼', '비서'], ['mina', '미나', '리서처']] });
  await addRoutine(ws, { agentSlug: 'mina', title: '비밀 보고', prompt: '보고', schedule: { type: 'daily', time: '09:00', tz: 'Asia/Seoul' } });
  const cells = [
    ['주인 1:1', { direct: true }, true],
    ['채널에서 주인', { ctx: msgrCtx(ws) }, false],
    ['채널에서 다른 사람', { ctx: msgrCtx(ws, { origin: 'u-other' }) }, false],
    ['게스트', { ctx: msgrCtx(ws, { guest: true }) }, false],
    ['루틴(주인이 만든 것)', {}, false],
    ['위임', { chain: ['mina'] }, false],
  ];
  for (const [label, o, full] of cells) {
    const h = handlers(ws, { direct: !!o.direct, ctx: o.ctx ?? null, chain: o.chain ?? [] });
    const overview = await h.call('argo_status', {});
    const plan = await h.call('argo_status', { section: 'plan' });
    const routines = await h.call('argo_status', { section: 'routines' });
    const list = await h.call('argo_settings', { action: 'list' });
    const help = await h.call('argo_help', { q: '회의실' });
    assert.match(help, /회의실/, `${label}: 도움말은 누구에게나`);
    if (full) {
      assert.match(overview, /데크 계기판/, label); assert.match(overview, /나 — 에이전트 카드와 같은 값/, label);
      assert.match(plan, /요금제·사용량/, label);
      assert.match(routines, /비밀 보고/, label);
      assert.match(list, /지금: ko/, label);
    } else {
      for (const [name, out] of [['overview', overview], ['plan', plan], ['routines', routines]]) {
        assert.match(out, /주인의 1:1에서만/, `${label} ${name}: 범위 밖 안내`);
        assert.doesNotMatch(out, /데크 계기판|나 — 에이전트 카드와 같은 값|요금제·사용량|비밀 보고|러너 연결|기기 간 동기화|결재 대기 \d/, `${label} ${name}: 주인 상태가 새지 않는다`);
      }
      assert.doesNotMatch(list, /지금: ko|지금: 루틴마다/, `${label}: 설정 값 없음`);
    }
  }
});

test('범위 밖 설정 변경 — 결재 카드에 지금 값이 실리지 않고, 사유의 키 모양 문자열은 가린다', async () => {
  const ws = await company('as-scope-card');
  const rid = await newRoutine(ws);
  const fake = `sk-ant-api03-${'q'.repeat(40)}`;
  // 주인이 조직 채널에서 시킨 턴(범위 밖) — 다른 사람(손님)은 루틴을 결재로도 올리지 못하므로 카드가 생기는 칸으로 본다
  const out = await handlers(ws, { ctx: msgrCtx(ws) }).call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '07:00', why: `토큰 ${fake} 참고` });
  assert.match(out, /주인 결재로 올렸다/);
  assert.doesNotMatch(out, /08:00/, '도구 결과에 지금 값 없음');
  const [ap] = await pendingSettings(ws);
  assert.doesNotMatch(`${ap.action}\n${ap.reason}`, /08:00/, '카드에 지금 값 없음');
  assert.doesNotMatch(ap.reason, /sk-ant-api03-q/, '키 모양 문자열은 가린다');
  // 이미 같은 값이어도 범위 밖에서는 같다/다르다를 알려 주지 않는다(카드는 올리고, 적용 단계가 "이미"로 끝낸다)
  const same = await handlers(ws, { ctx: msgrCtx(ws) }).call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '08:00' });
  assert.doesNotMatch(same, /이미 08:00/);
});

test('다른 회사 지정 불가 — 도구 인자에 회사 id·슬러그·경로를 넣어도 지금 턴의 회사만 본다', async () => {
  const a = await company('as-co-a');
  const b = await company('as-co-b', { agents: [['bee', '비', '다른 회사 비서']] });
  await writeFile(join(paths(b).notes, 'b1.md'), '# B1\n[[B2]]\n'); await writeFile(join(paths(b).notes, 'b2.md'), '# B2\n');
  const rb = await addRoutine(b, { agentSlug: 'bee', title: 'B 루틴', prompt: 'p', schedule: { type: 'daily', time: '10:00', tz: 'Asia/Seoul' } });
  const h = handlers(a, { direct: true });
  const spec = (name) => crewToolSpecs(h.sink).find((s) => s.name === `mcp__crew__${name}`);
  const deck = await spec('argo_status').run({ section: 'deck', wsId: b, ws: b, company: b, companyId: b, path: `../${b}`, slug: 'bee' });
  assert.match(deck, /에이전트: 1명/); assert.doesNotMatch(deck, /연결 1쌍/, 'B 회사 숫자가 아니다');
  const routines = await spec('argo_status').run({ section: 'routines', wsId: b });
  assert.doesNotMatch(routines, /B 루틴/);
  assert.match(await spec('argo_settings').run({ action: 'set', key: 'routine.time', id: rb.id, value: '11:00', wsId: b }), /그런 루틴이 없다/);
  assert.equal((await loadRoutines(b))[0].schedule.time, '10:00', 'B 회사 루틴은 그대로');
});

/* ── ⑫ 비주인 문맥으로 나가는 값 전수(커밋 보안 검토 2026-10-09) ───────────────── */
test('비주인 문맥 — 채널·다른 사람·게스트·루틴·위임에서 나가는 모든 도구 결과·결재 카드·후속 보고에 경로·이메일·계정 id·토큰·다른 회사·오류 원문이 없다', async () => {
  const ca = await company('as-leak-a', { owner: 'u-leak' });
  const cb = await company('as-leak-b', { owner: 'u-leak', agents: [['pepper', '페퍼', '비서'], ['mina', '미나', '리서처']] });
  const leakRid = (await addRoutine(cb, { agentSlug: 'mina', title: '사내 보고', prompt: 'p', schedule: { type: 'daily', time: '09:00', tz: 'Asia/Seoul' } })).id;
  const banned = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '이메일'], [new RegExp(process.env.ARGO_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '데이터 경로'],
    [/\/Users\/|\/private\/|[A-Z]:\\/, '파일 경로'], [/u-leak|u-owner/, '계정 id'], [/sk-ant|eyJ[\w-]{10,}/, '토큰 꼴'], [/as-leak-a/, '다른 회사'],
    [/사내 보고|09:00|08:00|21:00|23:00/, '주인의 지금 값·루틴'], [/ENOENT|EACCES|Error:/, '오류 원문'],
  ];
  const sweep = (label, text) => { for (const [re, what] of banned) assert.doesNotMatch(String(text), re, `${label}: ${what}`); };
  const cells = [['채널', { ctx: msgrCtx(cb, { uid: 'u-leak', origin: 'u-leak' }) }], ['다른 사람', { ctx: msgrCtx(cb, { uid: 'u-leak', origin: 'u-other' }) }],
    ['게스트', { ctx: msgrCtx(cb, { uid: 'u-leak', origin: 'u-leak', guest: true }) }], ['루틴', { origin: 'mina' }], ['위임', { chain: ['mina'] }]];
  for (const [label, o] of cells) {
    const h = handlers(cb, o);
    for (const section of ['overview', 'deck', 'agents', 'me', 'routines', 'goals', 'runners', 'sync', 'plan', 'messenger', 'approvals']) sweep(`${label} status ${section}`, await h.call('argo_status', { section }));
    sweep(`${label} list`, await h.call('argo_settings', { action: 'list' }));
    const why = '/Users/someone/secret.txt 참고 sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz';
    for (const args of [{ key: 'theme', value: 'x' }, { key: 'company.fullAuto', value: 'true' }, { key: 'routine.time', id: 'rnope', value: '10:00' }, { key: 'routine.time', id: leakRid, value: '01:00', why }, { key: 'company.lang', value: 'en', why }]) {
      const out = await h.call('argo_settings', { action: 'set', ...args });
      sweep(`${label} set ${args.key}`, out.replace('/Users/someone/secret.txt', '')); // 에이전트가 쓴 사유 원문은 결과 문구에 다시 싣지 않는다 — 아래 카드에서 본다
      assert.doesNotMatch(out, /secret\.txt/, `${label}: 사유를 결과에 되풀이하지 않는다`);
    }
  }
  const cards = await pendingSettings(cb);
  assert.ok(cards.length >= 5, '범위 밖 시각 변경은 카드로');
  for (const c of cards) { sweep(`카드 ${c.id}`, `${c.action}\n${c.payload.key}${c.payload.value}`); assert.doesNotMatch(c.reason, /sk-ant-api03-z/, '사유의 키 꼴 가림'); }
  // 후속 보고(결재를 올린 방으로 간다) — 화면 규칙 위반 실패와 없는 루틴 실패 모두 원문·경로 없이
  let seen = []; const runChat = async (_w, _s, msg) => { seen.push(msg); return { reply: 'ok', sessionId: null }; };
  for (const c of cards.filter((x) => !x.msgr).slice(0, 4)) await _followUpForTest(cb, await resolveApproval(cb, c.id, true), true, { runChat });
  assert.ok(seen.length >= 2);
  // 읽기 오류(손상된 루틴 파일 — 오류 원문에 파일 경로가 섞인다)도 후속 보고에 원문이 나가지 않는다
  const rid = (await loadRoutines(cb))[0].id;
  await handlers(cb, { origin: 'mina' }).call('argo_settings', { action: 'set', key: 'routine.time', id: rid, value: '10:30' });
  const routineCard = (await pendingSettings(cb)).find((c) => c.payload.key === 'routine.time' && c.payload.id === rid);
  await writeFile(paths(cb).routines, '{ 깨진 json');
  await _followUpForTest(cb, await resolveApproval(cb, routineCard.id, true), true, { runChat });
  assert.match(seen.at(-1), /적용 실패 — 루틴 실행 시각[^]*바꾸지 못했다/);
  for (const m of seen) sweep('후속 보고', m);
});
