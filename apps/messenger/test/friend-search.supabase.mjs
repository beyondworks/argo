// UI fixture only: fake users, no production client, mail, or friend notifications.
import { supabase as base } from './dm-lifecycle.supabase.mjs';
export { configured, customServer, SB_URL, SB_ANON, q } from './dm-lifecycle.supabase.mjs';
const state = window.__friendFixture = Object.assign(window.__dmFixture, { friendCalls: [], friends: [], holdRpc: null, failRpc: null });
const profiles = [
  { user_id: 'user-other', handle: 'colleague', display_name: 'Fixture Colleague', email: 'colleague@example.invalid', relation: 'none' },
  { user_id: 'user-new', handle: 'newperson', display_name: 'Fixture New Person With A Long Display Name', email: 'new@example.invalid', relation: 'none' },
  { user_id: 'user-sent', handle: 'sentperson', display_name: 'Fixture Sent Person', email: 'sent@example.invalid', relation: 'sent' },
  { user_id: 'user-received', handle: 'receivedperson', display_name: 'Fixture Received Person', email: 'received@example.invalid', relation: 'received' },
  { user_id: 'user-friend', handle: 'friendperson', display_name: 'Fixture Friend Person', email: 'friend@example.invalid', relation: 'friend' },
];
state.seed = () => { state.friends = profiles.filter(p => !['none', 'blocked'].includes(p.relation)).map(p => ({ ...p, status: p.relation === 'friend' ? 'accepted' : 'pending', requested_by: p.relation === 'received' ? p.user_id : 'user-me', created_at: new Date().toISOString() })); };
state.seed();
const originalRpc = base.rpc;
base.rpc = async (name, args = {}) => {
  if (!['msgr_my_friends', 'msgr_find_user', 'msgr_friend_request', 'msgr_friend_decide', 'msgr_friend_remove'].includes(name)) return originalRpc(name, args);
  state.friendCalls.push({ name, args: structuredClone(args) });
  if (state.holdRpc === name) { state.holdRpc = null; await new Promise(resolve => { state.release = () => { state.release = null; resolve(); }; }); }
  if (state.failRpc === name) { state.failRpc = null; return { data: null, error: { message: 'Fixture search failure' } }; }
  if (name === 'msgr_my_friends') return { data: structuredClone(state.friends), error: null };
  if (name === 'msgr_find_user') {
    const input = args.q.trim().replace(/^@/, '').toLowerCase();
    return { data: profiles.filter(p => input.includes('@') ? p.email === input : p.handle.includes(input)).map(p => {
      const f = state.friends.find(f => f.user_id === p.user_id);
      return { user_id: p.user_id, handle: p.handle, display_name: p.display_name, relation: f ? f.status === 'accepted' ? 'friend' : f.requested_by === 'user-me' ? 'sent' : 'received' : 'none' };
    }), error: null };
  }
  if (name === 'msgr_friend_request') {
    if (!state.friends.some(f => f.user_id === args.target)) state.friends.push({ ...profiles.find(p => p.user_id === args.target), status: 'pending', requested_by: 'user-me', created_at: new Date().toISOString() });
  }
  if (name === 'msgr_friend_decide') state.friends = state.friends.flatMap(f => f.user_id !== args.other ? [f] : args.accept ? [{ ...f, status: 'accepted' }] : []);
  if (name === 'msgr_friend_remove') state.friends = state.friends.filter(f => f.user_id !== args.other);
  return { data: true, error: null };
};
export const supabase = base;
