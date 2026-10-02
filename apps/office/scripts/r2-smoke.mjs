// R2 실측(설계안 13장 '확인하지 못한 것'을 실제 버킷으로 닫는다) — argo-office 버킷의 _probe/<무작위>/ 아래만 쓰고, 끝나면 모두 지운 뒤 비었는지 LIST로 확인한다.
// 실행(값은 출력하지 않는다): ( set -a; . <레포>/.env.local; set +a; node apps/office/scripts/r2-smoke.mjs )
// 필요한 환경 변수: R2_ENDPOINT · R2_OFFICE_BUCKET · R2_OFFICE_ACCESS_KEY_ID · R2_OFFICE_SECRET_ACCESS_KEY
// 출력에는 상태 코드·오류 코드(<Code>)·헤더 이름만 — 서명 주소·키·응답 본문 원문은 남기지 않는다(SignatureDoesNotMatch 본문에는 접근 키 ID가 들어 있을 수 있다).
import { randomUUID } from 'node:crypto';
import { r2FromEnv, presignUrl } from '../server/r2.js';

const env = process.env;
const r2 = r2FromEnv(env);
const PREFIX = `_probe/${randomUUID()}/`;
const results = [];
const note = (item, result, evidence) => { results.push({ item, result, evidence }); console.log(`- ${item}: ${result} (${evidence})`); };
const code = async (r) => { const t = await r.text().catch(() => ''); return /<Code>([^<]{1,80})<\/Code>/.exec(t)?.[1] ?? '-'; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const bytes = (n, fill = 97) => new Uint8Array(n).fill(fill);
const objectUrl = (key) => `${env.R2_ENDPOINT.replace(/\/+$/, '')}/${encodeURIComponent(env.R2_OFFICE_BUCKET)}/${key.split('/').map(encodeURIComponent).join('/')}`;
const putUrl = (key, len, type = 'application/pdf', expires = 300) => r2.presign({ method: 'PUT', key, contentType: type, contentLength: len, expires });

try {
  // 1. 정상 올리기·HEAD
  const a = `${PREFIX}a.pdf`;
  let p = await putUrl(a, 10);
  let r = await fetch(p.url, { method: 'PUT', headers: p.headers, body: bytes(10) });
  note('서명 크기와 같은 PUT', `HTTP ${r.status}`, `etag 헤더 ${r.headers.has('etag') ? '있음' : '없음'}`); await r.arrayBuffer();
  const h = await r2.head(a);
  note('HEAD 응답(크기·etag)', h ? `크기 ${h.bytes}, etag ${h.etag ? `${h.etag.length}자` : '없음'}, 형식 ${h.mime}` : '없음', 'r2.head');

  // 2. if-none-match: * — 같은 키에 두 번째 PUT
  p = await putUrl(a, 10);
  r = await fetch(p.url, { method: 'PUT', headers: p.headers, body: bytes(10, 98) });
  note('if-none-match: * 두 번째 PUT', `HTTP ${r.status}`, `Code ${await code(r)}`);
  const after = await r2.get(a);
  note('두 번째 PUT 뒤 내용', after[0] === 97 ? '첫 내용 그대로' : '바뀜', `첫 바이트 ${after[0]}`);

  // 3. 서명된 content-length와 다른 크기(브라우저처럼 실제 몸체 길이로 Content-Length가 붙는다)
  for (const [signed, sent] of [[10, 11], [10, 9], [10, 0]]) {
    const k = `${PREFIX}len-${signed}-${sent}.pdf`;
    p = await putUrl(k, signed);
    r = await fetch(p.url, { method: 'PUT', headers: p.headers, body: bytes(sent) });
    const c = await code(r);
    const stored = await r2.head(k);
    note(`content-length 서명 ${signed} · 보낸 ${sent}바이트`, `HTTP ${r.status}`, `Code ${c}, 객체 ${stored ? `생김(${stored.bytes}바이트)` : '없음'}`);
  }

  // 4. 서명된 content-type과 다른 형식
  p = await putUrl(`${PREFIX}type.pdf`, 4, 'application/pdf');
  r = await fetch(p.url, { method: 'PUT', headers: { ...p.headers, 'content-type': 'image/png' }, body: bytes(4) });
  note('content-type 다르게 PUT', `HTTP ${r.status}`, `Code ${await code(r)}`);

  // 5. 만료 뒤 거절(GET·PUT 1초 주소, 3초 뒤)
  const g1 = await r2.presign({ method: 'GET', key: a, expires: 1 });
  const p1 = await putUrl(`${PREFIX}expired.pdf`, 3, 'application/pdf', 1);
  r = await fetch(g1.url); note('만료 전 GET(1초 주소)', `HTTP ${r.status}`, 'presign GET expires=1'); await r.arrayBuffer();
  await sleep(3000);
  r = await fetch(g1.url); note('만료 뒤 GET', `HTTP ${r.status}`, `Code ${await code(r)}`);
  r = await fetch(p1.url, { method: 'PUT', headers: p1.headers, body: bytes(3) }); note('만료 뒤 PUT', `HTTP ${r.status}`, `Code ${await code(r)}`);

  // 6. 정상 GET·없는 키 DELETE·있는 키 DELETE
  const g = await r2.presign({ method: 'GET', key: a });
  r = await fetch(g.url); const got = new Uint8Array(await r.arrayBuffer());
  note('GET 서명 주소(10분)', `HTTP ${r.status}`, `${got.length}바이트`);
  const nx = await presignUrl({ url: objectUrl(`${PREFIX}none.pdf`), method: 'DELETE', expires: 60, accessKeyId: env.R2_OFFICE_ACCESS_KEY_ID, secretAccessKey: env.R2_OFFICE_SECRET_ACCESS_KEY });
  r = await fetch(nx, { method: 'DELETE' }); note('없는 키 DELETE', `HTTP ${r.status}`, `Code ${r.status === 204 ? '-' : await code(r)}`);

  // 6-1. 응답 헤더 덮어쓰기(검수 9 — html·svg 같은 활성 형식을 내려받기로): response-content-disposition 지원 여부
  const hk = `${PREFIX}x.html`;
  await r2.put(hk, new TextEncoder().encode('<b>x</b>'), { contentType: 'text/html' });
  const att = await r2.presign({ method: 'GET', key: hk, attachment: true });
  r = await fetch(att.url); await r.arrayBuffer();
  note('GET response-content-disposition=attachment', `HTTP ${r.status}`, `content-disposition ${r.headers.get('content-disposition') ?? '없음'}, 형식 ${r.headers.get('content-type')}`);

  // 7. 브라우저 CORS — 지금 버킷 설정 그대로 사전 요청(OPTIONS)과 GET의 Access-Control-Allow-Origin
  for (const origin of ['https://argo-office.vercel.app', 'http://localhost:5190', 'tauri://localhost']) {
    const pre = await putUrl(`${PREFIX}cors.pdf`, 4);
    r = await fetch(pre.url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,if-none-match' } });
    const acao = r.headers.get('access-control-allow-origin'); await r.arrayBuffer();
    const gr = await fetch(g.url, { headers: { origin } }); const gacao = gr.headers.get('access-control-allow-origin'); await gr.arrayBuffer();
    note(`CORS ${origin}`, `사전 요청 HTTP ${r.status}, 허용 출처 ${acao ? '있음' : '없음'} / GET 허용 출처 ${gacao ? '있음' : '없음'}`, 'OPTIONS(PUT, content-type·if-none-match) + GET Origin');
  }
} catch (e) {
  note('실측 중단', 'error', String(e?.code ?? e?.message ?? e).slice(0, 80));
} finally {
  // 8. 정리 — 접두 아래를 모두 지우고 LIST로 비었는지
  const keys = await r2.list(PREFIX).catch(() => []);
  for (const k of keys) await r2.del(k).catch(() => {});
  const left = await r2.list(PREFIX).catch(() => null);
  const probeLeft = await r2.list('_probe/').catch(() => null);
  note('정리', `지운 객체 ${keys.length}개, 남은 객체 ${left?.length ?? '확인 실패'}개`, `LIST ${PREFIX.slice(0, 7)}…(이번 접두) / _probe/ 전체 ${probeLeft?.length ?? '확인 실패'}개`);
}
