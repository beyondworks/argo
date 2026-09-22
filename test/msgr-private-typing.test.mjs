// 브리지 typing·progress의 방 토픽(20260918190000) — 공개 채널은 조직 토픽, 비공개 방(DM·비공개 채널)은 그 방의 채널 토픽 dm:<채널>.
// 조직 토픽은 조직 전원이 들어, 비공개 방의 typing(channel_id·crew_id)이 방의 존재와 크루 활동을 흘렸다. 실제 startTyping을 가짜 realtime 클라이언트로 돌린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-private-typing-')); // 격리 루트
const { _startTypingForTest: startTyping, _rtChannelsForTest: rt } = await import('../src/gateway/msgr.mjs');

function fakeClient() {
  const sent = []; const removed = []; const opened = [];
  const mk = (topic) => ({ topic, subscribe() {}, unsubscribe() { removed.push(topic); }, send(m) { sent.push({ topic, ...m }); return Promise.resolve('ok'); } });
  const client = { channel: (topic) => { opened.push(topic); return mk(topic); }, removeChannel: async (c) => { removed.push(c.topic); return 'ok'; } };
  const org = mk('org:O'); org.__client = client;
  return { client, org, sent, removed, opened };
}

test('비공개 방: typing은 dm:<채널>로만 — 조직 토픽으로는 한 건도 나가지 않고, 멈추면 그 채널을 해제한다', () => {
  const f = fakeClient(); rt.set('ws:O', f.org);
  const stop = startTyping('ws', 'O', 'C-priv', 'crew-1', null, { full: false });
  stop();
  assert.deepEqual(f.opened, ['dm:C-priv']);
  assert.ok(f.sent.length >= 1 && f.sent.every((m) => m.topic === 'dm:C-priv' && m.event === 'typing'), JSON.stringify(f.sent));
  assert.deepEqual(f.sent[0].payload, { channel_id: 'C-priv', crew_id: 'crew-1' });
  assert.deepEqual(f.removed, ['dm:C-priv'], '멈추면 방 채널을 걷는다');
  rt.delete('ws:O');
});

test('공개 채널: 지금처럼 조직 토픽 — 방 채널을 열지 않는다', () => {
  const f = fakeClient(); rt.set('ws:O', f.org);
  const stop = startTyping('ws', 'O', 'C-pub', 'crew-1', null, { full: true });
  stop();
  assert.deepEqual(f.opened, [], '방 채널을 열지 않는다');
  assert.ok(f.sent.length >= 1 && f.sent.every((m) => m.topic === 'org:O'));
  rt.delete('ws:O');
});

test('비공개 방인데 방 채널을 못 열면 보내지 않는다(조직 토픽으로 되돌아가지 않음 — 누출보다 표시 누락)', () => {
  const f = fakeClient(); f.org.__client = { channel: () => { throw new Error('no realtime'); } }; rt.set('ws:O', f.org);
  const stop = startTyping('ws', 'O', 'C-priv', 'crew-1', null, { full: false });
  stop();
  assert.equal(f.sent.length, 0);
  rt.delete('ws:O');
});

test('App.jsx 배선: 열린 방이 개인 방이거나 조직의 비공개 방(공개 채널 아님)이면 dm:<채널>을 구독해 typing·progress를 받는다', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/messenger/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const roomTopic = !!chId && \(isPersonal \|\| \(openKind !== null && openKind !== 'public'\)\);/, '조직 비공개 방도 대상(공개 채널만 제외)');
  const eff = app.slice(app.indexOf('const roomTopic ='), app.indexOf('const roomTopic =') + 2600);
  assert.match(eff, /if \(!roomTopic\) return;/);
  assert.match(eff, /supabase\.channel\(`dm:\$\{chId\}`, \{ config: \{ private: true \} \}\)/);
  assert.match(eff, /event: 'typing' \}, onTypingEvent\)/, 'dm:의 typing도 답글 직후 늦은 방송 거름망(typing-state.js)을 탄다');
  assert.match(eff, /event: 'progress' \}, onProgressEvent\)/);
  assert.match(eff, /\}, \[roomTopic, isPersonal, chId, session\.access_token\]\);/, '방을 옮기면 다시 구독');
  assert.match(eff, /await supabase\.realtime\.setAuth\(session\.access_token\);\s*if \(!live\) return;\s*ch = supabase\.channel\(`dm:/, '정리가 먼저 끝났으면 채널을 만들지 않는다(고아 dm: 누적 — 검수 #607)');
  assert.match(eff, /return \(\) => \{ live = false;/, '정리에서 live를 끈다');
  assert.match(eff, /event: 'reaction' \}, \(\{ payload \}\) => setEvent\(broadcastEvent\('reaction'/, 'dm:로 반응을 받는다');
  assert.match(eff, /event: 'edit' \}, \(\{ payload \}\) => setEvent\(broadcastEvent\('edit'/, 'dm:로 수정을 받는다');
  assert.match(app, /broadcast=\{\(ev, payload\) => \(roomTopic \? roomRt\.current : rt\.current\)\?\.send\(/, '비공개 방의 반응·수정 송신은 dm:로만(org: 폴백 없음)');
});
