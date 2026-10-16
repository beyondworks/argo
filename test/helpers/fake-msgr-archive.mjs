// 메신저 기록 옮기기 시험용 가짜 Supabase — 실제 supabase-js가 붙는 PostgREST(eq·gt·is·in·order·limit·최대 행 1000) + RPC + Storage(msgr 버킷).
// RLS는 "보이는 행만 넣는다"로 흉내 낸다(시험이 계정이 읽을 수 있는 것만 db에 둔다). 요청마다 { method, path, table, status, bytes }를 기록한다.
// fault(hit) → 숫자(상태 코드)를 돌려주면 그 응답을 낸다 — 서버 오류·권한 거부·첨부 실패를 시험이 고른다.
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';

const parseVal = (v) => v.replace(/^"|"$/g, '');
function match(row, k, v) {
  const i = v.indexOf('.'); const op = v.slice(0, i); const arg = v.slice(i + 1);
  const x = row[k];
  if (op === 'eq') return String(x) === arg;
  if (op === 'gt') return typeof x === 'number' ? x > Number(arg) : String(x) > arg;
  if (op === 'is') return arg === 'null' ? x == null : String(x) === arg;
  if (op === 'in') return arg.slice(1, -1).split(',').map(parseVal).includes(String(x));
  throw new Error(`fake: 모르는 연산 ${op}`);
}

export async function fakeMsgr(db = {}, { maxRows = 1000, fault = () => null } = {}) {
  const hits = [];
  const t = (name) => (db[name] ??= []);
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const hit = { method: req.method, path: u.pathname, url: decodeURIComponent(u.search), auth: String(req.headers.authorization ?? '').replace(/^Bearer /, ''), table: null, status: 200, bytes: 0 };
    hits.push(hit);
    hit.table = u.pathname.startsWith('/storage/') ? 'storage' : u.pathname.startsWith('/rest/v1/rpc/') ? `rpc:${u.pathname.slice('/rest/v1/rpc/'.length)}` : u.pathname.startsWith('/rest/v1/') ? u.pathname.slice('/rest/v1/'.length) : null;
    let body = '';
    for await (const ch of req) body += ch;
    const send = (status, payload, headers = {}) => {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
      hit.status = status; hit.bytes = buf.length;
      res.writeHead(status, { 'content-type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json', ...headers });
      res.end(buf);
    };
    const f = fault(hit); // 표 이름을 정한 뒤에 묻는다 — 시험이 표·주소로 오류를 고른다
    if (f) return send(f, { code: String(f), message: `fake fault ${f}`, statusCode: String(f) });
    if (u.pathname.startsWith('/storage/v1/object/msgr/')) {
      const path = decodeURIComponent(u.pathname.slice('/storage/v1/object/msgr/'.length));
      hit.table = 'storage';
      const file = db.files?.[path];
      return file ? send(200, file) : send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.slice('/rest/v1/rpc/'.length); hit.table = `rpc:${fn}`;
      const args = body ? JSON.parse(body) : {};
      if (fn === 'msgr_service_pause') {
        if (db.pause === 'missing') return send(404, { code: 'PGRST202', message: 'Could not find the function public.msgr_service_pause' });
        return send(200, db.pause ?? null);
      }
      if (fn === 'msgr_people_names') return send(200, (args.ids ?? []).filter((id) => db.people?.[id]).map((id) => ({ user_id: id, name: db.people[id] })));
      return send(404, { code: 'PGRST202', message: `no fake rpc ${fn}` });
    }
    if (!u.pathname.startsWith('/rest/v1/')) return send(404, { message: 'no route' });
    const table = u.pathname.slice('/rest/v1/'.length); hit.table = table;
    const q = u.searchParams;
    let rows = t(table).filter((r) => [...q.entries()].every(([k, v]) => (['select', 'order', 'limit', 'offset'].includes(k) ? true : match(r, k, v))));
    const order = (q.get('order') ?? '').split(',').filter(Boolean);
    for (const part of [...order].reverse()) {
      const [col, dir = 'asc'] = part.split('.');
      rows = [...rows].sort((a, b) => ((a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1)));
    }
    const limit = Math.min(q.has('limit') ? Number(q.get('limit')) : Infinity, maxRows);
    const cols = (q.get('select') ?? '*').split(',').map((c) => c.trim()).filter(Boolean);
    const page = rows.slice(0, limit).map((r) => (cols[0] === '*' ? r : Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
    send(200, page, { 'content-range': page.length ? `0-${page.length - 1}/*` : '*/*' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const client = createClient(url, 'test-anon-key', { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    client, db, hits, url,
    count: (pred = () => true) => hits.filter(pred).length,
    bytes: (pred = () => true) => hits.filter(pred).reduce((a, h) => a + h.bytes, 0),
    close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }), // keep-alive 연결까지 끊는다(남으면 시험 프로세스가 끝나지 않는다)
  };
}
