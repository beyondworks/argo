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

// 사람 탭(2026-10-20): 팀 공간 2개·채널·사람 1:1·받은 초대·멤버·첨부·옛 메신저에서 옮겨 온 채널. 그림 첨부는 네트워크 없는 data: 주소.
const IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#d9d4cc"/><rect x="32" y="36" width="250" height="26" rx="6" fill="#7a746b"/><rect x="32" y="78" width="180" height="14" rx="5" fill="#a39d93"/><rect x="32" y="196" width="120" height="40" rx="12" fill="#2b2925"/><rect x="300" y="36" width="148" height="200" rx="14" fill="#efebe5"/></svg>');
const PEOPLE = { 'u-hyowon': ['김효원', 'Hyowon Kim'], 'u-jimin': ['박지민', 'Jimin Park'], 'u-seoyeon': ['이서연', 'Seoyeon Lee'], 'u-doyun': ['최도윤', 'Doyun Choi'], 'u-free': ['정무료', 'Free Jung'] };

/** scenario: pro-many(기본) | pro-one | pro-none | free | unknown | offline | meeting-running | closed
 *  | people-none(팀 공간 0) | people-pro-lapsed(서버 msgr2_pro_required) | invite-free(초대 수락을 서버가 Pro 아님으로 거부). lang: 가짜 글 언어. */
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
      { id: 2, author: 'ag-research', body: say('세 곳을 비교했습니다. 월 요금은 A사 29,000원, B사 35,000원, C사 19,000원이고 C사는 연간 결제만 받습니다. 표로 정리한 파일을 붙였습니다.', 'I compared three. Monthly: A $29, B $35, C $19 (annual billing only). The table is attached.'), at: min(40),
        files: [{ id: 'f-price', name: say('경쟁사-가격표.xlsx', 'competitor-pricing.xlsx'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 48_213, storage_path: 'msgr/fake/price.xlsx' }] },
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
  // ── 사람 탭 ──
  const pname = (id) => (PEOPLE[id] ? PEOPLE[id][en ? 1 : 0] : '?');
  const people = new Map(); // spaceId → { rooms, members, people }
  const spaces = scenario === 'people-none' ? [] : [
    { id: 'sp-beyond', kind: 'team', name: say('비욘드웍스', 'Beyondworks'), role: 'owner', personal: false },
    { id: 'sp-study', kind: 'team', name: say('디자인 스터디', 'Design study'), role: 'member', personal: false },
  ];
  const userMsg = (id, author, ko, e, ago, extra = {}) => ({ id, author, body: say(ko, e), at: min(ago), ...extra });
  if (spaces.length) {
    const roomsB = [
      { id: 'ch-general', space_id: 'sp-beyond', kind: 'open', name: say('일반', 'general'), legacy: true, created_at: new Date(min(60 * 24 * 40)).toISOString() },
      { id: 'ch-launch', space_id: 'sp-beyond', kind: 'open', name: say('출시-준비', 'launch-prep'), created_at: new Date(min(60 * 24 * 3)).toISOString() },
      { id: 'ch-ops', space_id: 'sp-beyond', kind: 'private', name: say('운영', 'ops'), created_at: new Date(min(60 * 24 * 9)).toISOString() },
      { id: 'ch-notice-old', space_id: 'sp-beyond', kind: 'open', name: say('옛 공지', 'old-notices'), legacy: true, read_only: true, created_at: new Date(min(60 * 24 * 200)).toISOString() },
      { id: 'dm-hyowon', space_id: 'sp-beyond', kind: 'direct', name: null, created_at: new Date(min(60 * 24)).toISOString() },
      { id: 'dm-jimin', space_id: 'sp-beyond', kind: 'direct', name: null, legacy: true, created_at: new Date(min(60 * 24 * 50)).toISOString() },
    ];
    const everyone = ['me', 'u-hyowon', 'u-jimin', 'u-seoyeon'];
    const mem = (room, users) => users.map((u) => ({ room_id: room, member_kind: 'user', member_id: u === 'me' ? UID : u }));
    const membersB = [...mem('ch-general', everyone), ...mem('ch-launch', ['me', 'u-hyowon', 'u-jimin']), ...mem('ch-ops', ['me', 'u-hyowon']), ...mem('ch-notice-old', everyone), ...mem('dm-hyowon', ['me', 'u-hyowon']), ...mem('dm-jimin', ['me', 'u-jimin']),
      { room_id: 'ch-launch', member_kind: 'agent', member_id: 'ag-research' }];
    people.set('sp-beyond', { rooms: roomsB, members: membersB, people: [
      { user_id: UID, name: say('유건', 'Yugeon'), role: 'owner' }, { user_id: 'u-hyowon', name: pname('u-hyowon'), role: 'admin' },
      { user_id: 'u-jimin', name: pname('u-jimin'), role: 'member' }, { user_id: 'u-seoyeon', name: pname('u-seoyeon'), role: 'guest', expires_at: new Date(now + 86400000 * 20).toISOString() },
      { user_id: 'u-gone', name: '탈퇴', role: 'member', removed_at: new Date(min(100)).toISOString() },
    ], agents: agents.filter((a) => a.id === 'ag-research') });
    people.set('sp-study', { rooms: [{ id: 'ch-study', space_id: 'sp-study', kind: 'open', name: say('스터디', 'study'), created_at: new Date(min(60 * 24 * 20)).toISOString() }],
      members: mem('ch-study', ['me', 'u-doyun']), people: [{ user_id: UID, name: say('유건', 'Yugeon'), role: 'member' }, { user_id: 'u-doyun', name: pname('u-doyun'), role: 'owner' }], agents: [] });
    const legacyMeta = { legacy_author: 'user' };
    rooms.set('ch-general', { kind: 'channel', messages: [
      userMsg(30, 'u-hyowon', '이번 주 금요일에 전체 회의 있습니다. 안건은 이 채널에 남겨 주세요.', 'All-hands this Friday. Please leave agenda items in this channel.', 60 * 24 * 40, { legacy: true, meta: legacyMeta }),
      userMsg(31, 'u-jimin', '지난 분기 정리본 공유합니다.', 'Sharing last quarter’s wrap-up.', 60 * 24 * 39, { legacy: true, meta: legacyMeta, files: [{ id: 'f-q3', name: say('3분기-정리.pdf', 'q3-wrapup.pdf'), mime: 'application/pdf', bytes: 1_284_000, storage_path: 'msgr/fake/q3.pdf' }] }),
      userMsg(32, 'me', '새 메신저로 옮겼습니다. 앞으로는 여기서 이어 가요.', 'We moved to the new messenger. Let’s continue here.', 30),
    ] });
    rooms.set('ch-launch', { kind: 'channel', messages: [
      userMsg(40, 'u-hyowon', '랜딩 시안 두 개 올립니다. 어느 쪽이 나은지 의견 주세요.', 'Two landing mockups. Which one works better?', 50, { files: [{ id: 'f-land', name: 'landing-v2.png', mime: 'image/png', bytes: 312_400, storage_path: 'msgr/fake/landing.png', url: IMG }, { id: 'f-check', name: say('출시-체크리스트.pdf', 'launch-checklist.pdf'), mime: 'application/pdf', bytes: 240_120, storage_path: 'msgr/fake/check.pdf' }] }),
      userMsg(41, 'u-jimin', '두 번째 안이 더 깔끔해요. @리서치 경쟁사 첫 화면도 같이 봐 줄래요?', 'The second one is cleaner. @Research can you check competitors’ first screens too?', 45),
      { id: 42, author: 'ag-research', body: say('세 곳 모두 첫 화면에 가격과 무료 시작 단추가 있습니다. 캡처를 붙였습니다.', 'All three show price and a free-start button on the first screen. Captures attached.'), at: min(44), files: [{ id: 'f-cap', name: say('경쟁사-첫화면.zip', 'competitor-screens.zip'), mime: 'application/zip', bytes: 5_820_000, storage_path: 'msgr/fake/caps.zip' }] },
    ] });
    rooms.set('ch-ops', { kind: 'channel', messages: [userMsg(50, 'u-hyowon', '서버 점검은 일요일 새벽 2시입니다.', 'Server maintenance is Sunday 2 a.m.', 600)] });
    rooms.set('ch-notice-old', { kind: 'channel', messages: [userMsg(60, 'u-hyowon', '옛 메신저 공지 채널입니다. 새 공지는 #일반에 올려 주세요.', 'Old notice channel. Post new notices in #general.', 60 * 24 * 200, { legacy: true, meta: legacyMeta })] });
    rooms.set('dm-hyowon', { kind: 'pdm', messages: [userMsg(70, 'u-hyowon', '내일 오전에 잠깐 통화 가능할까요?', 'Can we talk briefly tomorrow morning?', 25)] });
    rooms.set('dm-jimin', { kind: 'pdm', messages: [userMsg(80, 'u-jimin', '견적서 받았습니다. 감사합니다!', 'Got the quote. Thanks!', 60 * 24 * 50, { legacy: true, meta: legacyMeta })] });
    rooms.set('ch-study', { kind: 'channel', messages: [userMsg(90, 'u-doyun', '다음 주제는 타이포그래피입니다.', 'Next topic: typography.', 300)] });
    unread.set('ch-launch', 2); unread.set('dm-hyowon', 1);
  }
  const invites = spaces.length ? [{ id: 'inv-mkt', code: 'a'.repeat(48), spaceId: 'sp-mkt', spaceName: say('마케팅 팀', 'Marketing team'), role: 'member', inviterId: 'u-doyun', inviterName: pname('u-doyun'), at: new Date(min(90)).toISOString(), expiresAt: new Date(now + 86400000 * 5).toISOString() }] : [];
  const lastOf = (id) => rooms.get(id)?.messages.at(-1);
  const peopleBlock = () => {
    if (scenario === 'closed') throw Object.assign(new Error('msgr2_lite_only'), { code: '42501' });
    if (scenario === 'people-pro-lapsed') throw Object.assign(new Error('msgr2_pro_required'), { code: '42501' });
  };
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
    sent: [],
    async send(roomId, body, files = []) {
      calls.push('send');
      const r = rooms.get(roomId); if (!r) return { ok: false };
      src.sent.push({ roomId, body, files: files.map((f) => f.name), meta: files.length ? { attach_count: files.length } : null });
      const m = { id: ++seq, author: 'me', body, at: Date.now(), files: files.map((f, i) => ({ id: `up-${seq}-${i}`, name: f.name, mime: f.mime, bytes: f.bytes, url: f.mime?.startsWith('image/') ? IMG : null })) };
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
    // ── 사람 탭 ──
    async spaces() { calls.push('spaces'); peopleBlock(); return later(spaces.map((x) => ({ ...x }))); },
    async space(id) {
      calls.push('space'); peopleBlock();
      const sp = people.get(id) ?? { rooms: [], members: [], people: [], agents: [] };
      return later({ ...sp, rooms: sp.rooms.map((r) => ({ ...r, last: lastOf(r.id)?.body ?? '', last_at: lastOf(r.id) ? new Date(lastOf(r.id).at).toISOString() : r.created_at, unread: unread.get(r.id) ?? 0 })) });
    },
    async createSpace(name) { calls.push('createSpace'); const id = `sp-${++seq}`; spaces.push({ id, kind: 'team', name, role: 'owner', personal: false }); people.set(id, { rooms: [], members: [], people: [{ user_id: UID, name: say('유건', 'Yugeon'), role: 'owner' }], agents: [] }); return later(id); },
    async createChannel(spaceId, name, priv = false) { calls.push('createChannel'); const id = `ch-${++seq}`; const sp = people.get(spaceId); sp.rooms.push({ id, space_id: spaceId, kind: priv ? 'private' : 'open', name, created_at: new Date().toISOString() }); sp.members.push({ room_id: id, member_kind: 'user', member_id: UID }); rooms.set(id, { kind: 'channel', messages: [] }); return later(id); },
    async openUserDm(userId, spaceId) {
      calls.push('openUserDm');
      if (userId === 'u-free') throw Object.assign(new Error('msgr2_member_not_pro'), { code: '42501' }); // 무료인 상대를 바로 넣는 경로
      const sp = people.get(spaceId); const have = sp?.rooms.find((r) => r.kind === 'direct' && sp.members.some((m) => m.room_id === r.id && m.member_id === userId));
      if (have) return have.id;
      const id = `dm-${++seq}`; sp.rooms.push({ id, space_id: spaceId, kind: 'direct', name: null, created_at: new Date().toISOString() }); sp.members.push({ room_id: id, member_kind: 'user', member_id: UID }, { room_id: id, member_kind: 'user', member_id: userId }); rooms.set(id, { kind: 'pdm', messages: [] });
      return later(id);
    },
    async createInvite(spaceId, { userId = null } = {}) {
      calls.push('createInvite');
      return later({ code: 'b'.repeat(48), expires_at: new Date(now + 7 * 86400000).toISOString() });
    },
    async contacts(spaceId) { calls.push('contacts'); return later(spaceId === 'sp-beyond' ? [{ id: 'u-doyun', name: pname('u-doyun') }, { id: 'u-free', name: pname('u-free') }] : [{ id: 'u-hyowon', name: pname('u-hyowon') }]); },
    async myInvites() { calls.push('myInvites'); return later(scenario === 'closed' || scenario === 'people-pro-lapsed' ? [] : invites.map((v) => ({ ...v }))); },
    async previewInvite(code) { calls.push('previewInvite'); const v = invites.find((x) => x.code === code); if (!v) throw Object.assign(new Error('msgr2_invite_not_found'), { code: '22023' }); return later({ state: 'valid', space_id: v.spaceId, space_name: v.spaceName, role: v.role, inviter_name: v.inviterName, expires_at: v.expiresAt, already_member: false, rooms: [{ id: 'x', name: say('일반', 'general') }] }); },
    async acceptInvite(code) {
      calls.push('acceptInvite');
      if (scenario === 'invite-free') throw Object.assign(new Error('msgr2_pro_required'), { code: '42501' });
      const i = invites.findIndex((x) => x.code === code); if (i < 0) throw Object.assign(new Error('msgr2_invite_not_found'), { code: '22023' });
      const [v] = invites.splice(i, 1); spaces.push({ id: v.spaceId, kind: 'team', name: v.spaceName, role: 'member', personal: false });
      people.set(v.spaceId, { rooms: [], members: [], people: [{ user_id: UID, name: say('유건', 'Yugeon'), role: 'member' }, { user_id: v.inviterId, name: v.inviterName, role: 'owner' }], agents: [] });
      emit('people', { event: 'spaces', payload: { space_id: v.spaceId } });
      return later({ space_id: v.spaceId });
    },
    async declineInvite(code) { calls.push('declineInvite'); const i = invites.findIndex((x) => x.code === code); if (i >= 0) invites.splice(i, 1); return later(i >= 0 ? 'declined' : 'gone'); },
    reads: [],
    /** 시험 보조: 그 방에 남의 글 n개가 한꺼번에 온다(실시간 사건 흉내, 요청 0). */
    push(roomId, n = 1, author = 'u-hyowon') { const r = rooms.get(roomId); const ms = Array.from({ length: n }, (_, i) => ({ id: ++seq, author, body: `#${i + 1}`, at: Date.now() })); r?.messages.push(...ms); emit('messages', { roomId, messages: ms }); return ms.length; },
    async markRead(roomId, lastId) { calls.push('markRead'); src.reads.push([roomId, lastId]); },
    async fileUrl(path) { calls.push('fileUrl'); return later(path ? `#file:${path}` : null); },
    async bots() { calls.push('bots'); if (scenario === 'closed') throw notReady(); return later(agents.filter((a) => a.hosting === 'bot' && a.status !== 'retired').map((a) => ({ id: a.id, name: a.display_name, kind: a.botKind, status: a.botStatus }))); },
  };
  return src;
}
