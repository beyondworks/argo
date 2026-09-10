// RealtimeClient caches topics until async removal completes. Keep one scope per shared client owner.
// setup(isDisposed, registerDispose) registers cleanup immediately after allocation, before subscription.
// A returned disposer remains supported when setup cannot fail after allocating its resource.
export function createRealtimeScope(onError = () => {}) {
  let tail = Promise.resolve();
  return {
    run(setup) {
      let disposed = false;
      let release;
      const ended = new Promise((resolve) => { release = resolve; });
      const task = tail.then(async () => {
        if (disposed) return;
        let dispose;
        try {
          try {
            const returned = await setup(() => disposed, (cleanup) => { dispose = cleanup; });
            dispose ??= returned;
          } catch (error) { disposed = true; onError(error); return; }
          await ended;
        } finally {
          disposed = true;
          await dispose?.();
        }
      });
      // A failed removal leaves channel ownership uncertain: do not create/reuse its topic.
      tail = task;
      task.catch(onError);
      return () => { disposed = true; release(); return task; };
    },
  };
}
