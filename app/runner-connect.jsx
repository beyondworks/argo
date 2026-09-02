'use client';
// AI 러너 연결 카드(BYOK/BYOA) — 설정(회사 스코프)과 온보딩(계정 스코프)이 공유하는 단일 구현.
// ws가 ACCOUNT_WS('@account')면 회사 생성 전 계정 자격(/api/account/keys)에 저장되고,
// 회사 생성 시 seedRunnerCreds가 새 회사 .secrets.json으로 복사한다(백엔드 src/runners.mjs 참조).
import { useEffect, useRef, useState } from 'react';
import { Icon, Skeleton, Spinner, ConfirmModal, api } from './ui';
import { useLang } from './i18n';

/** 계정 스코프 라우팅 토큰 — keysBase가 이 값이면 /api/account/keys로 보낸다(경로 분기용).
    실제 저장 스코프는 서버가 currentUser().id로 결정하므로(사용자별 파일 격리) 이 값은 백엔드와 일치할 필요가 없다. */
export const ACCOUNT_WS = '@account';
const keysBase = (ws) => (ws === ACCOUNT_WS ? '/api/account/keys' : `/api/companies/${ws}/keys`);

/** 공용 입력 스타일 — 설정 페이지 폼들과 러너 카드가 공유. */
export const fieldStyle = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, width: '100%' };

// 가용 판정(순수)은 runner-usable.mjs로 분리 — 데크 배너·홈 안내·온보딩 게이트·회귀 테스트가 공유.
// 기존 소비처(import from './runner-connect') 호환을 위해 재수출한다.
export { anyRunnerUsable, runnerNeedsReconnect, usableRunnerNames, PICK_ORDER } from './runner-usable.mjs';
import { lastTurnByRunner, lastHealthFailByRunner, healthFailMessageKey } from './runner-usable.mjs';

/** AI 연결(러너별 BYOK/BYOA) — 4러너(Claude·Codex·Gemini·GLM) 각각을 회사 계정에 연결하는 관문.
    러너마다 (a) 상태 칩(회사 연결됨/이 컴퓨터 로그인/미연결) (b) 인증 방식 선택(API키·OAuth)
    (c) 방식별 입력·저장·검증·제거 또는 CLI 로그인 안내. 응답엔 마스킹만 실린다(보안 규칙). */
const RUNNER_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', glm: 'GLM', kimi: 'Kimi', openrouter: 'OpenRouter', grok: 'Grok' };
// 화면에 그릴 순서 — **이 목록에 없으면 카드가 아예 안 뜬다**(러너를 추가하고 여기를 빠뜨리면
// 연결 수단이 UI에서 사라진다. 분리 검수 2026-08-03이 grok 누락으로 실제 적발).
// test/runner-order-sync.test.mjs가 RUNNER_AUTH(숨김 제외)와의 동기화를 잠근다. gemini는 숨김(카탈로그 hidden — 유건 결정 2026-09-03).
const RUNNER_ORDER = ['claude', 'codex', 'antigravity', 'glm', 'kimi', 'openrouter', 'grok'];

export function AiConnectionCard({ ws, accordion = false }) {
  const { t } = useLang();
  const [runners, setRunners] = useState(null); // { [id]: status } | null(로딩)
  const [openId, setOpenId] = useState(null);   // accordion 모드 — 한 번에 한 러너만 펼친다

  // 마지막 턴 상태(P1-1) — 활동 이벤트의 type:turn + runner에서 러너별 최신 1건.
  // "연결됨" 초록불이 실사용 실패를 가리던 갭(계획서 P1): 카드가 실측 사실을 함께 보여준다.
  // 계정 스코프(온보딩 — ws가 회사가 아님)나 이벤트 부재는 조용히 생략(관용).
  const [lastTurns, setLastTurns] = useState({}); // { [runner]: { ok, aborted } }
  const [healthFails, setHealthFails] = useState({}); // { [runner]: { ok:false, reason } } — 주기 검진(P1-2)
  function load() {
    api(`${keysBase(ws)}`).then((d) => setRunners(d.runners ?? {})).catch(() => setRunners({}));
    if (!ws || ws === ACCOUNT_WS) return; // 온보딩(계정 스코프)엔 활동이 없다 — 매번 404 요청 방지(검수 L2)
    api(`/api/companies/${ws}/activity`).then((d) => {
      setLastTurns(lastTurnByRunner(d.events));
      setHealthFails(lastHealthFailByRunner(d.events));
    }).catch(() => {});
  }
  useEffect(load, [ws]);

  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="card-title">{t('settings.runners.title')}</span>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 6px', lineHeight: 1.6 }}>{t('settings.runners.help')}</p>
      {!runners ? <Skeleton h={180} /> : RUNNER_ORDER.map((id, i) => (
        <RunnerRow key={id} ws={ws} id={id} st={runners[id]} onChange={load} first={i === 0} lastTurn={lastTurns[id]} healthFail={healthFails[id]}
          {...(accordion ? { open: openId === id, onToggle: () => setOpenId(openId === id ? null : id) } : {})} />
      ))}
      {/* 숨김 러너(gemini)는 카드가 없다 — 단, 저장된 연결이 남아 있으면 "제공 종료 · 해제만" 행으로 보인다(검수 MEDIUM-4:
          벤더 자격을 앱에서 볼 수도 지울 수도 없던 상태 방지). 해제하면 이 행도 사라진다. */}
      {runners && Object.keys(runners).filter((id) => runners[id]?.hidden && runners[id]?.company?.connected).map((id) => (
        <RunnerRow key={id} ws={ws} id={id} st={runners[id]} onChange={load} first={false} lastTurn={lastTurns[id]} healthFail={healthFails[id]} retired
          {...(accordion ? { open: openId === id, onToggle: () => setOpenId(openId === id ? null : id) } : {})} />
      ))}
    </div>
  );
}

/** 러너 1행 — 상태 칩 + 방식 탭 + (API키/붙여넣기 토큰 입력) 또는 (CLI 로그인 안내).
    onToggle이 오면 아코디언 모드(온보딩) — 헤더만 보이고 클릭으로 본문을 펼친다. 설정은 기존 그대로. */
function RunnerRow({ ws, id, st, onChange, first, open = true, onToggle = null, lastTurn = null, healthFail = null, retired = false }) {
  const { t, fmtMoney } = useLang();
  const methods = st?.methods ?? ['apikey'];
  const hasOauth = methods.includes('oauth');
  const oauthPaste = !!st?.oauthPasteable;
  const connectable = !!st?.connectable;
  const company = st?.company ?? { connected: false };
  const [method, setMethod] = useState(company.connected ? company.type : 'apikey');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState('');
  const busyWasHost = useRef(false); // 마지막 msg가 host 옵트인에서 났는지(렌더 자리 선택)
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false); // 러너 연결 제거 확인(전 기기·전 크루 영향)
  const [verifyMsg, setVerifyMsg] = useState(''); // 연결 확인(P1-2) 결과 — 공유 msg는 갈래별 출구가 달라 전용 상태로(그록 갈래 무출구 실측)
  const [verifyOk, setVerifyOk] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef(null);   // setInterval 핸들
  const pollN = useRef(0);        // 폴링 횟수 (최대 60 = 약 2분)
  const alive = useRef(true);     // 언마운트 후 stale setState 차단

  // Claude 웹 브리지 — 버튼 → 로그인 URL 표시 → 승인 코드 제출 → 회사 자격 저장(전 기기 동기화)
  const [webUrl, setWebUrl] = useState('');
  const [webCode, setWebCode] = useState('');
  // 기기 코드(Grok) — 붙여넣을 것이 없고 **보여줄 것**이 있다. 사용자가 그 주소에 이 코드를 넣으면
  // 서버 폴링이 승인을 잡아 저장까지 끝낸다(콜백 리스너 없음 — 상주·헤드리스에서도 같게 돈다).
  const [webUserCode, setWebUserCode] = useState('');
  const [device, setDevice] = useState(null); // { interval, expiresIn } — 기기 코드 흐름의 폴링 규약
  const [webBusy, setWebBusy] = useState(false);
  const [webMsg, setWebMsg] = useState('');
  const [webOk, setWebOk] = useState(false);
  async function webStart() {
    setWebBusy(true); setWebMsg(''); setWebOk(false);
    try {
      const r = await fetch(`${keysBase(ws)}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runner: id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.reason === 'no-cli' ? t('settings.runners.webNoCli') : (d.detail || d.reason || 'failed'));
      setWebUrl(d.url); setWebUserCode(d.userCode ?? ''); setWebOk(true);
      setDevice(d.userCode ? { interval: Number(d.interval) > 0 ? Number(d.interval) : 5, expiresIn: Number(d.expiresIn) > 0 ? Number(d.expiresIn) : 1800 } : null);
      setWebMsg(t(d.userCode ? 'settings.runners.deviceReady' : 'settings.runners.webUrlReady'));
    } catch (e) { setWebMsg(String(e.message)); } finally { setWebBusy(false); }
  }
  // 웹 브리지 자동 수신 폴링 — 서버의 로컬 콜백 리스너가 승인 코드를 받아 저장을 끝내면
  // 여기서 잡아 "연결됨"으로 전환한다(주소 복사·붙여넣기 없이 완료 — 실사용 신고 2026-07-19).
  // 리스너가 못 떠도(포트 선점·호스팅) 이 폴링은 무해하고, 아래 붙여넣기 폴백이 그대로 동작한다.
  useEffect(() => {
    if (!webUrl) return;
    let liveFlag = true;
    let timer = null;
    // 기기 코드는 **폴링이 유일한 수확 경로**다(콜백형과 달리 서버 리스너가 없다). 그래서
    //  · 주기는 제공자가 준 interval을 지키고(고정 2초로 두들기면 RFC 8628 §3.5 위반 —
    //    제공자가 slow_down·코드 무효화로 응수하면 연결이 원인 불명으로 실패한다),
    //  · slow_down을 받으면 5초 더 늦추며,
    //  · 수명은 코드 만료(실측 30분)까지 — 10분에 끊으면 늦게 승인한 사용자의 토큰이 영영 안 온다,
    //  · 실패 사유(expired·access_denied…)를 화면에 올린다. 예전엔 전부 버려 무한 스피너였다.
    // (분리 검수 2026-08-03 M-4·M-5)
    let waitMs = Math.max(2000, (device?.interval ?? 2) * 1000);
    const deadline = Date.now() + (device?.expiresIn ?? 600) * 1000;
    const tick = async () => {
      if (!liveFlag) return;
      if (Date.now() > deadline) { setWebOk(false); setWebMsg(t('settings.runners.deviceExpired')); return; }
      try {
        const d = await (await fetch(`${keysBase(ws)}/connect?runner=${encodeURIComponent(id)}`)).json();
        if (!liveFlag) return;
        if (d.authed) {
          setWebOk(true); setWebMsg(t('settings.runners.connected'));
          setWebUrl(''); setWebCode(''); setWebUserCode(''); setDevice(null);
          window.dispatchEvent(new Event('argo:refresh'));
          onChange();
          return;
        }
        if (d.slowDown) waitMs += 5000;
        // pending이 아닌 사유 = 진짜 실패다. 계속 돌면 사용자는 영원히 기다린다.
        if (d.reason && !d.pending) { setWebOk(false); setWebMsg(t('settings.runners.deviceFailed', { reason: d.reason })); return; }
      } catch { /* 다음 틱 재시도 */ }
      timer = setTimeout(tick, waitMs);
    };
    timer = setTimeout(tick, waitMs);
    return () => { liveFlag = false; if (timer) clearTimeout(timer); };
  }, [webUrl, device]);

  async function webSubmit() {
    setWebBusy(true); setWebMsg('');
    try {
      const r = await fetch(`${keysBase(ws)}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runner: id, code: webCode.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.detail || d.reason || 'failed');
      setWebOk(true); setWebMsg(t('settings.runners.connected'));
      setWebUrl(''); setWebCode(''); setWebUserCode('');
      window.dispatchEvent(new Event('argo:refresh'));
      onChange();
    } catch (e) { setWebOk(false); setWebMsg(String(e.message)); } finally { setWebBusy(false); }
  }

  // Claude 원클릭 연결 — 서버가 공식 setup-token을 PTY로 대행(브라우저 승인만 하면 자동 저장).
  // 수동 붙여넣기 경로는 그대로 유지(이 버튼이 실패하는 환경의 폴백 — 회귀 없음).
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMsg, setSetupMsg] = useState('');
  const [setupOk, setSetupOk] = useState(false);
  // 신형 CLI 코드 플로우(2026-07-22) — 승인 후 브라우저에 표시된 코드를 여기서 받아 서버(stdin)로 보낸다.
  // authUrl = 브라우저가 안 열린 기기(신규 맥 신고)의 폴백 링크.
  const [setupAuthUrl, setSetupAuthUrl] = useState('');
  const [setupAwaitCode, setSetupAwaitCode] = useState(false);
  const [setupCode, setSetupCode] = useState('');
  async function submitSetupCode() {
    const v = setupCode.trim();
    if (!v) return;
    setSetupCode('');
    setSetupMsg(t('settings.runners.setupWaiting'));
    try {
      await fetch(`${keysBase(ws)}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: 'claude', setup: true, code: v }),
      });
    } catch { /* 폴링이 결과(saved/failed)를 알려준다 */ }
  }
  const setupPollRef = useRef(null);
  useEffect(() => () => { if (setupPollRef.current) { clearInterval(setupPollRef.current); setupPollRef.current = null; } }, []);
  async function setupConnect() {
    // 진행 중 재클릭 허용 — 서버가 이전 시도를 죽이고 새로 연다(브라우저를 승인 없이 닫은 사용자가
    // 10분 타임아웃을 기다리지 않고 즉시 재시도, 실사용 신고 2026-07-20). busy 가드 제거가 의도.
    setSetupBusy(true); setSetupOk(false); setSetupMsg(t('settings.runners.setupWaiting'));
    setSetupAuthUrl(''); setSetupAwaitCode(false); setSetupCode('');
    try {
      const r = await fetch(`${keysBase(ws)}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runner: 'claude', setup: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        throw new Error(d.reason === 'no-cli' ? t('settings.runners.setupNoCli')
          : d.reason === 'unsupported-platform' ? t('settings.runners.setupNoWin')
            : d.reason === 'busy' ? t('settings.runners.setupWaiting')
              : d.reason === 'hosted' ? t('settings.runners.setupHosted') // 원문 'hosted' 노출이 연결 불가로 읽혔다(실사용 신고)
                : d.reason === 'manual' ? t('settings.runners.setupManual') // 이 환경(상주/웹)은 붙여넣기가 정식 경로
                  : (d.message || d.reason || 'failed'));
      }
      const t0 = Date.now();
      if (setupPollRef.current) clearInterval(setupPollRef.current);
      setupPollRef.current = setInterval(async () => {
        if (!alive.current || Date.now() - t0 > 11 * 60_000) { clearInterval(setupPollRef.current); setupPollRef.current = null; if (alive.current) { setSetupBusy(false); setSetupMsg(t('settings.runners.setupFailedShort')); } return; }
        try {
          const s = await (await fetch(`${keysBase(ws)}/connect?runner=claude&setup=1`)).json();
          if (s.authUrl) setSetupAuthUrl(s.authUrl); // 브라우저 미개방 폴백 링크
          if (s.awaitCode) { setSetupAwaitCode(true); setSetupMsg(t('settings.runners.setupCodeHint')); } // 코드 입력칸 개방
          if (s.status === 'saved') {
            clearInterval(setupPollRef.current); setupPollRef.current = null;
            setSetupBusy(false); setSetupOk(true); setSetupAwaitCode(false); setSetupAuthUrl(''); setSetupMsg(t('settings.runners.connected'));
            window.dispatchEvent(new Event('argo:refresh')); onChange();
          } else if (s.status === 'failed') {
            clearInterval(setupPollRef.current); setupPollRef.current = null;
            setSetupBusy(false); setSetupAwaitCode(false); setSetupMsg(s.error || t('settings.runners.setupFailedShort'));
          }
        } catch { /* 다음 틱 재시도 */ }
      }, 2000);
    } catch (e) { setSetupBusy(false); setSetupMsg(String(e.message)); }
  }

  // 연결/제거로 상태가 바뀌면 선택 방식을 회사 연결 방식에 맞춘다
  useEffect(() => { if (company.connected) setMethod(company.type); }, [company.connected, company.type]);

  // 언마운트 시 폴링 정리 — stale 폴링/setState 누수 방지
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, []);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (alive.current) setPolling(false);
  }

  function startPoll() {
    pollN.current = 0;
    setPolling(true);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      pollN.current += 1;
      if (pollN.current > 60) { stopPoll(); return; }
      try {
        const res = await fetch(`${keysBase(ws)}/connect?runner=${encodeURIComponent(id)}`);
        const d = await res.json();
        if (!alive.current) return;
        if (d.authed) {
          stopPoll();
          setOk(true); setMsg(t('settings.runners.connected'));
          window.dispatchEvent(new Event('argo:refresh'));
          onChange();
        }
      } catch { /* 폴링 실패는 조용히 재시도 */ }
    }, 2000);
  }

  async function connect() {
    if (busy || polling) return;
    setBusy('connect'); setMsg(''); busyWasHost.current = false; setOk(false);
    try {
      const res = await fetch(`${keysBase(ws)}/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) {
        setOk(false);
        setMsg(d.reason === 'not-installed'
          ? t('settings.runners.connectNotInstalled', { runner: id })
          : t('settings.runners.connectFailed'));
        return;
      }
      setOk(true); setMsg(t('settings.runners.connectOpened'));
      startPoll();
    } catch {
      setOk(false); setMsg(t('settings.runners.connectFailed'));
    } finally {
      setBusy('');
    }
  }

  async function save() {
    if (busy || !value.trim() || method === 'host') return; // host 상태 방어 — 라우트가 value를 무시해 입력이 조용히 버려진다(검수 MEDIUM)
    setBusy('verify'); setMsg(''); busyWasHost.current = false; setOk(false);
    try {
      // verify는 서버가 항상 강제한다(무검증 '저장만' 함정 제거 — 2026-07-20). 플래그는 하위호환 전송.
      const res = await fetch(`${keysBase(ws)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: id, type: method, value: value.trim(), verify: true }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setValue(''); setOk(true); setMsg(t('settings.runners.verified'));
      window.dispatchEvent(new Event('argo:refresh'));
      onChange();
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setBusy('');
    }
  }

  // 연결 확인(P1-2) — 결과는 msg 자리 재사용. ok:null(원격 판정 불가 방식)은 정직하게 그렇게 말한다.
  async function verifyNow() {
    setBusy('verify'); setVerifyMsg(''); setVerifyOk(false);
    try {
      const r = await api(`/api/companies/${ws}/keys/verify`, { runner: id }); // api()는 두 번째 인자 자체가 JSON 바디(POST)다
      if (r.ok === true) { setVerifyOk(true); setVerifyMsg(t('settings.runners.checkOk')); }
      else if (r.ok === false) {
        setVerifyOk(false);
        // 크레딧·구독 사정은 인증 실패가 아니다 — "다시 연결" 오안내 금지(grokCreditNotice 원칙, 검수 L3)
        setVerifyMsg(r.reason === 'gemini-license'
          ? t('settings.runners.geminiLicenseBlocked')
          : (r.reason === 'credit' || r.reason === 'tier')
            ? t('settings.runners.checkCreditTier')
            : t('settings.runners.checkFailed'));
      } else { setVerifyOk(true); setVerifyMsg(t('settings.runners.checkInconclusive')); }
    } catch (e) { setVerifyOk(false); setVerifyMsg(String(e?.message || e)); }
    setBusy('');
  }

  async function remove() {
    if (busy) return;
    setBusy('remove'); setMsg(''); busyWasHost.current = false; setOk(false);
    try {
      await fetch(`${keysBase(ws)}?runner=${encodeURIComponent(id)}`, { method: 'DELETE' });
      window.dispatchEvent(new Event('argo:refresh'));
      onChange();
    } finally {
      setBusy('');
    }
  }

  // "이 컴퓨터 로그인 사용" — 호스트 CLI 로그인의 명시 옵트인(codex/gemini). 감지만으론 절대 자동
  // 사용하지 않는다(명시 연결 정본 — 유건 지시 2026-07-19). 서버가 로그인 상태 검증 후 마커 저장.
  async function useHost() {
    if (busy) return;
    busyWasHost.current = true; // 이 msg는 옵트인 행에 그린다(다른 행과 이중 표시 방지)
    setBusy('host'); setMsg(''); setOk(false);
    try {
      const res = await fetch(`${keysBase(ws)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: id, type: 'host' }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setOk(true); setMsg(t('settings.runners.hostLinked'));
      window.dispatchEvent(new Event('argo:refresh'));
      onChange();
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setBusy('');
    }
  }
  // 옵트인 — **성공할 수 있는 상태에서만 버튼을 보여준다**(유건 지시 2026-08-26: "실패 자체가 있으면
  // 안 돼"). 서버가 이미 내려주는 감지 상태(hostInstalled/hostAuthed/hostAuthUnknown — 별도 스캔 0)로
  // 미설치면 설치 링크를, 미로그인이면 터미널 로그인 안내를 처음부터 그린다. 이전엔 버튼을 항상 노출하고
  // 클릭 시점에 서버가 거절해 "버튼이 줄었다 되돌아오는" 무언 실패가 났다(실사용 제보 v0.1.47).
  // 서버 검증(PUT 라우트)은 방어선으로 유지 — UI는 게이트가 아니다.
  const hostReady = !!st?.hostInstalled && (!!st?.hostAuthed || !!st?.hostAuthUnknown);
  const hostOptIn = !!st?.hostUsable && !company.connected && (
    hostReady ? (
      <button className="btn sm" disabled={!!busy} onClick={useHost}>
        {busy === 'host' ? <Spinner size={12} /> : t('settings.runners.useHost')}
      </button>
    ) : (
      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>
        {!st?.hostInstalled
          ? <>{t('settings.runners.hostNeedInstall')}{st?.keyUrl && <> · <a href={st.keyUrl} target="_blank" rel="noreferrer">{t('settings.runners.hostInstallGuide')} ↗</a></>}</>
          : t('settings.runners.hostNeedLogin', { runner: id })}
      </span>
    )
  );

  const chip = company.connected ? (
    company.invalid ? (
      // 무효 자격(형식 불량 토큰·로그아웃된 host 마커) — 연결된 척하지 않고 재연결을 요구한다
      <span className="chip" style={{ color: 'var(--danger)', borderColor: 'currentColor' }}>
        <span className="dot" />{t('settings.runners.companyInvalid')}{company.masked && <> · <span className="mono" style={{ fontSize: 10.5 }}>{company.masked}</span></>}
      </span>
    ) : (
      <span className="chip" style={{ color: 'var(--ok)', borderColor: 'currentColor' }}>
        <span className="dot" />{t('settings.runners.companyConnected')} · {t(`settings.runners.method.${company.type}`)}{company.masked && <> · <span className="mono" style={{ fontSize: 10.5 }}>{company.masked}</span></>}
      </span>
    )
  ) : (
    // 감지 기반 상태 표시는 하지 않는다(유건 지시 2026-07-19: 로그인 기록 스캔은 복잡하고 오류 소지 —
    // 상태는 연결됨/미연결 둘뿐, 호스트 로그인 사용은 아래 옵트인 버튼 클릭 시 서버가 검증한다).
    <span className="chip">{t('settings.runners.none')}</span>
  );

  // 웹 브리지(claude·codex·gemini)는 붙여넣기 분기에서 처리 — CLI 대행 분기는 webConnect 없는 러너만
  const oauthCli = method === 'oauth' && !oauthPaste && !st?.webConnect;
  // 웹 브리지 러너 중 claude만 토큰 수동 붙여넣기 폴백을 노출(codex/gemini 토큰은 JSON이라 비실용)
  const showPaste = !(method === 'oauth' && st?.webConnect && id !== 'claude');
  const urlPaste = id !== 'claude'; // codex/gemini — 승인 후 리다이렉트된 주소 전체를 붙여넣는 방식
  const removeBtn = company.connected && (
    <div>
      {/* 파괴적(전 기기·전 크루 영향) — 확인 없이 즉시 실행하지 않는다(프로젝트 삭제류 액션 규칙). */}
      {/* 연결 확인(P1-2) — verifyRunnerCred가 저장 시점 1회만 돌아, 이후 만료·철회·차단은 턴
          실패로만 드러나던 갭. 저장된 자격을 온디맨드 재검증한다(주기 검진은 후속). */}
      {company.connected && ws !== ACCOUNT_WS && (
        <>
          <button className="btn sm" disabled={!!busy} onClick={verifyNow}>
            {busy === 'verify' ? <Spinner size={12} /> : t('settings.runners.checkNow')}
          </button>
          {verifyMsg && <span style={{ fontSize: 12, color: verifyOk ? 'var(--fg-2)' : 'var(--danger)' }}>{verifyMsg}</span>}
        </>
      )}
      <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={!!busy} onClick={() => setConfirmRemove(true)}>
        {busy === 'remove' ? <Spinner size={12} /> : t('settings.runners.remove')}
      </button>
      {confirmRemove && (
        <ConfirmModal
          title={t('settings.runners.removeConfirmTitle', { runner: RUNNER_NAMES[id] })}
          description={t('settings.runners.removeConfirm')}
          confirmLabel={t('settings.runners.remove')}
          tone="danger"
          onConfirm={() => { setConfirmRemove(false); remove(); }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
  const accordion = typeof onToggle === 'function';
  // host 타입으로 연결됨 — 연결 폼(탭·붙여넣기)을 숨긴다: 이 상태의 API키 폼은 저장 시 입력이
  // 조용히 버려지는 오폼이었다(검수 MEDIUM). 해제 후 다른 방식으로 재연결하는 흐름만 남긴다.
  const hostLinked = company.connected && company.type === 'host';
  const header = (
    <>
      {accordion && (
        <span aria-hidden style={{ display: 'inline-flex', color: 'var(--fg-3)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.18s ease' }}>
          <Icon name="play" size={10} />
        </span>
      )}
      <span style={{ fontSize: 13.5, fontWeight: 650 }}>{RUNNER_NAMES[id]}</span>
      {chip}
      {st?.month?.turns > 0 && (
        <span className="chip mono" title={t('settings.runners.monthTitle')} style={{ fontSize: 10.5 }}>
          {t('settings.runners.month', { n: st.month.turns })}{st.month.hasCost ? ` · ${fmtMoney(st.month.costUsd)}` : ''}
        </span>
      )}
      {/* 마지막 턴 상태(P1-1) — "연결됨" 초록불이 실사용 실패를 가리지 않게, 최근 턴이 실패한
          러너에 경고를 단다. 중단(사장 지시)은 실패가 아니라 제외. 원천 = 활동 이벤트 runner·ok. */}
      {/* .chip 금지 — uppercase+nowrap+mono가 EN 문장을 486px로 부풀려 폰 폭 카드를 뚫는다
          (검수 M3 실측: EN 486 vs KO 300, 컨테이너 338). 소형 텍스트 + 줄바꿈 허용.
          검진 실패(주기 확인 — "지금 자격이 죽어 있다")가 턴 실패보다 강한 신호라 우선 표시한다. */}
      {(company.connected || st?.host?.optedIn) && (healthFail?.ok === false
        ? <span style={{ fontSize: 11.5, color: 'var(--danger)', whiteSpace: 'normal', minWidth: 0 }}>
            {t(healthFailMessageKey(healthFail.reason))}
          </span>
        : (lastTurn && !lastTurn.ok && !lastTurn.aborted && (
            <span style={{ fontSize: 11.5, color: 'var(--danger)', whiteSpace: 'normal', minWidth: 0 }}>{t('settings.runners.lastTurnFailed')}</span>
          )))}
    </>
  );
  return (
    <div style={{ display: 'grid', gap: 8, padding: '12px 0', ...(first ? {} : { borderTop: '1px dashed var(--border-soft)' }) }}>
      {accordion ? (
        /* 아코디언 헤더(온보딩) — 행 전체가 토글. 접힌 채로도 상태 칩으로 연결 여부가 보인다 */
        <button type="button" onClick={onToggle} aria-expanded={open}
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' }}>
          {header}
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>{header}</div>
      )}
      {open && <>
      {/* 외부 CLI 러너(codex/gemini/antigravity) 정직 표기 — 크루 도구(쪽지·루틴·위임)가 표면에 없다
          (chat.mjs hasTools:false). "AI 직원 회사" 핵심 약속이 러너에 따라 조용히 빠지므로 카드가 미리 알린다
          (runtimeBlocked 배지·'권한 근사 적용' 계열). 판정은 서버 runnerStatus.cli — 클라 하드코딩 금지. */}
      {st?.cli && (
        <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('settings.runners.cliToolsNote')}</span>
      )}
      {retired && <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('settings.runners.retiredNote')}</span>}
      {hostLinked || retired ? (
        /* host 연결됨 또는 제공 종료(숨김) 러너의 보관 자격 — 상태 칩이 전부다. 연결 폼은 숨기고 해제만 노출. */
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {msg && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
          {removeBtn}
        </div>
      ) : (<>
      {hasOauth && (
        <div style={{ display: 'flex', gap: 6 }}>
          {methods.map((m) => (
            <button key={m} className="chip" onClick={() => { setMethod(m); setMsg(''); busyWasHost.current = false; }} aria-pressed={method === m}
              style={{ cursor: 'pointer', padding: '4px 12px', fontSize: 12, ...(method === m ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
              {t(`settings.runners.method.${m}`)}
            </button>
          ))}
        </div>
      )}
      {/* 호스트 로그인 옵트인 — 방식 탭과 무관한 제3의 연결 경로라 항상 보인다(기본 탭에 숨으면 발견 불가). */}
      {hostOptIn && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {hostOptIn}
          {hostReady && <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('settings.runners.useHostHint')}</span>}
          {/* 실패 사유 자리 — 이전엔 이 행에 msg 렌더가 없어 서버 거절이 무언(스피너 깜빡)으로 끝났다 */}
          {msg && busyWasHost.current && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
        </div>
      )}
      {oauthCli ? (
        connectable ? (
          /* codex — 벤더 CLI 브라우저 로그인 대행 (Connect 버튼 + 폴링) */
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary sm" disabled={!!busy || polling} onClick={connect}>
                {busy === 'connect' || polling ? <Spinner size={12} /> : t('settings.runners.connect')}
              </button>
              {msg && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
            </div>
            {removeBtn}
          </div>
        ) : (
          /* gemini 등 — 설치·로그인은 이 컴퓨터에서 (입력창 없음) */
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {st?.hostInstalled
                ? t('settings.runners.hostLoginUsed', { runner: id })
                : t('settings.runners.hostInstall', { runner: id })}
              {st?.hostInstalled && (
                <span style={{ marginLeft: 8, color: st?.hostAuthUnknown ? 'var(--fg-3)' : st?.hostAuthed ? 'var(--ok)' : 'var(--warn)' }}>
                  {st?.hostAuthUnknown ? t('settings.runners.hostAuthUnknown') : st?.hostAuthed ? t('settings.runners.hostAuthed') : t('settings.runners.hostNotAuthed')}
                </span>
              )}
            </div>
            {removeBtn}
          </div>
        )
      ) : (
        <>
          {/* Claude OAuth 웹 브리지 — "버튼 클릭 = 로그인 페이지". 워커·로컬 공통, 붙여넣기는 아래 폴백 */}
          {method === 'oauth' && st?.webConnect && (
            <div style={{ display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'var(--card-2)', border: '1px solid var(--border-soft)' }}>
              {!webUrl ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn-primary sm" disabled={webBusy} onClick={webStart}>
                    {webBusy ? <Spinner size={12} /> : t('settings.runners.webConnect')}
                  </button>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t(urlPaste ? 'settings.runners.webConnectHintUrl' : 'settings.runners.webConnectHint')}</span>
                </div>
              ) : (
                <>
                  <a className="btn btn-primary sm" href={webUrl} target="_blank" rel="noreferrer" style={{ justifySelf: 'start' }}>
                    {t('settings.runners.openLogin')} ↗
                  </a>
                  {webUserCode ? (
                    /* 기기 코드 — 링크를 열면 이 코드를 넣으라고 나온다. 승인되면 폴링이 잡는다(붙여넣기 없음) */
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="chip mono" style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.08em', padding: '6px 12px' }}>{webUserCode}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('settings.runners.deviceHint')}</span>
                    </div>
                  ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input suppressHydrationWarning value={webCode} onChange={(e) => setWebCode(e.target.value)}
                      placeholder={t(urlPaste ? 'settings.runners.codePhUrl' : 'settings.runners.codePh')} style={{ ...fieldStyle, flex: 1 }} />
                    <button className="btn btn-primary sm" disabled={webBusy || !webCode.trim()} onClick={webSubmit} style={{ flex: 'none' }}>
                      {webBusy ? <Spinner size={12} /> : t('settings.runners.codeSubmit')}
                    </button>
                  </div>
                  )}
                </>
              )}
              {webMsg && <span style={{ fontSize: 12, color: webOk ? 'var(--fg-2)' : 'var(--danger)' }}>{webMsg}</span>}
            </div>
          )}
          {/* codex/gemini 웹 브리지 — 붙여넣기 대신 제거만 노출(호스트 옵트인은 탭 아래 공통 행) */}
          {!showPaste && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {msg && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
              {removeBtn}
            </div>
          )}
          {showPaste && (<>
          {/* Claude 원클릭 — 데스크톱 번들에서만 완주(브라우저 열기 + 콜백 리스너 수명). 상주/웹은 완주 못 해
              스피너 함정이 되므로 노출하지 않는다(실사용 신고 2026-07-19). 그 환경은 아래 붙여넣기가 정식 경로. */}
          {id === 'claude' && method === 'oauth' && st?.setupOneClick && (
            <div style={{ display: 'grid', gap: 6, padding: '10px 12px', borderRadius: 10, background: 'var(--card-2)', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {/* 진행 중에도 활성 — 누르면 이전 시도를 접고 브라우저를 다시 연다(취소 후 재시도 상식) */}
                <button className="btn btn-primary sm" onClick={setupConnect}>
                  {setupBusy ? <><Spinner size={12} /> {t('settings.runners.setupRetry')}</> : t('settings.runners.setupConnect')}
                </button>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('settings.runners.setupHint')}</span>
              </div>
              {setupMsg && <span style={{ fontSize: 12, color: setupOk ? 'var(--ok)' : setupBusy ? 'var(--fg-2)' : 'var(--danger)' }}>{setupMsg}</span>}
              {/* 브라우저가 안 열린 기기(신규 설치 신고 2026-07-22) — 같은 인증 링크를 직접 연다 */}
              {setupBusy && setupAuthUrl && (
                <a href={setupAuthUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--primary-strong)', fontWeight: 650 }}>
                  {t('settings.runners.setupOpenLink')} →
                </a>
              )}
              {/* 신형 CLI 코드 플로우 — 승인 후 브라우저에 표시된 코드를 여기 붙여넣으면 서버가 CLI에 전달해 완료 */}
              {setupBusy && setupAwaitCode && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input suppressHydrationWarning value={setupCode} onChange={(e) => setSetupCode(e.target.value)}
                    placeholder={t('settings.runners.setupCodePh')} style={{ ...fieldStyle, flex: 1 }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitSetupCode(); } }} />
                  <button className="btn btn-primary sm" style={{ flex: 'none' }} disabled={!setupCode.trim()} onClick={submitSetupCode}>
                    {t('settings.runners.setupCodeSubmit')}
                  </button>
                </div>
              )}
            </div>
          )}
          <input suppressHydrationWarning type="password" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={method === 'oauth' ? t('settings.runners.tokenPlaceholder') : t('settings.runners.keyPlaceholder')} style={fieldStyle} />
          <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.6 }}>
            {method === 'oauth' ? (
              t('settings.runners.oauthGuide')
            ) : (
              <>
                {t('settings.runners.keyGuide')}{' '}
                {st?.keyUrl && (
                  <a href={st.keyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--fg)', textDecoration: 'underline' }}>{t('settings.runners.keyLink')}</a>
                )}
              </>
            )}
          </p>
          {/* 구독 연결의 과금 주체 고지 — Claude만 해당(구독 한도 차감, 무료 플랜 제외) */}
          {id === 'claude' && method === 'oauth' && (
            <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.6 }}>{t('settings.runners.subNote')}</p>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* 단일 버튼 — '저장만'(무검증 저장)은 무효 자격을 '연결됨'으로 저장해 전 턴이 API 오류로만
                드러나는 함정이었다(실사용 2026-07-20). 서버도 실검증을 강제하므로 우회 경로 자체가 없다. */}
            <button className="btn btn-primary sm" disabled={!!busy || !value.trim()} onClick={save}>
              {busy === 'verify' ? <Spinner size={12} /> : t('settings.runners.saveVerify')}
            </button>
            {company.connected && (
              <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={!!busy} onClick={remove}>
                {busy === 'remove' ? <Spinner size={12} /> : t('settings.runners.remove')}
              </button>
            )}
            {msg && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
          </div>
          </>)}
        </>
      )}
      </>)}
      </>}
    </div>
  );
}
