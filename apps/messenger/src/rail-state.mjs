// A response may update the screen only while both its scope and request are current.
export function createRequestGate(currentScope) {
  let revision = 0;
  return { begin(scope) { const request = ++revision; return () => request === revision && currentScope() === scope; } };
}

// Serialize complete preference batches; a failed batch must not poison later writes.
export function createPreferenceQueue() {
  let tail = Promise.resolve(); let pending = 0; let revision = 0;
  return {
    get busy() { return pending > 0; },
    get revision() { return revision; },
    enqueue(write) {
      pending++; revision++;
      const result = tail.then(write).finally(() => { pending--; revision++; });
      tail = result.catch(() => {});
      return result;
    },
  };
}

export function folderChannelIds(channels, folderOf, folder) {
  return channels.filter((c) => c.kind !== 'dm' && folderOf.get(c.id) === folder).map((c) => c.id);
}

export function reorderFavorites(ids, dragged, before = null) {
  if (!ids.includes(dragged) || before === dragged || (before !== null && !ids.includes(before))) return ids;
  const ordered = ids.filter((id) => id !== dragged);
  ordered.splice(before === null ? ordered.length : ordered.indexOf(before), 0, dragged);
  return ordered;
}
