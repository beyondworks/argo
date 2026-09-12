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
  let state = { text: '', mentions: [], files: [], job: null, busy: false, uploading: '' };
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
    patch({ busy: true, uploading: '', job: { ...job, error: '' } });
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
      patch({ job: { ...job, error: error.message } });
      return false;
    } finally { patch({ busy: false, uploading: '' }); }
  }
  return {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setText: (value) => update('text', value),
    setMentions: (value) => update('mentions', value),
    setFiles: (value) => update('files', value),
    send(mentions) {
      if (disposed || state.busy || state.job || (!state.text.trim() && !state.files.length)) return Promise.resolve(false);
      const job = { clientId: uuid(), body: state.text.trim(), mentions, messageId: null,
        files: state.files.map((file, index) => ({ id: uuid(), file, key: storageKey(file.name, index), uploaded: false, done: false })) };
      // The submitted snapshot is owned by the delivery card; the next draft is independent.
      patch({ text: '', mentions: [], files: [], job });
      return deliver(job);
    },
    retry() { return state.job ? deliver(state.job) : Promise.resolve(false); },
    dismiss() { if (!state.busy) patch({ job: null }); },
    dispose() { disposed = true; listeners.clear(); state = { text: '', mentions: [], files: [], job: null, busy: false, uploading: '' }; },
  };
}

// Stable IDs cover ambiguous network failures: a committed message/attachment is looked up, never
// posted again with a fresh ID. Storage paths also stay fixed when only metadata needs a retry.
export function composerTransport(client, { orgId, chId, uid }) {
  const pathFor = (job, item) => `${orgId}/${chId}/${job.messageId}/${item.id}-${item.key}`;
  return {
    async message(job) {
      const result = await client.from('msgr_messages').insert({ channel_id: chId, author_kind: 'user', author_user_id: uid,
        body: job.body, mentions: job.mentions, client_msg_id: job.clientId }).select('id').single();
      if (!result.error) return result.data.id;
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
