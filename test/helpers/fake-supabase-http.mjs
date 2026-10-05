// 가짜 Supabase(로컬 HTTP) — 동기화·기기 세션을 **실제 supabase-js 클라이언트째** 자식 프로세스로 돌릴 때 쓴다.
// 하는 일: 요청을 한 줄씩 센다(hits), 저장소는 메모리(업로드 multipart의 파일 부분만 보관), 요금제 RPC·사용자 조회에 답한다.
// 토큰 회전(/auth/v1/token)은 **한 번 쓴 refresh 토큰이 다시 오면 거절**한다 — GoTrue 재사용 감지의 엄격판(재사용 간격 0초).
// 실제 GoTrue는 간격(10초) 밖 재사용을 세션 가족 폐기로 처리한다(devicesession.mjs 2026-09-03 실사고).
import { createServer } from 'node:http';

export async function startFakeSupabase({ plan = 'pro', userId = 'u1', rejectUploads = false, refreshDelayMs = 0, syncIndex = null } = {}) {
  const hits = [];
  const store = new Map();
  const usedRefresh = new Set();
  const reused = [];
  let issued = 0;
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url, 'http://fake').pathname;
      hits.push({ t: Date.now(), k: `${req.method} ${path}` });
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (path === '/auth/v1/user') return json(200, { id: userId, email: `${userId}@example.test`, aud: 'authenticated', role: 'authenticated' });
        if (path === '/auth/v1/token') {
          const rt = JSON.parse(body.toString() || '{}').refresh_token;
          if (usedRefresh.has(rt)) {
            reused.push(rt);
            return json(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Invalid Refresh Token: Already Used' });
          }
          usedRefresh.add(rt);
          if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs)); // 회전 요청이 걸려 있는 동안 다른 프로세스가 끼어드는 창
          issued += 1;
          return json(200, {
            access_token: `at-${issued}`, refresh_token: `rt-${issued}`, token_type: 'bearer', expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: userId, email: `${userId}@example.test`, aud: 'authenticated', role: 'authenticated' },
          });
        }
        if (path.endsWith('/rpc/my_plan')) return json(200, { plan });
        // 동기화 색인(argo_sync_index) — syncIndex를 주면 세션 사용자 소유로 회사·tombstone 목록을 돌려준다. 안 주면 아래 일반 rpc처럼 null(종전 list 폴백).
        if (syncIndex && path.endsWith('/rpc/argo_sync_index')) return json(200, { owner: userId, companies: syncIndex.companies ?? [], tombstones: syncIndex.tombstones ?? [] });
        if (path.endsWith('/account_keys')) return json(200, [{ key_b64: Buffer.alloc(32, 1).toString('base64') }]);
        if (path.startsWith('/rest/v1/rpc/')) return json(200, null);
        if (path.startsWith('/rest/v1/')) return json(200, []);
        if (path.startsWith('/storage/v1/object/list/')) return json(200, []);
        if (path.startsWith('/storage/v1/object/')) {
          const key = decodeURIComponent(path.slice('/storage/v1/object/'.length)).replace(/^(authenticated|public)\//, '');
          if (req.method === 'GET') {
            if (!store.has(key)) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(store.get(key));
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            if (rejectUploads) return json(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
            const ct = String(req.headers['content-type'] ?? '');
            let data = body;
            if (ct.startsWith('multipart/form-data')) { // supabase-js는 Blob을 FormData('' 필드)로 보낸다
              const fd = await new Response(body, { headers: { 'content-type': ct } }).formData();
              data = Buffer.from(await fd.get('').arrayBuffer());
            }
            store.set(key, data);
            return json(200, { Key: key, Id: key });
          }
          if (req.method === 'DELETE') return json(200, []);
        }
        return json(404, { message: 'not found' });
      } catch (e) {
        return json(500, { message: String(e?.message ?? e) });
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url, hits, store, reused,
    count: (k, since = 0) => hits.filter((h) => h.k === k && h.t >= since).length,
    issued: () => issued,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
