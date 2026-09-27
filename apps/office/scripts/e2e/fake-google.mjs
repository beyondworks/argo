// 가짜 Google(OAuth + Gmail API) — 오피스 메일 연결 흐름 전체를 로컬에서 시험한다(개발 전용). 실제 구글과 같은 모양의 요청·응답만 흉내 낸다.
// 다음 로그인의 신원·행동은 POST /control { email, name, hd, deny, dropScope, expire } 로 정한다. 기록은 GET /log, 외부 요청 흔적은 /hit*.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = +process.env.FAKE_GOOGLE_PORT || 58401;
const CLIENT = 'fake-client.apps.googleusercontent.com', SECRET = 'fake-secret';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'];
let control = { email: 'owner@gmail.example', name: '김유건', hd: null };
const codes = new Map(), refresh = new Map(), access = new Map(), log = [];
const boxes = new Map(), drafts = new Map();
const b64 = (s) => Buffer.from(s).toString('base64url');
const HIT = `http://127.0.0.1:${PORT}`;
function box(email) {
  if (!boxes.has(email)) {
    const html = `<h1>견적 확인</h1><p>안녕하세요, ${email} 님.</p><img src="https://tracker.example/pixel.png"><script>parent.document.title='HACKED'</script><a href="https://example.com">링크</a>`;
    // 공격 메일: 문서 이동(meta refresh·base), 끼워 넣기(link·form), 위험 링크(javascript:)
    const attack = `<p>본문 NAVTEST</p><meta http-equiv="refresh" content="1;url=${HIT}/hit-refresh"><base href="${HIT}/hit-base/"><a id="rel" href="x">rel</a><a id="js" href="javascript:alert(1)">js</a><link rel="stylesheet" href="${HIT}/hit-link.css"><form action="${HIT}/hit-form"><button>f</button></form>`;
    boxes.set(email, new Map([
      ['m1', { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: String(Date.now() - 3600e3), snippet: `FAKE-${email.split('@')[1]} 수정 견적 &amp; 일정`,
        headers: { From: '=?UTF-8?B?' + Buffer.from('박지현').toString('base64') + '?= <jihyun@hanbit.example>', To: email, Subject: `FAKE-${email.split('@')[1]} 수정 견적`, 'Message-ID': `<m1-${email}@hanbit.example>` },
        parts: [{ mimeType: 'text/html', body: { data: b64(html) } }, { mimeType: 'application/pdf', filename: '견적서.pdf', body: { attachmentId: 'A1', size: 5 } }] }],
      ['m2', { id: 'm2', threadId: 't2', labelIds: ['INBOX'], internalDate: String(Date.now() - 7200e3), snippet: '주간 보고',
        headers: { From: 'Ops <ops@corp.example>', To: email, Subject: `FAKE 주간 보고 ${email}` }, parts: [{ mimeType: 'text/plain', body: { data: b64('텍스트 본문입니다.') } }] }],
      ['m3', { id: 'm3', threadId: 't3', labelIds: ['INBOX'], internalDate: String(Date.now() - 10800e3), snippet: 'nav test',
        headers: { From: 'Evil <e@evil.example>', To: email, Subject: `NAVTEST ${email}` }, parts: [{ mimeType: 'text/html', body: { data: b64(attack) } }] }],
    ]));
  }
  return boxes.get(email);
}
const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d)); });
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
const payload = (m, full) => ({ mimeType: 'multipart/mixed', headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })), ...(full ? { parts: m.parts } : {}) });

http.createServer(async (req, res) => {
  const u = new URL(req.url, HIT);
  const p = u.pathname;
  if (p.startsWith('/hit')) { log.push({ t: 'hit', path: p }); res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>EVIL PAGE</h1>'); }
  if (p === '/control') { try { control = JSON.parse((await body(req)) || '{}'); } catch { return send(res, 400, { error: 'json' }); } return send(res, 200, { ok: true }); }
  if (p === '/log') return send(res, 200, { log });
  if (p === '/auth') {
    const q = u.searchParams;
    log.push({ t: 'auth', client: q.get('client_id'), redirect: q.get('redirect_uri'), scope: q.get('scope'), prompt: q.get('prompt'), access_type: q.get('access_type'), hint: q.get('login_hint'), pkce: q.get('code_challenge_method') });
    const back = new URL(q.get('redirect_uri'));
    if (q.get('client_id') !== CLIENT) back.searchParams.set('error', 'invalid_client');
    else if (control.deny) back.searchParams.set('error', control.deny);
    else {
      const code = randomUUID();
      codes.set(code, { email: q.get('login_hint') || control.email, challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), scope: control.dropScope ? SCOPES[0] : SCOPES.join(' ') });
      back.searchParams.set('code', code);
    }
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (p === '/token') {
    const f = new URLSearchParams(await body(req));
    if (f.get('client_id') !== CLIENT || f.get('client_secret') !== SECRET) return send(res, 401, { error: 'invalid_client' });
    if (f.get('grant_type') === 'authorization_code') {
      const c = codes.get(f.get('code')); codes.delete(f.get('code'));
      if (!c || c.redirect !== f.get('redirect_uri') || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return send(res, 400, { error: 'invalid_grant' });
      const r = randomUUID(), a = randomUUID();
      refresh.set(r, { email: c.email, revoked: false }); access.set(a, c.email);
      log.push({ t: 'token', email: c.email });
      const idt = `x.${b64(JSON.stringify({ aud: CLIENT, email: c.email, email_verified: true, name: control.name, ...(control.hd ? { hd: control.hd } : {}) }))}.x`;
      return send(res, 200, { access_token: a, refresh_token: r, expires_in: 3599, scope: `openid ${c.scope}`, id_token: idt });
    }
    const r = refresh.get(f.get('refresh_token'));
    if (!r || r.revoked || control.expire) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    const a = randomUUID(); access.set(a, r.email); log.push({ t: 'refresh', email: r.email });
    return send(res, 200, { access_token: a, expires_in: 3599, scope: SCOPES.join(' ') });
  }
  if (p === '/revoke') { const tok = new URLSearchParams(await body(req)).get('token'); if (refresh.has(tok)) refresh.get(tok).revoked = true; log.push({ t: 'revoke', ok: refresh.has(tok) }); return send(res, 200, {}); }
  if (p.startsWith('/gmail/')) {
    const email = access.get((req.headers.authorization ?? '').replace('Bearer ', ''));
    if (!email) return send(res, 401, { error: { code: 401 } });
    const mb = box(email), rest = p.replace('/gmail/v1/users/me', '');
    let m;
    if (rest === '/messages' && req.method === 'GET') {
      const label = u.searchParams.get('labelIds'), q = u.searchParams.get('q');
      const list = [...mb.values()].filter((x) => (label ? x.labelIds.includes(label) : q ? !['INBOX', 'SENT', 'DRAFT'].some((l) => x.labelIds.includes(l)) : true));
      return send(res, 200, { messages: list.map((x) => ({ id: x.id, threadId: x.threadId })) });
    }
    if (rest === '/messages/send' && req.method === 'POST') {
      const b = JSON.parse(await body(req)); const raw = Buffer.from(b.raw, 'base64url').toString();
      const id = `s${mb.size + 1}`; mb.set(id, { id, threadId: b.threadId ?? id, labelIds: ['SENT'], internalDate: String(Date.now()), snippet: 'sent', headers: { From: email, To: /^To: (.*)$/m.exec(raw)?.[1] ?? '', Subject: /^Subject: (.*)$/m.exec(raw)?.[1] ?? '' }, parts: [] });
      log.push({ t: 'send', email, threadId: b.threadId ?? null, raw }); return send(res, 200, { id });
    }
    if (req.method === 'GET' && (m = /^\/messages\/(\w+)$/.exec(rest))) { const x = mb.get(m[1]); if (!x) return send(res, 404, {}); return send(res, 200, { id: x.id, threadId: x.threadId, labelIds: x.labelIds, snippet: x.snippet, internalDate: x.internalDate, payload: payload(x, u.searchParams.get('format') === 'full') }); }
    if ((m = /^\/messages\/(\w+)\/modify$/.exec(rest))) {
      const x = mb.get(m[1]); const b = JSON.parse(await body(req));
      x.labelIds = [...new Set([...x.labelIds.filter((l) => !b.removeLabelIds.includes(l)), ...b.addLabelIds])];
      log.push({ t: 'modify', email, id: x.id, add: b.addLabelIds, remove: b.removeLabelIds }); return send(res, 200, { id: x.id, labelIds: x.labelIds });
    }
    if (/^\/messages\/\w+\/attachments\/\w+$/.test(rest)) return send(res, 200, { data: b64('%PDF-'), size: 5 });
    if (rest === '/drafts' && req.method === 'POST') { const id = `d${drafts.size + 1}`; drafts.set(id, { email, raw: JSON.parse(await body(req)).message.raw }); log.push({ t: 'draft.create', email, id }); return send(res, 200, { id }); }
    if ((m = /^\/drafts\/(\w+)$/.exec(rest))) {
      if (req.method === 'PUT') { drafts.get(m[1]).raw = JSON.parse(await body(req)).message.raw; log.push({ t: 'draft.update', id: m[1] }); return send(res, 200, { id: m[1] }); }
      if (req.method === 'DELETE') { drafts.delete(m[1]); log.push({ t: 'draft.delete', id: m[1] }); res.writeHead(204); return res.end(); }
    }
    return send(res, 404, {});
  }
  send(res, 404, {});
}).listen(PORT, '127.0.0.1', () => console.log(`fake google on ${PORT}`));
