import { storageKey } from './attach-files.mjs';
import { isNetworkFailure } from './net-errors.mjs';

// 전송 실패의 영어 원문은 카드에 보이지 않는다(검수 E: 'TypeError: Failed to fetch'가 빨간 글씨로 나왔다). 앱이 진단 기록(설정 > 진단)으로 보내는 통로.
let reporter = null;
export const setDeliveryReporter = (fn) => { reporter = fn; };
const OFFLINE_KEY = 'msg.delivery.offline';

// Drafts and retry state live only for this signed-in app session, separately per server/user/channel.
// Keeping the File objects in memory lets navigation preserve attachments without copying them to disk.
const sessions = new Map();
const tabStorage = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };
export function getComposerSession(key, transport, storage = tabStorage()) {
  if (!sessions.has(key)) sessions.set(key, createComposerDelivery(transport, undefined, draftStore(storage, key)));
  return sessions.get(key);
}
export function clearComposerSessions(storage = tabStorage(), { keepUser } = {}) {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  try { // 로그아웃·계정 전환 — 이 기기에 남긴 초안을 지운다(다음 사람이 보지 않게). keepUser: 앱 시작 때 그 계정 초안만 남긴다
    const ids = []; for (let i = 0; i < (storage?.length ?? 0); i++) { const k = storage.key(i); if (k?.startsWith(DRAFT_PREFIX)) ids.push(k); }
    for (const k of ids) if (!keepUser || draftOwner(k) !== keepUser) storage.removeItem(k);
  } catch { /* 저장소 불가 */ }
}
const draftOwner = (id) => { try { return JSON.parse(id.slice(DRAFT_PREFIX.length))[1] ?? null; } catch { return null; } }; // 키 = [서버, uid, 조직, 채널]

// 새로고침(⌘R·당겨서) 뒤에도 쓰던 글이 남게(유건 2026-09-24). sessionStorage = 새로고침엔 남고 앱을 끄면 사라진다.
// 글·멘션·받는 사람·답글 대상만 — 첨부(File)는 저장하지 않는다. 저장소가 막히거나 값이 깨져도 입력창은 그대로 동작한다.
const DRAFT_PREFIX = 'msgr-draft:';
export function draftStore(storage, key) {
  const id = DRAFT_PREFIX + key;
  return {
    id,
    load() { try { const v = JSON.parse(storage?.getItem(id) ?? 'null'); return v && typeof v.text === 'string' ? v : null; } catch { return null; } },
    save({ text, mentions, recipients, replyTo }) {
      try { if (text || replyTo || mentions?.length || recipients?.length) storage?.setItem(id, JSON.stringify({ text, mentions, recipients, replyTo })); else storage?.removeItem(id); } catch { /* 저장소 불가 */ }
    },
  };
}

export function createComposerDelivery(transport, uuid = () => crypto.randomUUID(), drafts = null) {
  const saved = drafts?.load();
  let state = { text: saved?.text ?? '', mentions: saved?.mentions ?? [], recipients: saved?.recipients ?? [], files: [], replyTo: saved?.replyTo ?? null, job: null, busy: false, uploading: '' }; // replyTo = { id, who, body } — 답글 대상(D17)
  let disposed = false;
  const listeners = new Set();
  const patch = (delta) => {
    if (disposed) return;
    state = { ...state, ...delta };
    if (['text', 'mentions', 'recipients', 'replyTo'].some((k) => k in delta)) drafts?.save(state);
    for (const listener of listeners) listener();
  };
  const update = (key, value) => patch({ [key]: typeof value === 'function' ? value(state[key]) : value });
  async function deliver(job) {
    if (disposed || state.busy) return false;
    patch({ busy: true, uploading: '', job: { ...job, error: '', errorKey: '' } });
    try {
      job.messageId ??= await transport.message(job);
      if (disposed) return false;
      for (const item of job.files) {
        if (disposed) return false;
        if (item.done) continue;
        patch({ uploading: item.file.name });
        try {
          if (!item.uploaded) {
            await transport.upload(job, item);
            item.uploaded = true;
          }
          if (disposed) return false;
          await transport.attachment(job, item);
          item.done = true;
          item.error = '';
        } catch (error) { item.error = error.message; }
      }
      const failed = job.files.filter((item) => !item.done);
      if (failed.length) {
        // 첨부만 보낸 글(본문 없음)인데 파일이 하나도 올라가지 못했다 — 글자 없는 빈 말풍선이 모두에게 남지 않게 그 글을 지운다(점검 A·B #4).
        // 글 번호가 있어야 저장 경로를 만들 수 있어(서버 함수 msgr_bot_file·msgr_can_read_dm_attachment가 경로 3번째 칸 = 글 번호를 본다)
        // 글을 먼저 올리고 업로드하는 순서는 그대로 두고, 전부 실패했을 때만 지운다. 지우면 재시도는 새 글(새 고정 ID)로 처음부터 올린다.
        // 일부라도 올라갔으면 글은 남는다(첨부가 보이므로 빈 말풍선이 아니다) — 재시도가 나머지를 붙인다.
        if (!disposed && !job.body && transport.discard && job.files.every((item) => !item.uploaded)) {
          try { await transport.discard(job); job.messageId = null; job.clientId = uuid(); } catch { /* 지우지 못하면 글을 그대로 둔다 — 재시도가 이어서 올린다 */ }
        }
        const errors = failed.filter((item) => item.error); // 오류가 기록된 파일만(시도하지 않은 파일은 이유가 없다)
        const error = errors.map((item) => `${item.file.name}: ${item.error}`).join('\n');
        if (errors.some((item) => isNetworkFailure(item.error))) reporter?.('send', error);
        patch({ job: { ...job, error, errorKey: errors.length && errors.every((item) => isNetworkFailure(item.error)) ? OFFLINE_KEY : '' } }); // 일부만 네트워크 오류면 원문 줄을 그대로 — 다른 원인을 연결 탓으로 덮지 않는다(#793). 전부 실패해 글을 지웠으면 messageId=null이라 카드는 '전송 실패' 제목
        return false;
      }
      patch({ job: null, lastDeliveredId: job.messageId });
      return true;
    } catch (error) {
      const offline = !error.uiKey && isNetworkFailure(error.message);
      if (offline) reporter?.('send', String(error)); // 'TypeError: Failed to fetch' — 화면에는 문구만, 원문은 진단 기록에
      patch({ job: { ...job, error: error.message, errorKey: error.uiKey ?? (offline ? OFFLINE_KEY : '') } }); // errorKey가 있으면 카드는 원문 대신 그 문구를 쓴다(D50)
      return false;
    } finally { patch({ busy: false, uploading: '' }); }
  }
  return {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setText: (value) => update('text', value),
    setMentions: (value) => update('mentions', value),
    setRecipients: (value) => update('recipients', value),
    setFiles: (value) => update('files', value),
    setReplyTo: (value) => update('replyTo', value),
    send(mentions) {
      if (disposed || state.busy || state.job || (!state.text.trim() && !state.files.length)) return Promise.resolve(false);
      const job = { clientId: uuid(), body: state.text.trim(), mentions, replyTo: state.replyTo?.id ?? null, messageId: null,
        files: state.files.map((file, index) => ({ id: uuid(), file, key: storageKey(file.name, index), uploaded: false, done: false })) };
      // The submitted snapshot is owned by the delivery card; the next draft is independent.
      patch({ text: '', mentions: [], recipients: [], files: [], replyTo: null, job });
      return deliver(job);
    },
    retry() { return state.job ? deliver(state.job) : Promise.resolve(false); },
    dismiss() { if (!state.busy) patch({ job: null }); },
    dispose() { disposed = true; listeners.clear(); state = { text: '', mentions: [], recipients: [], files: [], replyTo: null, job: null, busy: false, uploading: '' }; },
  };
}

// Stable IDs cover ambiguous network failures: a committed message/attachment is looked up, never
// posted again with a fresh ID. Storage paths also stay fixed when only metadata needs a retry.
export function composerTransport(client, { orgId, chId, uid, onDiscard = null }) {
  const pathFor = (job, item) => `${orgId}/${chId}/${job.messageId}/${item.id}-${item.key}`; // 3번째 칸 = 글 번호 — 서버 msgr_bot_file(봇 첨부)·msgr_can_read_dm_attachment(위임 1:1 첨부 읽기)가 이 칸을 본다
  return {
    async message(job) {
      const insert = () => client.from('msgr_messages').insert({ channel_id: chId, author_kind: 'user', author_user_id: uid,
        body: job.body, mentions: job.mentions, client_msg_id: job.clientId, ...(job.replyTo ? { reply_to: job.replyTo } : {}) }).select('id').single(); // 답글이면 reply_to(서버 트리거가 같은 채널인지 보고 thread_root를 채운다)
      // D50: 가려진 동안 토큰 갱신이 멈췄다가 네트워크 오류로 실패하면 supabase-js는 세션 없음으로 보고 익명 키로 보낸다(anon-guard.mjs가 막음).
      // auth-js 2.114는 갱신 실패를 60초 캐시해(lastRefreshFailure) 네트워크가 돌아와도 요청 없이 실패를 준다 — 사람이 누른 전송이므로 먼저 비워
      // 이 insert의 토큰 조회가 실제로 갱신을 시도하게 한다. 비우는 곳은 사람이 누른 전송·재시도(이 함수)뿐 — 타이머·폴에서는 비우지 않는다(자동 갱신 폭주 방지 장치는 그대로).
      if (client.auth && 'lastRefreshFailure' in client.auth) client.auth.lastRefreshFailure = null;
      let result = await insert();
      if (!result.error) return result.data.id;
      const auth = await authFailure(client, result);
      if (auth === 'no-session') throw Object.assign(new Error(result.error.message), { uiKey: 'msg.delivery.authExpired' }); // 방금 갱신을 시도했고 실패 — 또 기다리게 하지 않는다
      if (auth === 'rejected') { // 세션은 있는데 서버가 토큰을 거절(만료 등) — 한 번 갱신 뒤 한 번만 다시
        const refreshed = await client.auth.refreshSession().catch(() => ({ error: true }));
        if (refreshed?.error || !refreshed?.data?.session) throw Object.assign(new Error(result.error.message), { uiKey: 'msg.delivery.authExpired' });
        result = await insert();
        if (!result.error) return result.data.id;
        if (await authFailure(client, result)) throw Object.assign(new Error(result.error.message), { uiKey: 'msg.delivery.authExpired' });
      }
      const found = await client.from('msgr_messages').select('id').eq('channel_id', chId).eq('author_kind', 'user')
        .eq('author_user_id', uid).eq('client_msg_id', job.clientId).maybeSingle();
      if (!found.error && found.data) return found.data.id;
      throw new Error(result.error.message);
    },
    async upload(job, item) {
      const path = pathFor(job, item);
      const bucket = client.storage.from('msgr');
      const result = await bucket.upload(path, item.file, { contentType: item.file.type || 'application/octet-stream' });
      if (!result.error) return;
      const slash = path.lastIndexOf('/'); const name = path.slice(slash + 1);
      const found = await bucket.list(path.slice(0, slash), { search: name });
      if (!found.error && found.data?.some((entry) => entry.name === name)) return;
      throw new Error(result.error.message);
    },
    // 첨부만 보낸 글이 전부 실패했을 때 그 빈 글을 지운다 — 직접 지우기 정책은 없고(DELETE 정책 없음) 작성자의 삭제 표시(deleted_at)만 허용된다. 앱의 삭제와 같은 갱신
    async discard(job) {
      const result = await client.from('msgr_messages').update({ body: '', deleted_at: new Date().toISOString() }).eq('id', job.messageId).eq('author_user_id', uid).select('id');
      let failure = result.error ? new Error(result.error.message) : !result.data?.length ? new Error('discard: no row') : null; // RLS가 0행으로 거절한 경우도 실패
      if (failure) {
        // 응답이 유실됐을 수 있다(서버엔 적용, 앱은 실패로 봄) — 그대로 실패로 두면 재시도가 지운 글에 첨부를 붙여 파일이 안 보인다. 한 번 다시 읽어 이미 지워졌으면 성공으로 본다
        const again = await Promise.resolve().then(() => client.from('msgr_messages').select('deleted_at').eq('id', job.messageId).maybeSingle()).catch(() => ({ data: null }));
        if (!again?.data?.deleted_at) throw failure;
        failure = null;
      }
      try { onDiscard?.(job.messageId); } catch { /* 방송은 최선 — 이미 받은 사람의 화면은 다음 보정 조회에서도 바로잡힌다 */ } // 이미 이 글을 받은 다른 사람의 화면이 빈 말풍선을 바로 지우도록(앱의 삭제와 같은 'edit' 방송)
    },
    async attachment(job, item) {
      const result = await client.from('msgr_attachments').insert({ id: item.id, message_id: job.messageId,
        org_id: orgId, storage_path: pathFor(job, item), name: item.file.name, mime: item.file.type, bytes: item.file.size });
      if (!result.error) return;
      const found = await client.from('msgr_attachments').select('id,message_id').eq('id', item.id).maybeSingle();
      if (!found.error && found.data && String(found.data.message_id) === String(job.messageId)) return;
      throw new Error(result.error.message);
    },
  };
}

/** 인증 실패 판정 — 'no-session'(지금 세션이 비어 있음: 갱신이 실패한 상태, 요청은 익명으로 나갔거나 anon-guard가 막음) |
    'rejected'(세션은 있는데 401·PGRST301~303) | false(인증과 무관한 거절 — RLS 403·트리거 등은 원인을 숨기지 않는다). */
export async function authFailure(client, result) {
  const { data } = await client.auth.getSession().catch(() => ({ data: null }));
  if (!data?.session) return 'no-session';
  if (result?.status === 401 || /^PGRST30[1-3]$/.test(result?.error?.code ?? '')) return 'rejected';
  return false;
}
