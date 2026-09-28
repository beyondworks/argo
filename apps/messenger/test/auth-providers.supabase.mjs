export const configured = true, customServer = false, SB_URL = `${location.origin}/fixture`, SB_ANON = 'fixture';
const scenario = new URLSearchParams(location.search).get('provider-case') || '402';
let calls = 0;
const count = document.createElement('output');
count.setAttribute('aria-label', 'Fixture request count');
document.body.append(count);
const response = (external) => ({ ok: true, status: 200, json: async () => ({ external }) });

// No live client or credentials. Every fetch stays in memory, including the
// deliberately stalled request; unexpected calls fail instead of using a network.
globalThis.fetch = async (url, { signal } = {}) => {
  if (url !== `${SB_URL}/auth/v1/settings`) throw Error('Unexpected fixture fetch');
  count.textContent = `Fixture settings requests: ${++calls}`;
  if (calls === 1) {
    if (scenario === 'offline') throw Error('Fixture offline');
    if (scenario === 'timeout') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (scenario === 'malformed') return response([]);
    if (['402', '403', '429', '500'].includes(scenario)) return { ok: false, status: Number(scenario) };
    if (scenario === 'none') return response({ apple: false, google: false, github: false });
    if (scenario === 'slow') await new Promise((resolve) => setTimeout(resolve, 2500));
    if (scenario === 'healthy' || scenario === 'slow') return response({ apple: true, google: true, github: true });
  }
  return response({ apple: false, google: true, github: false });
};
export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  removeAllChannels: async () => {},
};
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
