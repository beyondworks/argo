// 실러너 브리지(개발 전용) — 데모 브리지(msgr-demo-bridge.mjs)와 같은 배선이지만 러너가 진짜다.
//  · 서윤 = openrouter 무료 모델(카탈로그 첫 항목, env OPENROUTER_API_KEY — 값은 셸에서 주입, 여기서 출력하지 않는다)
//  · 준   = claude SDK, 이 컴퓨터의 Claude Code 로그인(host 옵트인) — HOME은 실제 그대로(격리하면 로그인이 없다)
// 실추론 비용이 발생한다(유건 승인 2026-09-03). ARGO_ROOT는 임시 디렉터리라 실데이터 미접촉.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
const SP = process.env.SP;
const seed = JSON.parse(readFileSync(`${SP}/seed.json`, 'utf8'));
const env = Object.fromEntries(readFileSync(`${process.env.APP_DIR}/.env.local`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const orKey = process.env.OPENROUTER_API_KEY; if (!orKey) throw new Error('OPENROUTER_API_KEY 없음(셸에서 주입)');
const ROOT = await mkdtemp(join(tmpdir(), 'argo-real-msgr-'));
process.env.ARGO_ROOT = ROOT;
for (const k of Object.keys(process.env)) if (/^NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE_KEY|ARGO_TENANT|ARGO_SYNC|ARGO_CLAUDE_BASE_URL/i.test(k)) delete process.env[k];
const owner = seed.users.find((u) => u.tag === 'owner');
const c = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const s = await c.auth.signInWithPassword({ email: owner.email, password: owner.password }); if (s.error) throw s.error;
const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { saveDeviceSession } = await import('../src/devicesession.mjs');
const { RUNNERS } = await import('../src/runners/catalog.mjs').catch(() => ({ RUNNERS: null }));
const freeModel = process.env.OPENROUTER_MODEL || RUNNERS?.openrouter?.models?.find((m) => m.free)?.id || 'minimax/minimax-m3:free';
const ws = 'lean-ax-dev';
await createCompany(ws, '린 컴퍼니', '유건', owner.id, 'ko');
await writeFile(join(paths(ws).agents, 'seoyun.md'), `---\nname: 서윤\nrole: 마케터\nrunner: openrouter\nmodel: ${freeModel}\n---\n마케팅 담당. 답은 한국어로 짧게(3문장 이내).\n`);
await writeFile(join(paths(ws).agents, 'jun.md'), '---\nname: 준\nrole: 데이터 분석\nrunner: claude\n---\n데이터 분석 담당. 답은 한국어로 짧게(3문장 이내).\n');
await saveRunnerCred(ws, 'openrouter', 'apikey', orKey);
await saveRunnerCred(ws, 'claude', 'host', 'host');
await saveDeviceSession({ url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY, session: s.data.session });
await updateCompany(ws, { msgr: { enabled: true } });
const M = await import('../src/gateway/msgr.mjs');
const { startQueueWorker } = await import('../src/gateway/queue.mjs');
startQueueWorker(ws, M.MSGR_KEY, M.makeMsgrHandler(ws));
M.startMsgrBridge(ws, { pollMs: 5000 });
const { onNotify } = await import('../src/notify.mjs');
onNotify((ev) => M.msgrPush(ev).catch((e) => console.error('[real-bridge] msgr 푸시 실패:', e.message))); // 운영 게이트웨이의 pushEvent 접합과 같은 역할(결재 카드·위임·후속 보고 미러) — 없으면 크루가 올린 결재가 로컬에만 남는다(G-4 실측)
console.log(`[real-bridge] ready — ws=${ws} root=${ROOT} owner=${owner.email} seoyun=openrouter:${freeModel} jun=claude:host`);
setInterval(() => {}, 60_000);
