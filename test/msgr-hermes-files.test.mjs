// 파일 보내기(20260930160000) — 유건 2026-09-30 "헤르메스 포함 외부 에이전트랑 내부 에이전트 모두 파일 송수신 등이 가능해야해".
// Hermes는 최종 답 글을 먼저 보내고 파일을 send_document·send_image_file·send_video·send_voice로 따로 부른다(v0.21.3 base.py _deliver_media_attachments).
// 승인 기준: 대화면 봇 답글에, 원문이 없으면(예약 작업) 결과 방의 봇 새 글에 붙는다, 파일당 25MB — 넘으면 방에 한 줄로 알린다.
// 실제 Python 어댑터로 돈다. 업로드 HTTP(createUpload → PUT → attachFile)는 로컬 HTTP 서버로 실제로 오간다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADAPTER = fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py', import.meta.url));
const CH = '11111111-1111-4111-8111-111111111111';

const PRELUDE = String.raw`
import asyncio, importlib.util, sys, types, tempfile, json, datetime
from pathlib import Path
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base', 'cron', 'cron.jobs', 'tools', 'tools.approval', 'hermes_time',
             'tools.approval_context', 'gateway.session_context']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
class Base:
    def __init__(self, **kwargs): self._message_handler = True; self.EVENTS = []; self._pending_messages = {}
    def _source_session_key(self, source): return 'sk:' + str(getattr(source, 'chat_id', ''))
    def build_source(self, **kw): return Box(**kw)
    async def handle_message(self, event): self.EVENTS.append((event, self._inbound.get()))
SESSION = {}
sys.modules['gateway.session_context'].get_session_env = lambda name, default='': SESSION.get(name, default)
sys.modules['tools.approval_context']._get_approval_mode = lambda: 'smart'
b = sys.modules['gateway.platforms.base']
b.BasePlatformAdapter = Base
b.MessageEvent = b.SendResult = Box
b.MessageType = Box(TEXT='text')
sys.modules['hermes_time'].get_timezone_name = lambda: 'Asia/Seoul'
cj = sys.modules['cron.jobs']; sys.modules['cron'].jobs = cj
cj.JOBS = []; cj.CALLS = []
cj.list_jobs = lambda include_disabled=False: [dict(j) for j in cj.JOBS]
def _upd(jid, u):
    cj.CALLS.append(('update', jid, u))
    for j in cj.JOBS:
        if j['id'] == jid: j.update(u)
cj.update_job = _upd
cj.pause_job = lambda jid, reason=None: cj.CALLS.append(('pause', jid)) or [j.update(state='paused', enabled=False) for j in cj.JOBS if j['id'] == jid]
cj.resume_job = lambda jid: cj.CALLS.append(('resume', jid))
cj.remove_job = lambda jid: cj.CALLS.append(('remove', jid))
ap = sys.modules['tools.approval']; sys.modules['tools'].approval = ap
ap.QUEUE = {}; ap.RESOLVED = []
ap.list_gateway_approvals = lambda sk: [dict(e) for e in ap.QUEUE.get(sk, [])]
sys.modules['gateway.run'] = types.ModuleType('gateway.run')
sys.modules['gateway.run']._redact_approval_command = lambda c: str(c or '').replace('SECRET', '***')
ap.WAITING = True
ap.resolve_gateway_approval = lambda sk, choice, resolve_all=False, reason=None, request_id=None: ap.RESOLVED.append((sk, choice, reason, request_id)) or (1 if ap.WAITING else 0)
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = m.ArgoMsgrAdapter(Box(extra={}))
tmp = tempfile.TemporaryDirectory()
a._outbox = Path(tmp.name) / 'outbox'
a._routines_file = Path(tmp.name) / 'routines.json'
a._agent_file = Path(tmp.name) / 'agent-approvals.json'
calls = []
RESP = {}
async def settle():
    while a._tasks: await asyncio.gather(*list(a._tasks))
async def api(method, params=None, **kwargs):
    calls.append((method, params))
    r = RESP.get(method)
    return r(params) if callable(r) else r
a._api = api
CH = '${CH}'
`;


const FAKE_UPLOAD = String.raw`
UP = []
def fake_upload(base, token, mid, path, name=None):
    UP.append((mid, path, name))
    return {'file_id': 'f-' + str(len(UP)), 'message_id': mid}
m._upload_file = fake_upload
a.base_url, a.token = 'http://x', 'argo_bot_t'
a._running = True
N = [900]
def post(params):
    N[0] += 1
    return {'message_id': N[0]}
RESP['sendMessage'] = post
work = Path(tmp.name) / 'work'; work.mkdir()
pdf = work / 'report.pdf'; pdf.write_bytes(b'%PDF-1.4 hello')
png = work / 'chart.png'; png.write_bytes(b'\x89PNG....')
def sent(): return [p for meth, p in calls if meth == 'sendMessage']
FINAL = {'notify': True}   # Hermes 최종 답 전달(_final_thread_metadata)
`;

function run(body) {
  const r = spawnSync('python3', ['-c', PRELUDE + FAKE_UPLOAD + body, ADAPTER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

test('업로드 HTTP — createUpload(서버 판정) → 서명 주소에 파일 바이트 PUT → attachFile. 25MB 초과는 요청 없이 413', () => {
  const r = spawnSync('python3', ['-c', String.raw`
import importlib.util, sys, types, json, threading, tempfile, os
from http.server import BaseHTTPRequestHandler, HTTPServer
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
b = sys.modules['gateway.platforms.base']; b.BasePlatformAdapter = object; b.MessageEvent = b.SendResult = dict; b.MessageType = type('T', (), {'TEXT': 'text'})
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
SEEN = []
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _body(self): return self.rfile.read(int(self.headers.get('Content-Length') or 0))
    def _json(self, obj):
        data = json.dumps({'ok': True, 'result': obj}).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        p = json.loads(self._body() or b'{}'); SEEN.append((self.path.rsplit('/', 1)[-1], p))
        if self.path.endswith('/createUpload'): self._json({'storage_path': 'o/c/7/bot-0a1b2c3d-report.pdf', 'upload_url': 'http://127.0.0.1:%d/upload?token=t' % srv.server_port, 'method': 'PUT'})
        else: self._json({'file_id': 'fid-1', 'message_id': p['message_id']})
    def do_PUT(self):
        SEEN.append(('PUT', self.path, self.headers.get('Content-Type'), self.headers.get('x-upsert'), self._body())); self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
srv = HTTPServer(('127.0.0.1', 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
d = tempfile.mkdtemp(); f = os.path.join(d, 'r.pdf'); open(f, 'wb').write(b'%PDF-bytes')
out = m._upload_file('http://127.0.0.1:%d' % srv.server_port, 'tok', 7, f, '보고서.pdf')
assert out == {'file_id': 'fid-1', 'message_id': 7}, out
assert SEEN[0] == ('createUpload', {'message_id': 7, 'file_name': '보고서.pdf', 'file_size': 10}), SEEN[0]
assert SEEN[1] == ('PUT', '/upload?token=t', 'application/pdf', 'false', b'%PDF-bytes'), SEEN[1]
assert SEEN[2] == ('attachFile', {'message_id': 7, 'storage_path': 'o/c/7/bot-0a1b2c3d-report.pdf', 'file_name': '보고서.pdf', 'mime_type': 'application/pdf'}), SEEN[2]
big = os.path.join(d, 'big.bin'); open(big, 'wb').truncate(25 * 1024 * 1024 + 1)
SEEN.clear()
try:
    m._upload_file('http://127.0.0.1:%d' % srv.server_port, 'tok', 7, big); raise SystemExit('초과인데 올렸다')
except m.ArgoMsgrError as e:
    assert e.status == 413
assert SEEN == [], '초과 파일은 서버에 묻지도 않는다'
srv.shutdown()
`, ADAPTER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('대화 — 최종 답 글을 보낸 뒤 오는 파일은 그 답글에 붙는다(이미지·영상·음성·문서 모두, file:// 포함)', () => run(String.raw`
async def main():
    inbound = {'message_id': 5, 'execution_attempt': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chat': {'id': CH}}
    a._pending[5] = inbound; a._inbound.set(inbound)
    r = await a.send(CH, '보고서를 첨부합니다.', reply_to='5', metadata={'notify': True})
    assert r.success and r.message_id == '901', r
    for fn, arg in [(a.send_document, str(pdf)), (a.send_image_file, str(png)), (a.send_video, str(pdf)), (a.send_voice, str(pdf)), (a.send_image, 'file://' + str(png))]:
        res = await fn(CH, arg, metadata=FINAL)
        assert res.success and res.message_id == '901', (fn, res)
    assert [u[0] for u in UP] == [901] * 5 and UP[0][2] == 'report.pdf', UP
    assert len(sent()) == 1, '파일 때문에 글이 더 생기지 않는다'
asyncio.run(main())
`));

test('대화 — 글 없이 파일만 낸 턴은 파일 이름으로 먼저 답을 마감하고(실행 행 닫힘) 그 답글에 붙인다', () => run(String.raw`
async def main():
    inbound = {'message_id': 5, 'execution_attempt': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chat': {'id': CH}}
    a._pending[5] = inbound; a._inbound.set(inbound)
    res = await a.send_document(CH, str(pdf), metadata=FINAL)
    assert res.success and res.message_id == '901', res
    p = sent()[0]
    assert p['text'] == '📎 report.pdf' and p['reply_to_message_id'] == 5 and p['execution_attempt'].startswith('aaaa') and p['disposition'] == 'done', p
    await a.send_document(CH, str(png), metadata=FINAL)
    assert [u[0] for u in UP] == [901, 901] and len(sent()) == 1
asyncio.run(main())
`));

test('원문 없음(예약 작업·send_message) — 방금 이 방에 쓴 봇 글에 붙고, 2분이 지났거나 설명이 따로 오면 새 글', () => run(String.raw`
async def main():
    r = await a.send(CH, '오늘의 브리프')
    assert r.message_id == '901' and 'reply_to_message_id' not in sent()[0]
    await a.send_document(CH, str(pdf)); await a.send_image_file(CH, str(png))
    assert [u[0] for u in UP] == [901, 901], UP
    a._posts[CH] = (901, m.time.monotonic() - 121)
    await a.send_document(CH, str(pdf))
    assert UP[-1][0] == 902 and sent()[-1] == {'chat_id': CH, 'text': '📎 report.pdf'}, sent()
    await a.send_document(CH, str(pdf), caption='주간 매출표')
    assert UP[-1][0] == 903 and sent()[-1] == {'chat_id': CH, 'text': '주간 매출표'}, '설명(caption)이 따로 오면 그 설명으로 새 글(짧은 결과는 Hermes가 글 대신 설명으로 보낸다)'
    await a.send_document('22222222-2222-4222-8222-222222222222', str(pdf))
    assert UP[-1][0] == 904, '다른 방은 그 방에 새 글'
asyncio.run(main())
`));

test('25MB 초과·업로드 실패 — 올리지 않고 방에 한 줄로 알린다(답이 있으면 새 글, 아직이면 그 줄이 답)', () => run(String.raw`
big = work / 'big.zip'
with open(big, 'wb') as f: f.truncate(25 * 1024 * 1024 + 1)
async def main():
    inbound = {'message_id': 5, 'execution_attempt': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chat': {'id': CH}}
    a._pending[5] = inbound; a._inbound.set(inbound)
    await a.send(CH, '결과입니다.', reply_to='5', metadata={'notify': True})
    res = await a.send_document(CH, str(big), metadata=FINAL)
    assert not res.success and UP == []
    assert sent()[-1] == {'chat_id': CH, 'text': '파일 big.zip은(는) 25MB를 넘어 올리지 못했습니다.'}, sent()[-1]
    def boom(*_a): raise m.ArgoMsgrError(409, 'Conflict: attach files within 1 hour of posting the message')
    m._upload_file = boom
    res = await a.send_document(CH, str(pdf), metadata=FINAL)
    assert not res.success and '올리지 못했습니다' in sent()[-1]['text'] and 'argo_bot_t' not in sent()[-1]['text']
asyncio.run(main())
a2 = m.ArgoMsgrAdapter(Box(extra={})); a2._outbox = Path(tmp.name) / 'o2'; a2._api = api; a2._running = True
async def fresh():
    inbound = {'message_id': 8, 'execution_attempt': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'chat': {'id': CH}}
    a2._pending[8] = inbound; a2._inbound.set(inbound)
    await a2.send_document(CH, str(big), metadata=FINAL)
    p = sent()[-1]
    assert p['reply_to_message_id'] == 8 and '25MB' in p['text'], '아직 답하지 않았으면 안내가 그 요청의 답이 된다(답이 없는 채로 남지 않게)'
asyncio.run(fresh())
`));

test('결재 재개 턴 — 파일은 후속 보고 글에 붙는다(후속 보고가 아직이면 파일 이름으로 올린다)', () => run(String.raw`
async def main():
    a._inbound.set({'followup': 'apf:ag-1', 'chat': {'id': CH}})
    res = await a.send_document(CH, str(pdf), metadata=FINAL)
    assert res.success and sent()[0] == {'approval_id': 'ag-1', 'text': '📎 report.pdf'} and UP[0][0] == 901, (sent(), UP)
    await a.send_document(CH, str(png), metadata=FINAL)
    assert UP[1][0] == 901 and len(sent()) == 1
asyncio.run(main())
`));

test('게이트웨이 밖 크론(standalone) — 결과 글을 쓰고 media_files를 그 글에 붙인다', () => run(String.raw`
async def fake_thread(fn, *args, **kw): return fn(*args, **kw)
m.asyncio.to_thread = fake_thread
POSTS = []
def call(base, token, method, params=None, post=False, timeout=30.0):
    POSTS.append((method, params)); return {'message_id': 777}
m._call = call
res = asyncio.run(m._standalone_send(Box(extra={'url': 'http://x', 'token': 't'}), CH, '주간 보고', media_files=[(str(pdf), False), (str(png), False)]))
assert res == {'success': True, 'message_id': '777'}, res
assert POSTS[0] == ('sendMessage', {'chat_id': CH, 'text': '주간 보고'}) and [u[0] for u in UP] == [777, 777], (POSTS, UP)
POSTS.clear(); UP.clear()
asyncio.run(m._standalone_send(Box(extra={'url': 'http://x', 'token': 't'}), CH, '', media_files=[(str(pdf), False)]))
assert POSTS[0][1]['text'] == '📎 report.pdf'
`));

// 유건 2026-09-30 "말 끝마다 MSGR Done 왜 붙이는거야?" — 모델이 표지를 문장 끝에 붙이면 그대로 보였다(운영: 효원·월터·보스웰 0.3.1).
test('표지 숨김 — 문장 끝 표지는 본문에서 떼고(판정은 done 기본), 독립 줄 표지는 종전대로 판정한다', () => run(String.raw`
r = m.relay_reply('파일 내용을 읽어 확인했습니다. ' + chr(96) + 'MSGR: done' + chr(96), {'execution_attempt': 'x'})
assert r['text'] == '파일 내용을 읽어 확인했습니다.' and r['disposition'] == 'done', r
r = m.relay_reply('@슈리 확인 부탁해요. MSGR: handoff', {'peers': [{'id': 'c1', 'name': '슈리'}]})
assert r['text'] == '@슈리 확인 부탁해요.' and r['disposition'] == 'done' and r['mentions'] == [], '문장 끝 handoff는 넘기지 않는다(판정은 독립 줄만)'
r = m.relay_reply('@슈리 확인 부탁해요.\nMSGR: handoff', {'peers': [{'id': 'c1', 'name': '슈리'}]})
assert r['disposition'] == 'handoff' and r['mentions'] == [{'kind': 'crew', 'id': 'c1'}], r
assert m.relay_reply('> 인용 MSGR: done', {})['text'] == '> 인용 MSGR: done'
assert m.followup_text('집행했습니다. MSGR: done') == '집행했습니다.'
`));

// 검수 M3 — 대화 중 send_message 도구(metadata에 notify 없음)로 같은 방에 파일을 보내도 그 요청의 답을 먼저 닫지 않는다.
test('대화 중 도구로 보낸 파일은 새 글에 붙고, 뒤에 오는 진짜 답은 그대로 그 요청의 답이 된다', () => run(String.raw`
async def main():
    inbound = {'message_id': 5, 'execution_attempt': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chat': {'id': CH}}
    a._pending[5] = inbound; a._inbound.set(inbound)
    res = await a.send_document(CH, str(pdf), metadata={'thread_id': 't'})
    assert res.success and sent()[0] == {'chat_id': CH, 'text': '📎 report.pdf'}, sent()
    r = await a.send(CH, '정리했습니다.', reply_to='5', metadata={'notify': True})
    assert r.success and sent()[-1]['reply_to_message_id'] == 5 and sent()[-1]['text'] == '정리했습니다.', sent()
asyncio.run(main())
`));

// 검수 M1 — 웹 주소 이미지는 어댑터가 내려받지 않는다(내부 주소 응답이 방에 올라갈 수 있다).
test('웹 주소 이미지는 받지 않고 주소를 글로 남긴다', () => run(String.raw`
def no_download(*_a): raise SystemExit('내려받으면 안 된다')
m._download = no_download
async def main():
    res = await a.send_image(CH, 'http://169.254.169.254/latest/meta-data/x.png', metadata=FINAL)
    assert res.success and UP == [] and sent()[-1] == {'chat_id': CH, 'text': 'http://169.254.169.254/latest/meta-data/x.png'}, sent()
asyncio.run(main())
`));

// 재검수 M2·M3 — 최종 답이 이미지 주소뿐이면 그 주소가 요청의 답이 되고, 답한 뒤 notify 없이 오는 파일(대기열 경로)은 그 답글에 붙는다.
test('최종 답이 웹 이미지 주소뿐이면 그 글이 답이 되고, 답한 뒤 notify 없이 온 파일은 그 답글에 붙는다(다른 글 아님)', () => run(String.raw`
async def main():
    a._posts[CH] = (800, m.time.monotonic())   # 2분 안에 쓴 다른 글 — 여기에 붙으면 안 된다
    inbound = {'message_id': 5, 'execution_attempt': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'chat': {'id': CH}}
    a._pending[5] = inbound; a._inbound.set(inbound)
    res = await a.send_image(CH, 'https://example.com/x.png', metadata=FINAL)
    assert res.success and sent()[-1]['reply_to_message_id'] == 5 and sent()[-1]['text'] == 'https://example.com/x.png', sent()
    assert 5 in a._replied
    await a.send_document(CH, str(pdf), metadata={'thread_id': 't'})
    assert UP[-1][0] == 901, UP
    res = await a.send_image(CH, 'https://example.com/y.png', metadata=FINAL)
    assert res.success and sent()[-1] == {'chat_id': CH, 'text': 'https://example.com/y.png'}, '이미 답했으면 주소는 새 글'
asyncio.run(main())
`));
