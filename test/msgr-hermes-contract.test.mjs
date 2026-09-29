// 크루 계약 1-a(2026-09-29) — Hermes 어댑터가 예약 작업을 메신저 "업무 > 자동화"에 미러하고, 메신저 편집을 Hermes 크론에
// 반영하고, 위험 명령 승인을 결재 카드로 주고받는지 실제 Python 어댑터로 돈다(게이트웨이·cron.jobs·tools.approval은 최소 흉내).
// 서버 판정은 test/msgr-ext-agent-contract-pg.test.mjs.
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

function run(body) {
  const r = spawnSync('python3', ['-c', PRELUDE + body, ADAPTER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

test('일정 변환 — 표현 가능한 cron은 daily/weekly/interval/once, 나머지는 raw(읽기 전용)', () => run(String.raw`
s = m.schedule_to_msgr
assert s({'kind':'cron','expr':'49 0 * * *'}, 'Asia/Seoul') == {'type':'daily','time':'00:49','times':['00:49'],'tz':'Asia/Seoul'}
assert s({'kind':'cron','expr':'0 9 * * 1,3,5'})['dows'] == [1,3,5]
assert s({'kind':'cron','expr':'0 9 * * 7'})['dows'] == [0], 'cron 7은 일요일(0)'
assert s({'kind':'cron','expr':'0 9,18 * * *'})['times'] == ['09:00','18:00']
assert s({'kind':'cron','expr':'0 9 * * 1-5', 'display':'평일 9시'})['type'] == 'raw', '범위는 raw'
assert s({'kind':'cron','expr':'*/7 * * * *'}) == {'type':'raw','expr':'*/7 * * * *','display':'*/7 * * * *'}
assert s({'kind':'interval','minutes':30}) == {'type':'interval','everyMinutes':30}
try:
    from zoneinfo import ZoneInfo; ZoneInfo('Asia/Seoul'); has_tz = True
except Exception:
    has_tz = False   # Windows Python은 tzdata가 기본으로 없다 — 그때는 시각을 틀리게 바꾸지 않고 raw(원문·읽기 전용)로 둔다
once = s({'kind':'once','run_at':'2026-10-01T00:30:00+00:00','display':'once at 2026-10-01 00:30'}, 'Asia/Seoul')
if has_tz:
    assert once == {'type':'once','date':'2026-10-01','time':'09:30','tz':'Asia/Seoul'}, once
else:
    assert once['type'] == 'raw' and once['display'] == 'once at 2026-10-01 00:30', once
import zoneinfo as _zi
_real = _zi.ZoneInfo
_zi.ZoneInfo = lambda k: (_ for _ in ()).throw(_zi.ZoneInfoNotFoundError(k))   # tzdata 없는 환경 흉내(Windows CI)
try:
    nz = s({'kind':'once','run_at':'2026-10-01T00:30:00+00:00','display':'once at 2026-10-01 00:30'}, 'Asia/Seoul')
    assert nz['type'] == 'raw' and nz['display'] == 'once at 2026-10-01 00:30', nz
finally:
    _zi.ZoneInfo = _real
c = m.msgr_to_cron_string
assert c({'type':'daily','time':'09:30'}) == '30 9 * * *'
assert c({'type':'weekly','times':['08:05'],'dows':[3,1]}) == '5 8 * * 1,3'
assert c({'type':'interval','everyMinutes':15}) == 'every 15m'
assert c({'type':'once','date':'2026-10-01','time':'09:00'}) is None
for expr in ['49 0 * * *', '5 8 * * 1,3']:
    assert c(s({'kind':'cron','expr':expr})) == expr, '왕복'
`));

test('미러 범위 — 메신저로 결과를 보내는 작업만 기본, MIRROR_ALL이면 보이되 고칠 수 없다(D2)', () => run(String.raw`
ch = m.job_msgr_channel
assert ch({'deliver':'local'}) is None
assert ch({'deliver':'argo_msgr:'+CH}) == CH
assert ch({'deliver':'origin','origin':{'platform':'argo_msgr','chat_id':CH}}) == CH
assert ch({'deliver':'origin','origin':{'platform':'telegram','chat_id':'1'}}) is None
assert ch({'deliver':'telegram,argo_msgr'}) == ''
# Hermes 목적지 판정이 있으면 그것을 따른다 — deliver=origin·출처 없음은 홈 채널로 대체될 수 있다(VPS 실측)
assert ch({'deliver':'origin'}, lambda j: [{'platform':'argo_msgr','chat_id':CH}]) == CH
assert ch({'deliver':'origin'}, lambda j: [{'platform':'telegram','chat_id':'1'}]) is None
assert ch({'deliver':'origin'}, lambda j: []) is None, '아무 데도 안 가면 메신저 작업 아님'
assert ch({'deliver':'argo_msgr:'+CH}, lambda j: []) == CH, '판정이 비면(플랫폼 등록 전) 명시한 argo_msgr는 문자열로 인정'
assert ch({'deliver':'argo_msgr:'+CH}, lambda j: (_ for _ in ()).throw(RuntimeError('x'))) == CH, '판정 함수가 실패하면 문자열로 대체'
assert m.job_to_row({'id':'o1','name':'n','prompt':'p','schedule':{'kind':'interval','minutes':30},'deliver':'origin'}, None, {}, resolve=lambda j: [{'platform':'argo_msgr','chat_id':CH}])['editable'] is True
local = {'id':'j1','name':'야간 핸드오버','prompt':'정리','schedule':{'kind':'cron','expr':'49 0 * * *'},'deliver':'local','enabled':True}
assert m.job_to_row(local, 'Asia/Seoul', {}) is None
row = m.job_to_row(local, 'Asia/Seoul', {}, mirror_all=True)
assert row['editable'] is False and row['channel_id'] is None
script = {'id':'j2','name':'','prompt':'','schedule':{'kind':'interval','minutes':60},'deliver':'argo_msgr:'+CH,'script':'x.sh'}
row = m.job_to_row(script, None, {})
assert row['editable'] is True and row['prompt'].startswith('(스크립트 작업') and row['title']
assert m.job_to_row({**script, 'state':'paused'}, None, {})['enabled'] is False
`));

test('지문은 실행 필드를 무시하고, 편집 판정은 서버가 본 지문 기준(없음=failed, 그 뒤 사람이 고침=superseded — 시계 비교 아님)', () => run(String.raw`
j = {'id':'j1','name':'a','prompt':'p','schedule':{'kind':'interval','minutes':5},'deliver':'local'}
assert m.job_fingerprint(j) == m.job_fingerprint({**j, 'last_run_at':'x', 'next_run_at':'y', 'last_status':'ok'})
assert m.job_fingerprint(j) != m.job_fingerprint({**j, 'prompt':'q'})
assert m.decide_routine_edit(None, {}) == 'failed'
assert m.decide_routine_edit(j, {'fp_sent': m.job_fingerprint(j)}) == 'apply', '메신저가 본 그대로면 적용'
assert m.decide_routine_edit({**j, 'prompt':'로컬 수정'}, {'fp_sent': m.job_fingerprint(j)}) == 'superseded', '메신저가 본 뒤 로컬에서 고쳤으면 버린다'
assert m.decide_routine_edit(j, {}) == 'apply', '기준이 없으면(첫 미러 전) 적용'
`));

test('미러 — 바뀐 게 없으면 네트워크 호출 0, 서버 행 수가 다르면 다음에 다시 보낸다, cron API가 없으면 unsupported 한 번', () => run(String.raw`
cj.JOBS[:] = [{'id':'j1','name':'보고','prompt':'정리','schedule':{'kind':'cron','expr':'0 9 * * *'},'deliver':'argo_msgr:'+CH,'enabled':True},
              {'id':'j2','name':'로컬','prompt':'p','schedule':{'kind':'interval','minutes':60},'deliver':'local','enabled':True}]
RESP['setRoutines'] = lambda p: {'kept': len(p.get('rows', [])), 'total': len(p.get('rows', []))}
async def go():
    await a._sync_routines()
    assert [c[0] for c in calls] == ['setRoutines'] and [r['ext_id'] for r in calls[0][1]['rows']] == ['j1'], calls
    await a._sync_routines()
    assert len(calls) == 1, '같은 스냅샷이면 호출하지 않는다'
    cj.JOBS[0]['last_run_at'] = '2026-09-29T09:00:00+09:00'; cj.JOBS[0]['last_status'] = 'ok'
    await a._sync_routines()
    assert len(calls) == 2 and calls[-1][1]['rows'][0]['status']['last_status'] == 'ok', '처음 상태는 보낸다'
    cj.JOBS[0]['last_status'] = 'error'
    await a._sync_routines()
    assert len(calls) == 2, '10분 안의 상태 변화만으로는 다시 쓰지 않는다'
    RESP['setRoutines'] = {'kept': 1, 'total': 0}
    cj.JOBS[0]['prompt'] = '정리 v2'
    await a._sync_routines(); await a._sync_routines()
    assert len(calls) == 4, '서버 total 불일치 → 다음 주기에 다시 보낸다'
    saved = cj.list_jobs
    del cj.list_jobs
    await a._sync_routines(); await a._sync_routines()
    assert calls[-1] == ('setRoutines', {'unsupported': 'This Hermes version does not expose cron.jobs (list/update/pause/resume/remove)'}) and len(calls) == 5, calls
    cj.list_jobs = saved
asyncio.run(go())
`));

test('편집 반영 — 끄기는 pause, 일정은 Hermes 문자열로, 메신저 전달 작업이 아니면 failed, 편집 뒤 사람이 고쳤으면 superseded', () => run(String.raw`
cj.JOBS[:] = [{'id':'j1','name':'보고','prompt':'정리','schedule':{'kind':'cron','expr':'0 9 * * *'},'deliver':'argo_msgr:'+CH,'enabled':True},
              {'id':'j2','name':'로컬','prompt':'p','schedule':{'kind':'interval','minutes':60},'deliver':'local','enabled':True}]
RESP['setRoutines'] = lambda p: {'kept': len(p.get('rows', [])), 'total': len(p.get('rows', []))}
RESP['routineEditDone'] = True
async def go():
    await a._handle_event({'event':'routine_edit','edit_id':'e1','ext_id':'j1','op':'update','patch':{'enabled':False,'schedule':{'type':'daily','time':'07:15'}},'created_at':'2026-09-29T09:00:00+00:00'})
    assert ('update','j1',{'schedule':'15 7 * * *'}) in cj.CALLS and ('pause','j1') in cj.CALLS, cj.CALLS
    done = [p for mth, p in calls if mth == 'routineEditDone']
    assert done[-1] == {'edit_id':'e1','status':'applied','error':None}
    assert calls[-1][0] == 'setRoutines', '반영 뒤 바로 미러'
    cj.CALLS.clear()
    await a._handle_event({'event':'routine_edit','edit_id':'e2','ext_id':'j2','op':'delete','patch':{},'created_at':'2026-09-29T09:00:00+00:00'})
    assert cj.CALLS == [] and [p for mth, p in calls if mth == 'routineEditDone'][-1]['error'] == 'not_editable'
    await a._handle_event({'event':'routine_edit','edit_id':'e3','ext_id':'gone','op':'delete','patch':{},'created_at':'2026-09-29T09:00:00+00:00'})
    assert [p for mth, p in calls if mth == 'routineEditDone'][-1] == {'edit_id':'e3','status':'failed','error':'routine_not_found'}
    assert a._rstate['j1']['fp_sent'] == m.job_fingerprint(cj.list_jobs(True)[0]), '반영한 편집은 기준 지문을 옮긴다(다음 편집이 superseded로 버려지지 않게)'
    await a._handle_event({'event':'routine_edit','edit_id':'e5','ext_id':'j1','op':'update','patch':{'title':'이어진 편집'},'created_at':'2026-09-29T09:00:01+00:00'})
    assert [p for mth, p in calls if mth == 'routineEditDone'][-1]['status'] == 'applied', '빠른 연속 편집도 적용(검수 M-4 b)'
    cj.CALLS.clear()
    cj.JOBS[0]['prompt'] = '로컬에서 사람이 고침'
    await a._handle_event({'event':'routine_edit','edit_id':'e4','ext_id':'j1','op':'update','patch':{'title':'옛 편집'},'created_at':'2026-09-29T11:00:00+00:00'})
    assert cj.CALLS == [] and [p for mth, p in calls if mth == 'routineEditDone'][-1]['status'] == 'superseded'
    def boom(p): raise m.ArgoMsgrError(403, 'Forbidden')
    RESP['routineEditDone'] = boom
    n = len(calls)
    try:
        await a._handle_event({'event':'routine_edit','edit_id':'e6','ext_id':'j1','op':'update','patch':{'enabled':True},'created_at':'2026-09-29T12:00:00+00:00'})
    except m.ArgoMsgrError:
        pass
    assert any(mth == 'setRoutines' for mth, _ in calls[n:]), 'done이 실패해도 반영 결과는 미러한다'
asyncio.run(go())
`));

test('위험 명령 결재 — 세션의 원문에 붙이고, 명령이 같은 요청 하나만 묶으며, 선점 ack 성공 때만 정확히 그 요청을 푼다', () => run(String.raw`
a._pending[5] = {'message_id':5,'execution_attempt':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chat':{'id':CH}}
a._pending[6] = {'message_id':6,'execution_attempt':'cccccccc-cccc-4ccc-8ccc-cccccccccccc','chat':{'id':CH}}
a._session_src['sk'] = 5   # 같은 채팅의 더 최근 원문(6)이 아니라 이 세션의 원문(5)에 붙어야 한다(검수 M-3)
ap.QUEUE['sk'] = [{'request_id':'rA','command':'ls /tmp'}, {'request_id':'rB','command':'rm -rf /srv/data'}]
RESP['requestApproval'] = lambda p: {'id':'x','message_id':77 if 'rm' in p['command'] else 78,'status':'pending','risk':'high'}
async def go():
    await a._send_exec_approval_prompt(Box(chat_id=CH, session_key='sk', command='ls /tmp', description='d'))
    method, params = calls[-1]
    assert method == 'requestApproval' and params['execution_attempt'] == 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ls_id = params['approval_id']
    assert a._approvals[ls_id]['request_id'] == 'rA', 'ls 카드는 ls 요청(rA)에 묶인다 — "마지막 요청"을 고르면 rm(rB)에 묶여 뒤바뀐다(검수 H-1)'
    res = await a._send_exec_approval_prompt(Box(chat_id=CH, session_key='sk', command='rm -rf /srv/data', description='dangerous'))
    assert res.success and res.message_id == '77'
    rm_id = calls[-1][1]['approval_id']
    assert a._approvals[rm_id]['request_id'] == 'rB'
    RESP['ackApproval'] = {'claimed': True, 'status': 'approved'}
    await a._handle_event({'event':'approval_decided','approval_id':ls_id,'status':'approved','resume':True})
    assert ap.RESOLVED == [('sk','once',None,'rA')], 'ls 카드 승인은 ls 요청만 푼다'
    RESP['ackApproval'] = {'claimed': False, 'status': 'approved'}
    await a._handle_event({'event':'approval_decided','approval_id':rm_id,'status':'approved','resume':True})
    assert len(ap.RESOLVED) == 1, '선점 못 한 이벤트는 재개하지 않는다'
    a._approvals['hx-2'] = {'session_key':'sk','request_id':'r2','card':'78'}
    RESP['ackApproval'] = {'claimed': True, 'status': 'approved'}
    await a._handle_event({'event':'approval_decided','approval_id':'hx-2','status':'approved','resume':False,'reason':'ai_consent'})
    assert ap.RESOLVED[-1] == ('sk','deny','Argo Messenger: ai_consent','r2'), '승인됐어도 재개 자격이 없으면 거절'
    ap.QUEUE['sk2'] = [{'request_id':'r1','command':'rm x'}, {'request_id':'r2b','command':'rm x'}]
    a._session_src['sk2'] = 5
    n = len(calls)
    amb = await a._send_exec_approval_prompt(Box(chat_id=CH, session_key='sk2', command='rm x', description='d'))
    assert amb.success is False and len(calls) == n, '같은 명령이 둘이면 하나로 못 정한다 → 글자 안내로(카드를 만들지 않는다)'
    none = await a._send_exec_approval_prompt(Box(chat_id=CH, session_key='unknown', command='x', description='d'))
    assert none.success is False, '세션의 원문이 없으면 글자 안내로'
    ap.QUEUE['sk3'] = [{'request_id':'r9','command':'curl -H SECRET x'}]; a._session_src['sk3'] = 5
    red = await a._send_exec_approval_prompt(Box(chat_id=CH, session_key='sk3', command='curl -H *** x', description='d'))
    assert red.success, 'Hermes가 가린 명령과도 같게 맞춘다'
asyncio.run(go())
`));

test('L-12 — edit_message를 재정의하지 않는다(Hermes가 도구 진행 말풍선을 켜서 채널에 진행 글이 올라가지 않게), 늦은 승인은 결정한 사람에게 후속 보고로 알린다(1-b)', () => run(String.raw`
assert 'edit_message' not in m.ArgoMsgrAdapter.__dict__
a._approvals['hx-late'] = {'session_key':'sk','request_id':'rL','card':'1'}
RESP['ackApproval'] = {'claimed': True, 'status': 'approved'}
ap.WAITING = False
import logging
got = []
class H(logging.Handler):
    def emit(self, r): got.append(r.getMessage())
m.logger.addHandler(H())
asyncio.run(a._handle_event({'event':'approval_decided','approval_id':'hx-late','status':'approved','resume':True}))
assert any('stopped waiting' in g for g in got), got
fu = [p for (mm, p) in calls if mm == 'sendMessage']
assert len(fu) == 1 and fu[0]['approval_id'] == 'hx-late' and '실행되지 않았습니다' in fu[0]['text'], fu
a._approvals['hx-rej'] = {'session_key':'sk','request_id':'rR','card':'1'}
asyncio.run(a._handle_event({'event':'approval_decided','approval_id':'hx-rej','status':'rejected','resume':False,'reason':'rejected'}))
assert len([1 for (mm, p) in calls if mm == 'sendMessage']) == 1, '늦은 반려는 알릴 것이 없다(어차피 실행 안 됨)'
`));

// ── 1-b(2026-09-29 유건 결정) — 누가 연결하든 같은 계약: 버전·모드 보고, 소유자 스위치, 보낼 곳 없는 작업의 방 지정, 에이전트 결재 ──
test('전달 상태 — 파일로 남기는 작업은 local, 보낼 곳 없는 작업(origin인데 출처 없음·판정 빈 목록)은 none, 메신저 작업은 표시 없음', () => run(String.raw`
assert m.job_delivery({'deliver':'local'}) == 'local'
assert m.job_delivery({'deliver':'origin'}) == 'none'
assert m.job_delivery({'deliver':'origin','origin':{'platform':'telegram','chat_id':'1'}}) == 'local'
assert m.job_delivery({'deliver':'origin'}, lambda j: []) == 'none', 'Hermes 판정이 빈 목록이면 보낼 곳 없음(VPS 실측 4건)'
assert m.job_delivery({'deliver':'telegram:1'}, lambda j: [{'platform':'telegram','chat_id':'1'}]) == 'local'
now = datetime.datetime.now(datetime.timezone.utc)
row = m.job_to_row({'id':'j','name':'야간','prompt':'p','schedule':{'kind':'cron','expr':'0 1 * * *'},'deliver':'origin'}, None, {}, True, now)
assert row['editable'] is False and row['status']['delivery'] == 'none'
row = m.job_to_row({'id':'k','name':'브리프','prompt':'p','schedule':{'kind':'cron','expr':'0 12 * * *'},'deliver':'argo_msgr:' + CH}, None, {}, False, now)
assert row['editable'] is True and 'delivery' not in row['status']
`));

test('보고 — 버전·실제 승인 모드는 바뀔 때만 보내고, 서버가 켠 "모든 예약 작업 보기"를 반영한 뒤 반영값을 다시 보고한다(환경 변수 불필요)', () => run(String.raw`
m._PLUGIN_VERSION = '0.3.0'
cj.JOBS[:] = [{'id':'j1','name':'야간','prompt':'p','schedule':{'kind':'cron','expr':'0 1 * * *'},'deliver':'local'}]
RESP['reportStatus'] = {'mirror_all': False}
RESP['setRoutines'] = lambda p: {'total': len(p['rows'])}
async def go():
    await a._report_status()
    assert calls[-1] == ('reportStatus', {'version':'0.3.0','approval_mode':'smart','mirror_all_applied':False})
    n = len(calls); await a._report_status(); assert len(calls) == n, '같으면 호출 0'
    RESP['reportStatus'] = {'mirror_all': True}
    sys.modules['tools.approval_context']._get_approval_mode = lambda: 'manual'
    await a._report_status()
    sent = [p for (mm, p) in calls if mm == 'setRoutines']
    assert sent and [r['ext_id'] for r in sent[-1]['rows']] == ['j1'] and sent[-1]['rows'][0]['editable'] is False, '켜면 파일 작업도 읽기 전용으로'
    assert calls[-1] == ('reportStatus', {'version':'0.3.0','approval_mode':'manual','mirror_all_applied':True}), calls[-1]
    RESP['reportStatus'] = {'mirror_all': False}   # 서버 설정이 꺼졌다(설정 이벤트와 보고 응답은 같은 값을 준다)
    await a._handle_event({'event':'config','mirror_all':False})
    assert a._mirror_all is False and [p for (mm, p) in calls if mm == 'setRoutines'][-1]['rows'] == []
asyncio.run(go())
`));

test('방 지정 — 보낼 곳 없는 작업은 channel_id만 받아 argo_msgr:<방>으로 바꾸고, 다른 필드나 파일 작업은 not_editable', () => run(String.raw`
cj.JOBS[:] = [{'id':'n1','name':'야간','prompt':'p','schedule':{'kind':'cron','expr':'0 1 * * *'},'deliver':'origin'},
              {'id':'l1','name':'로컬','prompt':'p','schedule':{'kind':'cron','expr':'0 2 * * *'},'deliver':'local'},
              {'id':'n2','name':'야간2','prompt':'p','schedule':{'kind':'cron','expr':'0 3 * * *'},'deliver':'origin'}]
RESP['setRoutines'] = lambda p: {'total': len(p['rows'])}
async def go():
    await a._apply_routine_edit({'edit_id':'e1','ext_id':'n1','op':'update','patch':{'channel_id':CH}})
    assert ('update','n1',{'deliver':'argo_msgr:' + CH}) in cj.CALLS
    assert [p for (mm, p) in calls if mm == 'routineEditDone'][-1]['status'] == 'applied'
    await a._apply_routine_edit({'edit_id':'e2','ext_id':'n2','op':'update','patch':{'channel_id':CH,'title':'x'}})
    assert [p for (mm, p) in calls if mm == 'routineEditDone'][-1]['error'] == 'not_editable'
    await a._apply_routine_edit({'edit_id':'e3','ext_id':'l1','op':'update','patch':{'channel_id':CH}})
    assert [p for (mm, p) in calls if mm == 'routineEditDone'][-1]['error'] == 'not_editable', '의도적으로 밖에 보내는 작업은 방 지정 대상 아님'
    await a._apply_routine_edit({'edit_id':'e4','ext_id':'n2','op':'update','patch':{'channel_id':'not-a-uuid'}})
    assert [p for (mm, p) in calls if mm == 'routineEditDone'][-1]['status'] == 'failed'
asyncio.run(go())
`));

test('에이전트 결재 — 도구는 메신저 대화에서만, 처리 중인 원문에 kind=agent로 올리고 파일에 남긴다', () => run(String.raw`
out = json.loads(m._approval_tool({'title':'광고비 집행'}))
assert 'error' in out, '어댑터가 없거나 메신저 대화가 아니면 거절'
m._ADAPTER = a
SESSION.update({'HERMES_SESSION_PLATFORM':'telegram','HERMES_SESSION_KEY':'sk'})
assert 'error' in json.loads(m._approval_tool({'title':'광고비 집행'})), '다른 플랫폼 세션'
SESSION['HERMES_SESSION_PLATFORM'] = 'argo_msgr'
assert 'error' in json.loads(m._approval_tool({'title':'광고비 집행'})), '처리 중인 원문이 없으면 거절'
a._pending[5] = {'message_id':5,'execution_attempt':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','chat':{'id':CH}}
a._session_src['sk'] = 5; a._session_source['sk'] = {'chat_id':CH,'chat_name':'dm','chat_type':'dm','thread_id':'argo-dm:' + CH + ':conversation','user_id':'u','user_name':'김'}
SESSION['HERMES_SESSION_MESSAGE_ID'] = '5'
posted = []
m._call = lambda base, token, method, params=None, **kw: posted.append((method, params)) or {'id':'x','message_id':90,'status':'pending'}
out = json.loads(m._approval_tool({'title':'광고비 집행','reason':'캠페인'}))
assert out['ok'] and out['status'] == 'pending' and out['approval_id'].startswith('ag-'), out
meth, p = posted[-1]
assert meth == 'requestApproval' and p['kind'] == 'agent' and p['execution_attempt'].startswith('aaaa') and p['title'] == '광고비 집행' and p['reason'] == '캠페인'
saved = json.loads(a._agent_file.read_text())
assert saved[out['approval_id']]['session_key'] == 'sk' and saved[out['approval_id']]['title'] == '광고비 집행'
b2 = m.ArgoMsgrAdapter(Box(extra={})); b2._agent_file = a._agent_file; b2._load_agent_approvals()
assert out['approval_id'] in b2._agent_approvals, '재시작 뒤에도 재개 정보가 남는다'
# 그룹 채널: 한 세션에 A(5)의 턴이 도는 동안 B(6)가 들어와 세션 기억이 6을 가리켜도, 이 턴의 메시지 id(5)로 A에 붙인다(OpenClaw 검수 H2와 같은 위험)
a._pending[6] = {'message_id':6,'execution_attempt':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','chat':{'id':CH}}; a._session_src['sk'] = 6
json.loads(m._approval_tool({'title':'A의 결재'}))
assert posted[-1][1]['execution_attempt'].startswith('aaaa'), posted[-1]
# 재개 턴(메시지 id 'apf:<부모>'): 실행 행이 없으니 승인된 부모 결재의 원문에 붙인다(검수 M-3)
SESSION['HERMES_SESSION_MESSAGE_ID'] = 'apf:ag-parent'
json.loads(m._approval_tool({'title':'이어서 메일 발송'}))
assert posted[-1][1].get('parent_approval_id') == 'ag-parent' and 'execution_attempt' not in posted[-1][1], posted[-1]
`));

test('재개 턴의 위험 명령 — 부모 결재 원문에 카드, 후속 보고를 올리면 부모 연결이 끝난다. 재개 대기는 폴 루프를 막지 않는다', () => run(String.raw`
ap.QUEUE['skR'] = [{'request_id':'rR','command':'rm -rf /tmp/ads'}]
a._resume_parent['skR'] = 'ag-parent'; a._resume_parent_at['skR'] = datetime.datetime.now().timestamp()
a._resume_parent['skOld'] = 'ag-old'; a._resume_parent_at['skOld'] = datetime.datetime.now().timestamp() - 3600
assert a._parent_for('skOld') is None and 'skOld' not in a._resume_parent, '30분 지난 부모 연결은 쓰지 않는다(재개 턴 실패로 후속 보고가 없어도)'
RESP['requestApproval'] = {'id':'x','message_id':91,'status':'pending'}
RESP['sendMessage'] = lambda p: {'message_id': 92}
async def go():
    res = await a._send_exec_approval_prompt(Box(chat_id=CH, session_key='skR', command='rm -rf /tmp/ads', description='d'))
    assert res.success and calls[-1][1]['parent_approval_id'] == 'ag-parent' and calls[-1][1]['command'] == 'rm -rf /tmp/ads', calls[-1]
    await a._post_followup('ag-parent', '정리했습니다.')
    assert 'skR' not in a._resume_parent, '후속 보고 뒤에는 이어서 올리지 않는다'
    src = {'chat_id':CH,'chat_name':'dm','chat_type':'dm','thread_id':'t','user_id':'u','user_name':'김'}
    a._agent_approvals['ag-busy'] = {'session_key':'skB','source':src,'title':'바쁜 대화'}
    a._pending_messages['skB'] = object()
    RESP['ackApproval'] = {'claimed': True, 'status': 'approved'}
    await asyncio.wait_for(a._handle_event({'event':'approval_decided','approval_id':'ag-busy','status':'approved','resume':True,'agent':True}), 1)
    assert a._tasks, '바쁜 세션을 기다리는 재개는 따로 돈다(폴 루프는 바로 돌아온다)'
    for t in list(a._tasks): t.cancel()
asyncio.run(go())
`));

test('보고 — 프로세스 전체 --yolo면 설정과 관계없이 off로 보고, 보낼 곳 없는 작업은 스위치 없이도 미러', () => run(String.raw`
m._PLUGIN_VERSION = '0.3.0'
ap._YOLO_MODE_FROZEN = True
RESP['reportStatus'] = {'mirror_all': False}
asyncio.run(a._report_status())
assert calls[-1][1]['approval_mode'] == 'off', calls[-1]
now = datetime.datetime.now(datetime.timezone.utc)
assert m.job_to_row({'id':'n','name':'야간','prompt':'p','schedule':{'kind':'cron','expr':'0 1 * * *'},'deliver':'origin'}, None, {}, False, now)['status']['delivery'] == 'none'
assert m.job_to_row({'id':'l','name':'로컬','prompt':'p','schedule':{'kind':'cron','expr':'0 1 * * *'},'deliver':'local'}, None, {}, False, now) is None, 'local은 스위치를 켰을 때만'
`));

test('에이전트 결재 결정 — 선점 ack 뒤 같은 대화로 재개하고, 그 턴의 최종 답만 후속 보고(한 번)로 보낸다. 반려·재개 불가·정보 없음 처리', () => run(String.raw`
src = {'chat_id':CH,'chat_name':'dm','chat_type':'dm','thread_id':'argo-dm:x','user_id':'u','user_name':'김'}
a._agent_approvals = {'ag-1': {'session_key':'sk:' + CH,'source':src,'title':'광고비 집행'}, 'ag-2': {'session_key':'sk2','source':src,'title':'증액'},
                      'ag-3': {'session_key':'sk3','source':src,'title':'삭제'}}
RESP['ackApproval'] = {'claimed': False, 'status': 'approved'}
RESP['sendMessage'] = lambda p: {'message_id': 501}
async def go():
    await a._handle_event({'event':'approval_decided','approval_id':'ag-1','status':'approved','resume':True,'agent':True,'decided_by_name':'유건'})
    await settle()
    assert a.EVENTS == [], '선점 못 하면 재개하지 않는다'
    a._agent_approvals['ag-1'] = {'session_key':'sk:' + CH,'source':src,'title':'광고비 집행'}
    RESP['ackApproval'] = {'claimed': True, 'status': 'approved'}
    await a._handle_event({'event':'approval_decided','approval_id':'ag-1','status':'approved','resume':True,'agent':True,'decided_by_name':'유건'})
    await settle()
    ev, ctx = a.EVENTS[-1]
    assert ev.internal is True and ev.message_id == 'apf:ag-1' and ev.metadata == {'gateway_session_key':'sk:' + CH}
    assert 'APPROVED by 유건' in ev.text and '광고비 집행' in ev.text and ctx['followup'] == 'apf:ag-1'
    assert 'ag-1' not in json.loads(a._agent_file.read_text()), '처리한 결재는 파일에서 지운다'
    a._running = True
    draft = await a.send(CH, '진행 중…', reply_to='apf:ag-1', metadata={})
    assert draft.success and not [1 for (mm, p) in calls if mm == 'sendMessage'], '초안·진행 글은 보내지 않는다'
    done = await a.send(CH, '집행했습니다.', reply_to='apf:ag-1', metadata={'notify': True})
    assert done.success and calls[-1] == ('sendMessage', {'approval_id':'ag-1','text':'집행했습니다.'})
    again = await a.send(CH, '또', reply_to='apf:ag-1', metadata={'notify': True})
    assert again.success is False, '후속 보고는 한 번만'
    await a._handle_event({'event':'approval_decided','approval_id':'ag-2','status':'rejected','resume':False,'reason':'rejected','agent':True,'decided_by_name':'유건'})
    await settle()
    assert 'REJECTED' in a.EVENTS[-1][0].text
    n = len(a.EVENTS)
    await a._handle_event({'event':'approval_decided','approval_id':'ag-3','status':'approved','resume':False,'reason':'ai_consent','agent':True})
    await settle()
    assert len(a.EVENTS) == n, '서버 재판정 실패(동의 철회 등)면 재개하지 않는다'
    await a._handle_event({'event':'approval_decided','approval_id':'ag-9','status':'approved','resume':True,'agent':True})
    await settle()
    assert calls[-1][0] == 'sendMessage' and calls[-1][1]['approval_id'] == 'ag-9' and '다시 말씀해' in calls[-1][1]['text'], '재개 정보를 잃었으면 사람에게 알린다'
asyncio.run(go())
`));

test('등록 — plugin.yaml 버전을 읽고 결재 도구를 argo_msgr 도구 묶음으로 등록한다', () => run(String.raw`
reg = {}
class Ctx:
    manifest = Box(version='0.3.0')
    def register_tool(self, **kw): reg['tool'] = kw
    def register_platform(self, **kw): reg['platform'] = kw
m.register(Ctx())
assert m._PLUGIN_VERSION == '0.3.0'
assert reg['tool']['name'] == 'argo_request_approval' and reg['tool']['toolset'] == 'argo_msgr' and reg['tool']['schema']['parameters']['required'] == ['title']
assert 'argo_request_approval' in reg['platform']['platform_hint']
class Old:
    def register_platform(self, **kw): reg['old'] = kw
m._PLUGIN_VERSION = ''
m.register(Old())
assert m._PLUGIN_VERSION == '0.3.0', '옛 Hermes(manifest·register_tool 없음)도 plugin.yaml에서 버전을 읽고 연결은 된다'
`));

test('폴 루프 — 이벤트는 처리하되 offset은 메시지만 올리고, getUpdates는 events=1로 부른다', () => run(String.raw`
seen = []
async def dispatch(msg): seen.append(msg.get('message_id'))
async def handle(ev): seen.append(ev.get('event'))
a._dispatch = dispatch; a._handle_event = handle
async def flush(): return None
a._flush_outbox = flush
n = {'i': 0}
async def api2(method, params=None, **kw):
    calls.append((method, params)); n['i'] += 1
    if n['i'] == 1: return [{'event':'routine_edit','edit_id':'e'}, {'update_id':41,'message':{'message_id':41}}]
    a._running = False; return []
a._api = api2; a._running = True
asyncio.run(a._poll_loop())
assert calls[0][1]['events'] == 1 and calls[0][1]['delivery_protocol'] == 1
assert seen == ['routine_edit', 41] and a._offset == 42
`));

test('D5 — 다른 봇이 전달한 글은 프롬프트 첫 줄에 전달한 동료를 밝힌다(사람의 직접 지시로 착각하지 않게)', () => run(String.raw`
base = {'text':'각자 자동화를 확인해 주세요', 'peers':[], 'context':[]}
assert m.relay_prompt({**base, 'relayed_by':'효원 - v'}).startswith('[Forwarded by colleague @효원 - v')
assert m.relay_prompt(base).startswith('각자 자동화를 확인해 주세요')
`));
