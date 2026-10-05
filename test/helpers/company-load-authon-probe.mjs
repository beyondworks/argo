// company-load-errors.test.mjs가 자식 프로세스로 돌리는 프로브 — 인증 켜짐(출하 구성) + 게스트 모드에서 회사 정보 GET이
// 회사 파일 상태별로 어떤 응답을 내리는지 JSON 한 줄로 출력한다. AUTH_ON은 모듈 로드 시 env로 정해져 같은 프로세스에서 끄고 켤 수 없다.
// env: ARGO_ROOT(임시) · NEXT_PUBLIC_SUPABASE_URL=가짜 .invalid 주소(네트워크 호출 없음 — 게스트는 쿠키 없이 파일로 판정한다)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from 'node:module';
register(new URL('./next-headers-stub-resolve.mjs', import.meta.url));
globalThis.__argoScheduler = true; globalThis.__argoGateway = true;
const { WS_ROOT } = await import('../../src/workspace.mjs');
const { enableGuestMode } = await import('../../src/gueststate.mjs');
const { AUTH_ON } = await import('../../app/authmsg.mjs');
await mkdir(WS_ROOT, { recursive: true });
await enableGuestMode();
const route = await import('../../app/api/companies/[ws]/route.js');
const out = { authOn: AUTH_ON };
const call = async (key, ws, lang = 'ko') => {
  const res = await route.GET(new Request(`http://localhost/api/companies/${ws}?light=1`, { headers: { cookie: `argo-lang=${lang}` } }), { params: Promise.resolve({ ws }) });
  const body = await res.json().catch(() => ({}));
  out[key] = { status: res.status, errorCode: body.errorCode ?? null };
};
await call('missing', 'au-none'); // company.json 없음
await mkdir(join(WS_ROOT, 'au-corrupt'), { recursive: true });
await writeFile(join(WS_ROOT, 'au-corrupt', 'company.json'), '{"id": "au-corrupt", 잘린 JSON'); // 손상
await call('corrupt', 'au-corrupt');
await mkdir(join(WS_ROOT, 'au-dir', 'company.json'), { recursive: true }); // 읽기 실패(EISDIR) — 파일이 아닌 것
await call('unreadable', 'au-dir');
await mkdir(join(WS_ROOT, 'au-ok'), { recursive: true });
await writeFile(join(WS_ROOT, 'au-ok', 'company.json'), JSON.stringify({ id: 'au-ok', name: '정상' }));
await call('ok', 'au-ok');
await mkdir(join(WS_ROOT, 'au-linked'), { recursive: true });
await writeFile(join(WS_ROOT, 'au-linked', 'company.json'), JSON.stringify({ id: 'au-linked', name: '귀속', ownerId: 'someone' }));
await call('linked', 'au-linked'); // 게스트는 계정 귀속 회사에 못 들어간다 — 판정은 그대로
await call('badId', 'Bad Id!'); // 규칙 밖 id — 없음으로 본다
console.log(JSON.stringify(out));
