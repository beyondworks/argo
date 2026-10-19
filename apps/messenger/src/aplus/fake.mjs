// A+ 화면용 가짜 원본 — 서버 RPC·약속 v1.1이 확정되기 전 화면 골격과 상태별 캡처에 쓴다(test/aplus.fixture.html). 네트워크를 쓰지 않는다.
// 실제 원본(source.mjs)과 같은 모양: plan·agents·dms·openDm·messages·send·meetings·createMeeting·cancelMeeting·bots·on.
// 외부 봇은 내 에이전트 중 hosting 'bot'(약속 v1.1) — 봇 추가는 앱이 아니라 내 PC Argo 설정에서 한다.
// calls에 부른 이름을 남긴다 — 무료 계정이 plan 말고는 아무것도 부르지 않는지 시험이 본다.

const UID = 'me-0000';
const AG = [
  { id: 'ag-research', owner_user_id: UID, display_name: '리서치', slug: 'research', role_text: '자료 조사·요약', status: 'active' },
  { id: 'ag-writer', owner_user_id: UID, display_name: '라이터', slug: 'writer', role_text: '글쓰기·교정', status: 'active' },
  { id: 'ag-design', owner_user_id: UID, display_name: '디자이너', slug: 'design', role_text: '화면 시안', status: 'active' },
  { id: 'ag-ops', owner_user_id: UID, display_name: '운영 매니저', slug: 'ops', role_text: '일정·정리', status: 'active' },
  { id: 'ag-data', owner_user_id: UID, display_name: '데이터 분석가', slug: 'data', role_text: '숫자 확인', status: 'active' },
  { id: 'ag-sales', owner_user_id: UID, display_name: '영업 도우미', slug: 'sales', role_text: '견적·회신 초안', status: 'active' },
  { id: 'ag-legal', owner_user_id: UID, display_name: '법무 검토', slug: 'legal', role_text: '계약서 확인', status: 'paused' },
  { id: 'ag-old', owner_user_id: UID, display_name: '은퇴한 봇', slug: 'old', role_text: '', status: 'retired' },
  { id: 'bot-hermes', owner_user_id: UID, display_name: '헤르메스 (내 맥)', slug: 'hermes', role_text: '외부 봇', status: 'active', hosting: 'bot', botKind: 'hermes', botStatus: 'connected' },
  { id: 'bot-claw', owner_user_id: UID, display_name: '오픈클로 (집 PC)', slug: 'openclaw', role_text: '외부 봇', status: 'active', hosting: 'bot', botKind: 'openclaw', botStatus: 'off' },
];
const AG_EN = { 'ag-research': ['Research', 'Find and summarize'], 'ag-writer': ['Writer', 'Drafts and edits'], 'ag-design': ['Designer', 'Screen mockups'], 'ag-ops': ['Ops manager', 'Schedules and tidy-up'], 'ag-data': ['Data analyst', 'Checks the numbers'], 'ag-sales': ['Sales helper', 'Quotes and replies'], 'ag-legal': ['Legal review', 'Contract checks'], 'ag-old': ['Retired bot', ''], 'bot-hermes': ['Hermes (my Mac)', 'External bot'], 'bot-claw': ['OpenClaw (home PC)', 'External bot'] };

/** scenario: pro-many(기본) | pro-one | pro-none | free | unknown | offline | meeting-running | closed. lang: 가짜 글 언어. */
export function createFakeSource({ scenario = 'pro-many', lang = 'ko', now = Date.now() } = {}) {
  const en = lang === 'en';
  const calls = [];
  const listeners = new Map();
  const emit = (type, payload) => { for (const fn of listeners.get(type) ?? []) fn(payload); };
  const min = (n) => now - n * 60_000;
  const agents = (scenario === 'pro-none' ? [] : scenario === 'pro-one' ? AG.slice(0, 1) : AG)
    .map((a) => (en ? { ...a, display_name: AG_EN[a.id][0], role_text: AG_EN[a.id][1] } : a));
  const say = (ko, e) => (en ? e : ko);
  const rooms = new Map(); // roomId → { kind, agentIds, title, messages, run }
  const dm = (agentId, msgs) => { const id = `dm-${agentId}`; rooms.set(id, { kind: 'dm', agentIds: [agentId], messages: msgs, run: null }); return id; };
  if (agents.length) {
    dm('ag-research', [
      { id: 1, author: 'me', body: say('다음 주 경쟁사 가격표 정리해 줘', 'Summarize competitor pricing for next week'), at: min(42) },
      { id: 2, author: 'ag-research', body: say('세 곳을 비교했습니다. 월 요금은 A사 29,000원, B사 35,000원, C사 19,000원이고 C사는 연간 결제만 받습니다. 표로 정리한 파일을 폴더에 넣어 두었습니다.', 'I compared three. Monthly: A $29, B $35, C $19 (annual billing only). The table is saved in the folder.'), at: min(40) },
    ]);
    if (agents.some((a) => a.id === 'bot-claw')) dm('bot-claw', [
      { id: 4, author: 'me', body: say('오늘 서버 로그 요약해 줘', 'Summarize today\u2019s server logs'), at: min(30) },
      { id: 5, author: 'system', kind: 'note', errKey: 'aplus.err.bot_unreachable', at: min(29) },
      { id: 6, author: 'system', kind: 'system', meta: { code: 'work.limit', limit: 'bot_turns' }, at: min(28) },
    ]);
    if (agents.length > 1) dm('ag-writer', [{ id: 3, author: 'ag-writer', body: say('소개 문단 초안을 고쳤습니다. 확인해 주세요.', 'I revised the intro paragraph. Please take a look.'), at: min(180) }]);
  }
  const unread = new Map([['dm-ag-writer', 1]]);
  const meetings = [];
  if (agents.length > 2 && scenario !== 'closed') {
    const id = 'mt-launch';
    const run = scenario === 'meeting-running' ? { state: 'running', round: 1, answered: 2, total: 3 } : { state: 'done', round: 2, answered: 3, total: 3 };
    rooms.set(id, { kind: 'meeting', title: say('출시 준비 회의', 'Launch prep meeting'), agentIds: ['ag-research', 'ag-writer', 'ag-design'], run, messages: [
      { id: 10, author: 'me', body: say('랜딩 페이지 문구를 어떻게 바꿀지 의견 주세요', 'Give me your takes on the landing page copy'), at: min(12) },
      { id: 11, author: 'ag-research', body: say('경쟁사 세 곳 모두 첫 줄에 가격을 둡니다. 우리도 첫 화면에 무료 시작을 보이는 편이 낫습니다.', 'All three competitors lead with price. We should show "start free" on the first screen.'), at: min(11), round: 1 },
      { id: 12, author: 'ag-writer', body: say('첫 줄은 "프롬프트 한 줄로 AI 직원 회사"로 하고, 둘째 줄에 무료 시작을 두는 안을 제안합니다.', 'Lead with "an AI staff company from one prompt", with "start free" on the second line.'), at: min(10), round: 1 },
      ...(run.state === 'done' ? [{ id: 13, author: 'ag-design', body: say('두 안을 합친 시안을 폴더에 올렸습니다. 추가 의견 없습니다.', 'I uploaded a mockup combining both. No further comments.'), at: min(8), round: 2 }] : []),
    ] });
    meetings.push(id);
  }
  let seq = 100;
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 30));
  const notReady = () => Object.assign(new Error('aplus_not_ready'), { code: 'aplus_not_ready' });
  const src = {
    calls, uid: UID,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn); },
    online: () => scenario !== 'offline',
    async plan() { calls.push('plan'); return later(scenario === 'free' ? 'free' : scenario === 'unknown' ? null : 'pro'); },
    async start() { calls.push('start'); },
    stop() { calls.push('stop'); },
    async agents() { calls.push('agents'); return later(agents); },
    async dms() {
      calls.push('dms');
      const out = {};
      for (const [id, r] of rooms) if (r.kind === 'dm') { const last = r.messages.at(-1); out[r.agentIds[0]] = { roomId: id, at: last?.at ?? 0, last: last?.body ?? '', unread: unread.get(id) ?? 0 }; }
      return later(out);
    },
    async openDm(agentId) { calls.push('openDm'); return rooms.has(`dm-${agentId}`) ? `dm-${agentId}` : dm(agentId, []); },
    async messages(roomId) { calls.push('messages'); unread.delete(roomId); return later([...(rooms.get(roomId)?.messages ?? [])]); },
    async send(roomId, body) {
      calls.push('send');
      const r = rooms.get(roomId); if (!r) return { ok: false };
      const m = { id: ++seq, author: 'me', body, at: Date.now() };
      r.messages.push(m); emit('messages', { roomId, messages: [m] });
      if (r.kind === 'meeting') { r.run = { state: 'running', round: 1, answered: 0, total: r.agentIds.length }; emit('meeting', { roomId, run: r.run }); }
      return { ok: true };
    },
    async meetings() {
      calls.push('meetings');
      if (scenario === 'closed') throw notReady();
      return later(meetings.map((id) => { const r = rooms.get(id); return { roomId: id, title: r.title, agentIds: r.agentIds, run: r.run, at: r.messages.at(-1)?.at ?? 0 }; }));
    },
    async createMeeting({ title, agentIds }) {
      calls.push('createMeeting');
      if (agentIds.length > 5) throw Object.assign(new Error('msgr2_meeting_full'), { code: '22023' });
      const id = `mt-${++seq}`; rooms.set(id, { kind: 'meeting', title, agentIds, run: null, messages: [] }); meetings.unshift(id);
      return id;
    },
    async cancelMeeting(roomId) {
      calls.push('cancelMeeting');
      const r = rooms.get(roomId); if (!r?.run) return;
      r.run = { ...r.run, state: 'cancelling' }; emit('meeting', { roomId, run: r.run });
      await later(); r.run = { ...r.run, state: 'cancelled' }; emit('meeting', { roomId, run: r.run });
    },
    async bots() { calls.push('bots'); if (scenario === 'closed') throw notReady(); return later(agents.filter((a) => a.hosting === 'bot' && a.status !== 'retired').map((a) => ({ id: a.id, name: a.display_name, kind: a.botKind, status: a.botStatus }))); },
  };
  return src;
}
