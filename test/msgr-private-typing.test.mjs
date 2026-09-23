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

test('App.jsx 배선: 개인 공간의 방과 조직의 비공개 방(공개 채널 아님)은 dm:<채널>을 구독해 typing·progress를 받는다 — 열린 방만이 아니라 전부(목록의 답변 중, 2026-09-23)', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/messenger/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const roomTopic = !!chId && \(isPersonal \|\| \(openKind !== null && openKind !== 'public'\)\);/, '조직 비공개 방도 대상(공개 채널만 제외)');
  const eff = app.slice(app.indexOf('const lastAtRank ='), app.indexOf('const lastAtRank =') + 3200); // 구독 효과는 lastAt 선언 뒤(최근순 상한 — 검수 #690 M1)
  assert.match(eff, /const roomIdsKey = useMemo\(\(\) => roomTopicIds\(channels, chId, isPersonal, 50, lastAt\)\.join\(','\)/, '구독할 방 = roomTopicIds(열린 방 포함, 상한 50·최근순 — room-topics.test.mjs)');
  assert.match(eff, /for \(const \[id, c\] of subs\) if \(!want\.has\(id\) \|\| c\.state === 'closed' \|\| supabase\.getChannels\?\.\(\)\.includes\(c\) === false\) \{ supabase\.removeChannel\(c\)/, '빠진 방·밖에서 닫힌 방만 뗀다(차분 — 검수 #690 M1, 재검 MEDIUM)');
  assert.match(eff, /if \(subs\.has\(id\)\) continue;/, '이미 붙은 방은 다시 붙이지 않는다');
  assert.match(eff, /supabase\.channel\(`dm:\$\{id\}`, \{ config: \{ private: true \} \}\)/);
  assert.match(eff, /event: 'typing' \}, onTypingEvent\)/, 'dm:의 typing도 답글 직후 늦은 방송 거름망(typing-state.js)을 탄다');
  assert.match(eff, /event: 'progress' \}, onProgressEvent\)/);
  assert.match(eff, /\}, \[roomIdsKey, isPersonal, resumeEpoch, roomReset\]\);/, '방 집합·모바일 복귀·removeAllChannels 뒤에 다시 맞춘다 — 토큰은 조직 구독의 setAuth가 전달(검수 #690 M2)');
  assert.match(eff, /await supabase\.realtime\.setAuth\(session\.access_token\);\s*if \(!live\) return;/, '정리가 먼저 끝났으면 채널을 만들지 않는다(고아 dm: 누적 — 검수 #607)');
  assert.match(eff, /if \(roomEpoch\.current !== resumeEpoch\) \{ for \(const c of subs\.values\(\)\) supabase\.removeChannel\(c\)/, '복귀하면 전부 다시 붙인다');
  assert.match(eff, /return \(\) => \{ live = false;/, '정리에서 live를 끈다');
  assert.match(app, /if \(await supabase\.removeChannel\(ch\) !== 'ok'\) \{ await supabase\.removeAllChannels\(\); setRoomReset\(\(x\) => x \+ 1\); \}/, '조직 구독 해제가 실패해 전부 뗐으면 방 구독도 다시 붙인다(검수 #690 재검 MEDIUM)');
  assert.match(eff, /event: 'reaction' \}, \(\{ payload \}\) => setEvent\(broadcastEvent\('reaction'/, 'dm:로 반응을 받는다');
  assert.match(eff, /event: 'edit' \}, \(\{ payload \}\) => setEvent\(broadcastEvent\('edit'/, 'dm:로 수정을 받는다');
  assert.match(app, /broadcast=\{\(ev, payload\) => \(roomTopic \? roomSubs\.current\.get\(chId\) : rt\.current\)\?\.send\(/, '비공개 방의 반응·수정 송신은 dm:로만(org: 폴백 없음)');
});
