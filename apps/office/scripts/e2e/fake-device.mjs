// 가짜 기기(개발 전용) — 메일 주인 기기의 Argo 앱 대신, 같은 사용자로 로그인해 ot:<uid> 번역 요청을 받아 게이트웨이와 같은 처리(handleTranslate)로 답한다.
// 기본은 결정적인 가짜 번역("번역:" 접두), REAL=1이면 이 맥의 구독 로그인으로 실제 번역(runOneShot, ARGO_ROOT 필요). NOSUB=1이면 구독이 없는 기기.
// 통로는 실제 앱과 같은 joinTranslate(사용자당 하나·기기 고르기·취소)를 쓴다. 실제로 번역을 맡으면 'worked <rid>'를 찍는다.
// 실행: node scripts/e2e/fake-device.mjs <email> <password 파일> [앱 주소=http://localhost:5191]
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { handleTranslate, joinTranslate } from '../../../../src/gateway/office-translate.mjs';

const [email, pwFile, app = 'http://localhost:5191'] = process.argv.slice(2);
const mod = await (await fetch(`${app}/src/core/supabase.js`)).text();           // 로컬 dev 서버가 넣어 둔 공개값(주소·익명 키)을 그대로 쓴다 — 출력하지 않는다
const url = /const URL_ = "([^"]+)"/.exec(mod)?.[1] ?? /(http:\/\/127\.0\.0\.1:\d+)/.exec(mod)?.[1];
const anon = /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(mod)?.[0];
if (!url || !anon) { console.error('supabase config not found'); process.exit(2); }
const sb = createClient(url, anon, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({ email, password: readFileSync(pwFile, 'utf8').trim() });
if (error) { console.error('login failed'); process.exit(2); }
await sb.realtime.setAuth(data.session.access_token);
const fake = async (ws, prompt, o) => {
  const items = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  const out = items.map((s) => `번역:${s}`);
  const text = JSON.stringify(out);
  for (let k = 0; k < text.length; k += 12) { o.onText?.(text.slice(k, k + 12)); await new Promise((r) => setTimeout(r, 30)); }
  return { text };
};
const opts = { ...(process.env.REAL ? {} : { oneShot: fake, credType: async () => (process.env.NOSUB ? null : 'oauth') }) };
joinTranslate(sb, data.user.id, process.env.DEVICE_WS ?? 'e2e-device', {
  translate: (ids, payload, send) => {
    console.log('request', payload?.rid, (payload?.batches ?? []).length);
    handleTranslate(ids, payload, { send, ...opts }).then((did) => did && console.log('worked', payload.rid)).catch((e) => console.error('translate failed', e.message));
  },
});
// joinTranslate는 구독 결과를 알리지 않는다 — 같은 채널 객체의 상태로 준비를 기다린다
for (let i = 0; i < 100 && sb.getChannels()[0]?.state !== 'joined'; i++) await new Promise((r) => setTimeout(r, 100));
console.log(`device ${sb.getChannels()[0]?.state === 'joined' ? 'SUBSCRIBED' : 'NOT_JOINED'}`);
process.on('SIGTERM', () => { sb.removeAllChannels(); process.exit(0); });
