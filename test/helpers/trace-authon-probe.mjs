// turn-trace-scope.test.mjs가 자식 프로세스로 돌리는 프로브 — 인증 켜짐(출하 구성)에서 작업 과정 조회(/trace)와 회의실(/room)이
// 1:1 대화 라우트(/chat)와 **같은 접근 판정**을 받는지 JSON 한 줄로 낸다. 게스트 모드 끔/켬 × 회사 상태(귀속·일반·없음).
// env: ARGO_ROOT(임시) · NEXT_PUBLIC_SUPABASE_URL=가짜 .invalid 주소(네트워크 없음 — 쿠키 없는 요청은 기기 세션·게스트 폴백으로 판정)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from 'node:module';
register(new URL('./next-headers-stub-resolve.mjs', import.meta.url));
globalThis.__argoScheduler = true; globalThis.__argoGateway = true;
const { WS_ROOT } = await import('../../src/workspace.mjs');
const { enableGuestMode } = await import('../../src/gueststate.mjs');
const { AUTH_ON } = await import('../../app/authmsg.mjs');
const T = await import('../../src/turn-trace.mjs');
const chatRoute = await import('../../app/api/companies/[ws]/chat/route.js');
const traceRoute = await import('../../app/api/companies/[ws]/trace/route.js');
const roomRoute = await import('../../app/api/companies/[ws]/room/route.js');
await mkdir(WS_ROOT, { recursive: true });
const seed = async (ws, company) => {
  await mkdir(join(WS_ROOT, ws, 'chats'), { recursive: true });
  await writeFile(join(WS_ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: ws, ...company }));
  const tr = T.createTrace({ wsId: ws, slug: 'a', source: 'chat' }); tr.think('비밀 생각'); await tr.finish();
  return tr.id;
};
const ids = { ok: await seed('tr-ok', {}), linked: await seed('tr-linked', { ownerId: 'someone-else' }) };
const call = async (route, ws, url) => { const res = await route.GET(new Request(`http://localhost${url}`), { params: Promise.resolve({ ws }) }); const b = await res.json().catch(() => ({})); return { status: res.status, errorCode: b.errorCode ?? null, hasTrace: !!b.trace }; };
const round = async () => {
  const out = {};
  for (const [k, ws] of [['ok', 'tr-ok'], ['linked', 'tr-linked'], ['missing', 'tr-none']]) {
    out[k] = {
      chat: await call(chatRoute, ws, `/api/companies/${ws}/chat?slug=a`),
      trace: await call(traceRoute, ws, `/api/companies/${ws}/trace?slug=a&id=${ids[k] ?? ids.ok}`),
      room: await call(roomRoute, ws, `/api/companies/${ws}/room`),
    };
  }
  return out;
};
const out = { authOn: AUTH_ON, noGuest: await round() };
await enableGuestMode();
out.guest = await round();
console.log(JSON.stringify(out));
