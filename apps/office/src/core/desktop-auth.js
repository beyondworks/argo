import { handoff } from '../../../messenger/src/oauth-handoff.mjs';
import { getClient, supabaseUrl, devPasswordLogin } from './supabase.js';
import { isDesktop, apiUrl, openExternal } from './platform.js';
import { t } from './i18n.js';
import { acceptMailCallback, authError, mailAuthorization, MAIL_TIMEOUT } from './desktop-auth-policy.js';

const PENDING = 'argo-office-mail-pending';
let ready;
let waiting;
let starting = null;
export const desktopMailPending = () => !!starting || !!waiting;
const notifyPending = () => window.dispatchEvent(new Event('office-mail-pending'));
let delivery = Promise.resolve();
const enqueue = (urls) => { delivery = delivery.catch(() => {}).then(() => receive(urls)); return delivery; };
const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING)); } catch { return null; } };
const uid = async () => (await (await getClient())?.auth.getSession())?.data.session?.user?.id;

export async function signInDesktop(provider, { signal } = {}) {
  const { invoke } = await import('@tauri-apps/api/core');
  const check = () => { if (signal?.aborted) throw authError('cancelled'); };
  check();
  const tokens = await handoff({ supabaseUrl, provider }, {
    invoke, openUrl: async (url) => { check(); await openExternal(url); }, now: Date.now,
    sleep: (ms) => new Promise((resolve, reject) => {
      check();
      const cancel = () => { clearTimeout(timer); reject(authError('cancelled')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
      signal?.addEventListener('abort', cancel, { once: true });
    }),
  });
  check();
  const { error } = await (await getClient()).auth.setSession(tokens);
  if (error) throw error;
}

async function receive(urls) {
  for (const url of urls) {
    const activeWaiter = waiting;
    let payload;
    let pending;
    try {
      const currentUid = await uid();
      pending = readPending();
      payload = acceptMailCallback(url, pending, currentUid);
      if (!payload) continue;
      localStorage.removeItem(PENDING);
      const { finishConnect, loadAccounts } = await import('./mail.js');
      const result = await finishConnect(payload.code, payload.state);
      await loadAccounts();
      if (activeWaiter && waiting === activeWaiter) activeWaiter.resolve(result);
      else {
        const { navigate } = await import('./router.jsx');
        navigate('/me/mail', { replace: true });
      }
    } catch (error) {
      if (pending && readPending()?.state === pending.state) localStorage.removeItem(PENDING);
      if (activeWaiter && waiting === activeWaiter) activeWaiter.reject(error);
      else {
        const { showToast } = await import('../ui/Overlay.jsx');
        showToast(t(`mailc.err.${error.code === 'access_denied' ? 'access_denied' : 'state'}`));
      }
    }
  }
}

export async function initDesktopAuth() {
  if (!isDesktop()) return;
  if (!ready) ready = (async () => {
    const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
    await onOpenUrl((urls) => { void enqueue(urls); });
    const current = await getCurrent();
    if (current) await enqueue(current);
  })().catch((error) => { ready = null; throw error; });
  return ready;
}

export async function startDesktopMail(url) {
  if (starting || waiting) throw authError('busy');
  const launch = {};
  starting = launch;
  notifyPending();
  try {
    await initDesktopAuth();
    const state = mailAuthorization(url, { reviewOrigin: import.meta.env.VITE_OFFICE_FAKE_GOOGLE_ORIGIN, reviewEnabled: devPasswordLogin });
    const user = await uid();
    if (starting !== launch) throw authError('cancelled');
    if (!user) throw authError('signed_out');
    localStorage.setItem(PENDING, JSON.stringify({ state, uid: user, expires: Date.now() + MAIL_TIMEOUT }));
  } finally { if (starting === launch) starting = null; notifyPending(); }
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => { clearTimeout(timer); if (waiting !== attempt) return; waiting = null; localStorage.removeItem(PENDING); notifyPending(); fn(value); };
    const timer = setTimeout(() => settle(reject, authError('expired')), MAIL_TIMEOUT);
    const attempt = { resolve: (v) => settle(resolve, v), reject: (e) => settle(reject, e) };
    waiting = attempt;
    notifyPending();
    openExternal(url).catch((e) => attempt.reject(e));
  });
}

export function cancelDesktopMail() { starting = null; waiting?.reject(authError('cancelled')); localStorage.removeItem(PENDING); notifyPending(); }

export async function initMailRelay() {
  if (isDesktop() || location.pathname !== '/me/mail/connect') return false;
  const q = new URLSearchParams(location.search);
  if (!q.has('state')) return false;
  let r;
  try {
    r = await fetch(apiUrl('/api/mail/relay'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: q.get('state'), code: q.get('code'), error: q.get('error') }), signal: AbortSignal.timeout(15000) });
    if (r.status >= 500) throw authError('server');
  } catch {
    const container = document.createElement('main'); container.className = 'login';
    const card = document.createElement('div'); card.className = 'login-card';
    const label = document.createElement('p'); label.textContent = t('desktop.relayFailed');
    const retry = document.createElement('button'); retry.className = 'btn primary'; retry.textContent = t('desktop.retry'); retry.onclick = () => location.reload();
    card.append(label, retry); container.append(card); document.getElementById('root').replaceChildren(container);
    return true;
  }
  if (!r.ok) return false;
  const result = await r.json();
  if (result.desktop !== true) return false;
  const link = new URL(result.url);
  if (link.protocol !== 'argo-office:' || link.hostname !== 'mail' || link.pathname !== '/callback' || link.username || link.password || link.port || link.hash) throw authError('state');
  history.replaceState(null, '', '/me/mail/connect');
  const container = document.createElement('main');
  container.className = 'login';
  const card = document.createElement('div'); card.className = 'login-card';
  const label = document.createElement('p'); label.textContent = t('desktop.returnHint');
  const button = document.createElement('a'); button.className = 'btn primary'; button.textContent = t('desktop.return'); button.href = link.href;
  card.append(label, button); container.append(card); document.getElementById('root').replaceChildren(container);
  location.assign(link.href);
  return true;
}
