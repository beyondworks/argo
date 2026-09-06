// 멤버로 로그인해 @서윤·@준에게 한 마디씩 보내고 답을 기다린다(최대 150초). 실러너 E2E 드라이버.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const SP = process.env.SP; const seed = JSON.parse(readFileSync(`${SP}/seed.json`, 'utf8'));
const env = Object.fromEntries(readFileSync(`${process.env.APP_DIR}/.env.local`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const member = seed.users.find((u) => u.tag === (process.env.AS || 'member'));
const c = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const s = await c.auth.signInWithPassword({ email: member.email, password: member.password }); if (s.error) throw s.error;
const uid = s.data.user.id;
const { data: crews } = await c.from('msgr_crews').select('id, slug, display_name, owner_user_id').eq('org_id', seed.org);
const by = Object.fromEntries(crews.map((x) => [x.slug, x]));
const ALL = { seoyun: '@서윤 다음 주 뉴스레터 제목 후보 2개만 한 줄씩 제안해줘.', jun: '@준 지난주 전환율이 2.1%에서 2.6%로 올랐어. 한 문장으로 해석해줘.' };
const asks = (process.env.ONLY ? process.env.ONLY.split(',') : Object.keys(ALL)).map((k) => [k, ALL[k]]);
const sent = [];
for (const [slug, body] of asks) {
  const { data, error } = await c.from('msgr_messages').insert({ channel_id: seed.channel, author_kind: 'user', author_user_id: uid, body, mentions: [{ kind: 'crew', id: by[slug].id }], client_msg_id: crypto.randomUUID() }).select('id').single();
  if (error) throw error; sent.push({ slug, id: data.id }); console.log('sent', slug, data.id);
}
const t0 = Date.now(); const got = {};
while (Date.now() - t0 < 150_000 && Object.keys(got).length < sent.length) {
  await new Promise((r) => setTimeout(r, 4000));
  const { data: rows } = await c.from('msgr_messages').select('id, author_kind, crew_id, body, reply_to, created_at').eq('channel_id', seed.channel).gt('id', sent[0].id - 1).order('id');
  for (const r of rows ?? []) if (r.author_kind === 'crew') { const sl = crews.find((x) => x.id === r.crew_id)?.slug; if (sl && !got[sl]) { got[sl] = r; console.log(`\n[${sl}] +${Math.round((Date.now() - t0) / 1000)}s reply_to=${r.reply_to}\n${r.body.slice(0, 600)}`); } }
}
console.log('\nresult:', Object.keys(got).length, '/', sent.length, 'replies in', Math.round((Date.now() - t0) / 1000), 's');
process.exit(Object.keys(got).length === sent.length ? 0 : 1);
