// A retryable refresh failure can return { session: null, error } while retaining credentials.
// Keep the mounted conversation/draft until a successful read or an auth SIGNED_OUT event.
export async function reconcileSession(auth, apply) {
  try {
    const { data, error } = await auth.getSession();
    if (!error) apply(data.session ?? null);
  } catch { /* Reconnection will retry; an exception does not establish sign-out. */ }
}
