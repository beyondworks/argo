import { storageKey } from './attach-files.mjs';

// Drafts and retry state live only for this signed-in app session, separately per server/user/channel.
// Keeping the File objects in memory lets navigation preserve attachments without copying them to disk.
const sessions = new Map();
export function getComposerSession(key, transport) {
  if (!sessions.has(key)) sessions.set(key, createComposerDelivery(transport));
  return sessions.get(key);
}
export function clearComposerSessions() {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}

export function createComposerDelivery(transport, uuid = () => crypto.randomUUID()) {
  let state = { text: '', mentions: [], recipients: [], files: [], replyTo: null, job: null, busy: false, uploading: '' }; // replyTo = { id, who, body } — 답글 대상(D17)
  let disposed = false;
  const listeners = new Set();
  const patch = (delta) => {
    if (disposed) return;
    state = { ...state, ...delta };
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
        patch({ job: { ...job, error: failed.map((item) => `${item.file.name}: ${item.error}`).join('\n') } });
        return false;
      }
      patch({ job: null, lastDeliveredId: job.messageId });
      return true;
    } catch (error) {
      patch({ job: { ...job, error: error.message, errorKey: error.uiKey ?? '' } }); // errorKey가 있으면 카드는 원문 대신 그 문구를 쓴다(D50)
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
export function composerTransport(client, { orgId, chId, uid }) {
  const pathFor = (job, item) => `${orgId}/${chId}/${job.messageId}/${item.id}-${item.key}`;
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
