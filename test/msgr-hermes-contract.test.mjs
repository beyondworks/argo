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
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base', 'cron', 'cron.jobs', 'tools', 'tools.approval', 'hermes_time']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
class Base:
    def __init__(self, **kwargs): self._message_handler = True
    def _source_session_key(self, source): return 'sk:' + str(getattr(source, 'chat_id', ''))
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
calls = []
RESP = {}
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

test('L-12 — edit_message를 재정의하지 않는다(Hermes가 도구 진행 말풍선을 켜서 채널에 진행 글이 올라가지 않게), 늦은 결정은 기록만', () => run(String.raw`
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
