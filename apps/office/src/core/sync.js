// 보낼 목록을 앱에 연결한다 — 브라우저 IndexedDB에 목록을 두고, 입력이 멈추면(0.8초·최대 5초) 보낸다.
// 전송: 서버 연결 전에는 "이 기기에 받아 두기"(아무 데도 보내지 않고 성공). 서버 연결 단계에서 이 함수만 Supabase 전송으로 바꾼다.
import { get, set } from 'idb-keyval';
import { createOutbox, autoFlush } from './outbox.js';
import { setSyncState } from './save.js';
import { getMode, SPACES } from './session.js';
import { getClient, classify } from './supabase.js';

const KEY = 'argo-office-outbox';

/** 서버로 보낸다. 로그인 전·예시 데이터 모드이거나 아직 서버 표가 없는 종류는 이 기기에만 둔다(P1~P3에서 종류를 늘린다). */
async function transport(op) {
  if (getMode() !== 'signedIn') return;
  const { type } = op.payload;
  if (type !== 'layout.set') return; // ponytail: 페이지·메일·결재는 서버 표가 생기는 단계에서 여기에 더한다
  const sb = await getClient();
  const [surface, spaceKey] = op.payload.key.split(':');
  const prefs = { items: op.payload.items };
  let res;
  if (spaceKey === 'me') res = await sb.rpc('office_layout_save', { p_space: 'me', p_surface: surface, p_prefs: prefs });
  else {
    const org = SPACES.find((s) => s.key === spaceKey);
    if (!org || !['owner', 'admin'].includes(org.role)) return; // 조직 구조는 관리자만(화면도 막는다)
    res = await sb.rpc('office_space_layout_save', { p_org: org.id, p_surface: surface, p_layout: prefs });
  }
  if (res.error) throw classify(res.error);
}

export const outbox = createOutbox({
  store: { get: () => get(KEY), set: (v) => set(KEY, v) },
  send: (op) => transport(op).catch((e) => { throw e?.transient === undefined ? Object.assign(e, { transient: true }) : e; }),
  onState: setSyncState,
  onRejected: (op) => console.warn('[office] change rejected by server', op.key), // P0 서버 연결에서 화면 되돌리기·알림으로 바꾼다
});
const auto = autoFlush(outbox);
outbox.load().then(() => auto.now());

/** 변경 하나를 보낼 목록에 넣는다. 같은 key의 아직 안 보낸 변경은 마지막 값으로 합쳐진다. */
export async function queue(key, payload) {
  await outbox.enqueue({ key, payload });
  auto.poke();
}
