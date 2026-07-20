'use client';
// 크루 채팅 — 스레드 영속(새로고침해도 이어짐), 카드 열람·편집·해고, 실패 시 재시도.
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Markdown, ArgoSpinner, Spinner, Skeleton, DangerModal, ConfirmModal, InputModal, useScrollLock, api } from '../../../../ui';
import { useLang, stageLabel } from '../../../../i18n';

/** 경과 시간 — 1:07 형태. 턴이 도는 동안 1초마다 갱신된다. */
const fmtElapsed = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** 이 드래그가 파일을 싣고 있는가. dragover 단계는 보호 모드라 내용을 못 읽으므로 타입·kind로만 판정한다.
    'Files'만 보면 안 된다 — 맥 데스크톱 셸(WKWebView)은 public.* UTI로 광고하는 경우가 있고,
    dragover에서 preventDefault를 못 하면 drop 이벤트 자체가 발생하지 않아 조용히 실패한다. */
const dragHasFiles = (dt) => {
  const types = [...(dt?.types ?? [])];
  if (types.includes('Files')) return true;
  if ([...(dt?.items ?? [])].some((i) => i.kind === 'file')) return true;
  return types.some((ty) => ty.startsWith('public.') || ty.startsWith('image/') || ty === 'application/x-moz-file');
};

/** 드롭에서 실제 File을 꺼낸다. 맥 화면 캡처 직후 우측 하단 썸네일처럼 아직 디스크에 저장되기 전
    (promise) 드래그는 dataTransfer.files가 비고 items[].getAsFile()로만 잡히므로 두 경로를 모두 훑는다. */
const filesFromTransfer = (dt) => {
  const direct = [...(dt?.files ?? [])].filter(Boolean);
  if (direct.length) return direct;
  return [...(dt?.items ?? [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
};

/** 채팅 읽기 레인 폭 — 일반 LLM 챗처럼 메시지·컴포저를 중앙 좁은 레인에 담는다(가독성).
    .thread·컴포저·열람바 세 곳이 공유하는 단일 진실. 좁은 화면에선 100%로 안전 폴백. */
const LANE = 'min(768px, 100%)';

export default function CrewChat({ params }) {
  const { ws, slug } = use(params);
  const { t } = useLang();
  const WAIT_STAGES = [t('chat.waitStage1'), t('chat.waitStage2'), t('chat.waitStage3')];
  const router = useRouter();
  const [agent, setAgent] = useState(null);
  const [thread, setThread] = useState(null); // null = 로딩
  const [input, setInput] = useState('');
  // 입력 보존 — 새로고침·페이지 이탈에도 쓰던 내용이 남는다. input 상태를 그대로 따라가므로
  // 전송(setInput(''))이면 자동 삭제되고, 턴 실패 복원(setInput(message))이면 자동 재저장된다.
  const draftKey = `argo-draft:${ws}:${slug}`;
  useEffect(() => {
    try { const d = localStorage.getItem(draftKey); if (d) setInput((cur) => cur || d); } catch { /* 사파리 프라이빗 등 — 보존은 부가기능이라 실패해도 무시 */ }
  }, [draftKey]);
  useEffect(() => {
    try { if (input) localStorage.setItem(draftKey, input); else localStorage.removeItem(draftKey); } catch { /* 저장 불가 환경 — 무시 */ }
  }, [input, draftKey]);
  // 프롬프트 히스토리 — 터미널처럼 ↑/↓로 이전 지시를 다시 불러온다(원천 = 스레드의 사장 메시지라 기기 간에도 이어진다).
  const histIdx = useRef(-1);   // -1 = 탐색 중 아님
  const histStash = useRef(''); // 탐색 시작 시점 입력 보관 — ↓로 끝까지 내려오면 복원
  const inputRef = useRef(null); // textarea 자동 높이 — 값이 어떤 경로로 바뀌든(타이핑·히스토리·초안 복원) 재계산
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!input) { el.style.height = ''; return; } // 빈 값 = 인라인 제거 → rows=1 자연 높이(수축 보장)
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`; // 최대 ~6줄 — 넘으면 내부 스크롤
  }, [input]);
  const history = useMemo(() => {
    const out = [];
    for (const m of thread ?? []) {
      if (m.who !== 'user' || !String(m.text ?? '').trim()) continue;
      if (out[out.length - 1] !== m.text) out.push(m.text); // 연속 중복 제거
    }
    return out.slice(-50);
  }, [thread]);
  function onInputKeyDown(e) {
    // imeGuard 병합 — 이 입력은 스프레드 대신 여기서 IME Enter를 막는다({...imeGuard}가 onKeyDown을 덮는 문제)
    if (e.key === 'Enter' && e.nativeEvent.isComposing) { e.preventDefault(); return; }
    // Enter=전송, Shift+Enter=줄바꿈(textarea 기본 동작) — 유건 지시 2026-07-19
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.nativeEvent.isComposing) return; // IME 조합 중엔 개입하지 않는다
    const el = e.target;
    // 쓰던 글이 있으면 ↑/↓는 편집키다 — ↑=맨 앞, ↓=맨 뒤(유건 지시 2026-07-20). 히스토리는 입력창이 빈 상태에서만
    // 시작한다. 단 이미 히스토리를 걷는 중(histIdx≠-1)이면 불러온 글이 채워져 있어도 계속 걸을 수 있어야 한다.
    const navigating = histIdx.current !== -1;
    if (el.value && !navigating) {
      e.preventDefault();
      const pos = e.key === 'ArrowUp' ? 0 : el.value.length;
      el.setSelectionRange(pos, pos);
      return;
    }
    if (!history.length) return;
    // 불러온 지시가 여러 줄이면 그 안에서의 커서 이동이 우선 — 첫 줄(↑)/마지막 줄(↓)에서만 히스토리를 넘긴다
    if (e.key === 'ArrowUp' && el.value.slice(0, el.selectionStart ?? 0).includes('\n')) return;
    if (e.key === 'ArrowDown' && el.value.slice(el.selectionEnd ?? 0).includes('\n')) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') {
      if (histIdx.current === -1) histStash.current = input;
      histIdx.current = Math.min(histIdx.current + 1, history.length - 1);
      setInput(history[history.length - 1 - histIdx.current]);
    } else {
      if (histIdx.current === -1) return;
      histIdx.current -= 1;
      setInput(histIdx.current === -1 ? histStash.current : history[history.length - 1 - histIdx.current]);
    }
  }
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [cardOpen, setCardOpen] = useState(false);
  // 러너·모델 — 카드 패널과 채팅 셀렉터가 공유하는 단일 상태. 회사 자격(설정 러너 연결)을 병합한 카탈로그.
  const [runners, setRunners] = useState(null);
  const [sel, setSel] = useState({ runner: 'claude', model: '' });
  // 타이틀바 슬롯 — 크루 컨트롤(세션 상태·카드·새 대화)을 topbar에 포털로 꽂는다
  const [slotEl, setSlotEl] = useState(null);
  useEffect(() => { setSlotEl(document.getElementById('argo-topbar-slot')); }, []);
  // 세션 적재 레일 — 새 대화로 넘긴 이전 대화들이 좌측에 쌓이고, 클릭으로 읽기 전용 열람
  const [sessions, setSessions] = useState([]);
  const [viewing, setViewing] = useState(null); // 보관 세션 id (null = 현재 대화)
  const [archMsgs, setArchMsgs] = useState(null);
  const [renameSess, setRenameSess] = useState(null); // 대화명 편집 모달 대상 세션
  const [threadTitle, setThreadTitle] = useState(null); // 현재(활성) 대화의 사용자 지정 이름
  const [trashSess, setTrashSess] = useState(null);   // 삭제(보관) 확인 모달 대상 세션
  // 우측 드로어 — 백그라운드 작업 / 파일 탭. 채팅 폭은 유지하고 우측에서 덮으며 내려온다.
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('tasks'); // 'tasks' | 'files'
  const [panelTasks, setPanelTasks] = useState(null); // /tasks 응답을 이 크루 slug로 필터한 것
  useEffect(() => {
    if (!panelOpen || panelTab !== 'tasks') return;
    let alive = true;
    const pull = () => api(`/api/companies/${ws}/tasks`).then((d) => {
      if (!alive) return;
      setPanelTasks({
        running: (d.running ?? []).filter((r) => r.slug === slug),
        recent: (d.recent ?? []).filter((r) => r.slug === slug),
      });
    }).catch(() => {});
    pull();
    const iv = setInterval(pull, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [panelOpen, panelTab, ws, slug]);
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setPanelOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen]);
  const loadSessions = useCallback(() => {
    api(`/api/companies/${ws}/chat/sessions?slug=${encodeURIComponent(slug)}`)
      .then((d) => setSessions(d.sessions ?? [])).catch(() => {});
  }, [ws, slug]);
  useEffect(loadSessions, [loadSessions]);
  async function openSession(id) {
    resetAnnot(); // 세션을 오가며 빨간펜 상태가 다른 메시지에 유령으로 남지 않게
    if (!id) { setViewing(null); setArchMsgs(null); return; }
    try {
      const d = await api(`/api/companies/${ws}/chat/sessions?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`);
      setViewing(id); setArchMsgs(d.messages ?? []);
    } catch (e) { setError(String(e.message)); }
  }
  // 대화 이어가기 — 보관 세션을 활성으로 되살린다(서버가 현재 대화를 자동 보관). 이후 그대로 이어서 지시 가능.
  async function resumeViewing() {
    if (!viewing || busy) return;
    try {
      const r = await api(`/api/companies/${ws}/chat/sessions`, { slug, id: viewing });
      setThread(r.thread?.messages ?? []);
      sessionRef.current = r.thread?.sessionId ?? null;
      setThreadTitle(r.thread?.title ?? null);
      setViewing(null); setArchMsgs(null); setError(''); resetAnnot();
      loadSessions();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setError(String(e.message)); }
  }
  // 대화명 편집 — 보관 세션에 title 기록(레일 표시는 title 우선).
  async function doRenameSess(title) {
    const s = renameSess; setRenameSess(null);
    if (!s) return;
    try {
      const res = await fetch(`/api/companies/${ws}/chat/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, id: s.id ?? null, title }),
      }).then((r) => r.json());
      if (!s.id) setThreadTitle(res?.title ?? null); // 현재 대화 — 라벨 즉시 반영
      else loadSessions();
    } catch (e) { setError(String(e.message)); }
  }
  // 세션 삭제(보관) — .archive → .trash 이동. 설정 보관함에서 복구 가능(비파괴).
  async function doTrashSess() {
    const s = trashSess; setTrashSess(null);
    if (!s) return;
    try {
      await fetch(`/api/companies/${ws}/chat/sessions?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      if (viewing === s.id) openSession(null); // 열람 중이던 대화를 지웠으면 현재 대화로
      loadSessions();
    } catch (e) { setError(String(e.message)); }
  }
  // 세션 고정/해제 — 보관 세션에 pinned 기록. 고정 세션은 레일 상단에 최근순으로 묶인다(비파괴·즉시, 확인 불필요).
  async function doTogglePin(s) {
    try {
      await fetch(`/api/companies/${ws}/chat/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, id: s.id, pinned: !s.pinned }),
      });
      loadSessions();
    } catch (e) { setError(String(e.message)); }
  }
  const sessionRef = useRef(null);
  const endRef = useRef(null);
  const threadRef = useRef(null);   // 스크롤 컨테이너(.thread)
  const pinRef = useRef(null);      // 상단에 붙일 내 메시지의 mid — 전송 직후 1회 소비
  const msgRefs = useRef(new Map()); // mid → DOM 노드
  const atBottomRef = useRef(true);  // 하단 근처면 새 내용을 따라간다. 위로 올려 읽는 중이면 끌어내리지 않는다.
  // 첨부 — 업로드 즉시 vault/files/에 저장되고, 보내기 전까지 입력바 위에 칩으로 대기한다
  const [att, setAtt] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  // 경과 타이머 — 보낸 순간부터 1초 단위
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);
  // 실제 진행 단계 — "작성중" 대신 지금 무엇을 하는지 (기억 탐색/명령 실행/결재 대기)
  const [liveStage, setLiveStage] = useState(null);

  // 러너 카탈로그 — 회사 자격 병합(?ws=). 회사 키가 있으면 호스트 로그인 없이도 authed=true.
  useEffect(() => { api(`/api/runners?ws=${ws}`).then((d) => setRunners(d.runners)).catch(() => setRunners([])); }, [ws]);

  // 러너·모델 저장 — 카드·채팅 공용. 프론트매터 meta에 PATCH(다음 턴부터 적용).
  const saveRunner = useCallback(async (next) => {
    setSel(next);
    try {
      await fetch(`/api/companies/${ws}/agents/${slug}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: next.runner, model: next.model }),
      });
      window.dispatchEvent(new Event('argo:refresh'));
    } catch { /* 저장 실패는 다음 시도에서 복구 */ }
  }, [ws, slug]);

  useEffect(() => {
    setThread(null); setError(''); sessionRef.current = null;
    api(`/api/companies/${ws}`)
      .then((d) => {
        const a = d.agents.find((a) => a.slug === slug) ?? { name: slug, role: '' };
        setAgent(a);
        setSel({ runner: a.runner || 'claude', model: a.model || '' });
      })
      .catch(() => setAgent({ name: slug, role: '' }));
    api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)
      // status도 첫 로드에 반영 — 온보딩 직행 시 시운전 진행 카드가 8초 폴을 기다리지 않고 바로 보인다
      .then((t) => { setThread(t.messages ?? []); sessionRef.current = t.sessionId ?? null; setLiveStage(t.status ?? null); setThreadTitle(t.title ?? null); })
      .catch(() => setThread([]));
  }, [ws, slug]);

  // 하단 근처 여부를 실제 스크롤에서 읽어 둔다 — 사장이 위로 올려 읽는 중이면 새 내용이 와도 끌어내리지 않는다.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => { atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  // 스크롤 규율 두 가지.
  //  ① 전송 직후 — 방금 보낸 내 글을 컨테이너 상단에 붙인다. 그 아래 공간에서 작업 과정과 답변이 흐른다.
  //  ② 그 외 — 하단 근처일 때만 따라간다.
  // liveStage.partial이 의존성에 있어야 스트리밍으로 답변이 자라는 동안에도 시야가 따라간다.
  // (이게 빠져 있어 답변이 길어지면 내용이 화면 아래로 밀려 "스크롤이 위에 멈춰 있다"로 보였다 — 2026-07-20 신고)
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const pin = pinRef.current && msgRefs.current.get(pinRef.current);
    if (pin) {
      pinRef.current = null;
      atBottomRef.current = false;
      el.scrollTop += pin.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      return;
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [thread, busy, liveStage?.partial]);

  // 다른 창구(텔레그램·슬랙·루틴·결재 후속)에서 붙은 대화를 웹에도 반영 — 채널을 오가도 맥락은 하나다.
  useEffect(() => {
    const t = setInterval(() => {
      if (busy) return; // 내가 보내는 중엔 낙관적 UI를 덮지 않는다
      api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)
        .then((r) => {
          const msgs = r.messages ?? [];
          setThread((cur) => {
            if (cur === null || msgs.length <= cur.length) return cur;
            // 다른 창구의 새 대화로 갈아끼울 때도 실패한 내 글은 잃지 않는다(서버엔 없는 사본이라 덮으면 소실)
            const unsent = cur.filter((m) => m.failed);
            return unsent.length ? [...msgs, ...unsent] : msgs;
          });
          if (r.sessionId) sessionRef.current = r.sessionId;
          setLiveStage(r.status ?? null); // 결재 후속·루틴·메신저발 턴도 진행 카드가 보인다
          setThreadTitle(r.title ?? null); // 다른 기기에서 바꾼 현재 대화명도 준실시간 반영(검수 LOW)
        })
        .catch(() => {});
    }, 3000); // 준실시간 — 동기화(≈8s)로 당겨온 다른 기기의 대화를 더 빨리 표시(기존 8s)
    return () => clearInterval(t);
  }, [ws, slug, busy]);

  // 이 크루의 대기 결재 — 대화창에서 바로 승인/거절 (데크 결재함은 백업 창구)
  const [pendings, setPendings] = useState([]);
  const [resolving, setResolving] = useState('');
  useEffect(() => {
    let alive = true;
    const pull = () => api(`/api/companies/${ws}/approvals`)
      .then((d) => { if (alive) setPendings((d.approvals ?? []).filter((a) => a.status === 'pending' && (a.slug === slug || a.from === slug))); })
      .catch(() => {});
    pull();
    const t1 = setInterval(pull, busy ? 2500 : 5000);
    return () => { alive = false; clearInterval(t1); };
  }, [ws, slug, busy]);

  async function resolvePending(id, approve) {
    if (resolving) return;
    setResolving(id);
    try {
      await api(`/api/companies/${ws}/approvals`, { id, approve });
      setPendings((cur) => cur.filter((p) => p.id !== id));
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setResolving('');
    }
  }

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStage((s) => Math.min(s + 1, WAIT_STAGES.length - 1)), 14000);
    return () => clearInterval(t);
  }, [busy]);

  const working = busy || !!liveStage; // 내가 보낸 턴 + 결재 후속·루틴·메신저발 턴
  useEffect(() => {
    if (!working) { setElapsed(0); return; }
    if (busy) startRef.current = Date.now();
    const tick = () => setElapsed(Date.now() - (busy ? startRef.current : (liveStage?.startedAt ?? Date.now())));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [busy, working, liveStage?.startedAt]);

  // 진행 단계 고빈도 폴 — 턴이 도는 동안(내 턴 + 시운전·루틴·메신저발) 2.5초 간격.
  // 서버가 턴 종료 시 상태 파일을 지우므로, status가 null로 돌아오면 스스로 멎는다.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => {
      api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)
        .then((r) => setLiveStage(r.status ?? null))
        .catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [working, ws, slug]);

  /** 파일 추가 — 드롭·붙여넣기·클립 버튼 모두 이 관문을 지난다. 업로드 즉시 vault/files/ 저장. */
  async function addFiles(fileList, { announceEmpty = false } = {}) {
    const files = [...(fileList ?? [])].filter(Boolean);
    // 조용한 실패 금지 — 드롭에서 아무것도 못 꺼내면 왜 안 됐는지와 대안을 알려준다(예전엔 무반응이라 "그냥 안 됨"으로 보였다)
    if (!files.length) { if (announceEmpty) setError(t('chat.dropUnreadable')); return; }
    if (uploading) return;
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('file', f));
      const r = await fetch(`/api/companies/${ws}/chat/upload`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setAtt((cur) => [...cur, ...d.files].slice(0, 8));
    } catch (err) {
      setError(t('chat.attachFailed', { msg: String(err.message) }));
    } finally {
      setUploading(false);
    }
  }

  async function sendMessage(message, attachments = []) {
    if (!message || busy || uploading) return;
    setError(''); setBusy(true); setStage(0);
    // 낙관적 표시 — 서버는 턴이 끝난 뒤에야 저장하므로(route.js appendTurn) 도중엔 이 사본이 사장 글의 유일한 원본이다.
    // 그래서 실패해도 스레드에서 빼지 않는다. 빼면 글이 어디에도 남지 않고 입력창으로 되돌아가 "보낸 게 사라졌다"가 된다.
    const mid = `s${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setThread((t) => [...(t ?? []), { who: 'user', text: message, mid, ...(attachments.length ? { attachments } : {}) }]);
    pinRef.current = mid; // 방금 보낸 글을 화면 상단에 붙인다 — 그 아래로 작업 과정·답변이 흐르도록
    try {
      const r = await api(`/api/companies/${ws}/chat`, { slug, message, sessionId: sessionRef.current, attachments });
      sessionRef.current = r.sessionId;
      setThread((t) => [...t.map((m) => (m.mid === mid ? { ...m, failed: undefined } : m)), { who: 'crew', text: r.reply, handover: r.handover }]);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      // 실패 턴은 서버에 저장되지 않는다 — 글은 스레드에 남겨 두고 실패 표시만 붙인다(재전송 버튼이 그대로 재시도 경로)
      const msg = String(err.message);
      const label = msg === '중단됨' ? t('chat.aborted') : t('chat.turnFailed', { msg });
      setThread((cur) => (cur ?? []).map((m) => (m.mid === mid ? { ...m, failed: label } : m)));
    } finally {
      setBusy(false);
      setLiveStage(null); // 내 턴 종료 — 마지막 partial이 완성 답변과 겹쳐 보이지 않게 즉시 내린다
    }
  }

  async function send(e) {
    e.preventDefault();
    const message = input.trim();
    if (!message) return;
    const attachments = att;
    histIdx.current = -1; // 히스토리로 불러온 지시를 전송했으면 탐색 위치 초기화
    setInput(''); setAtt([]);
    await sendMessage(message, attachments);
  }

  // 사장의 정지 버튼 — 진행 중 턴(내 턴·루틴·메신저발 모두)을 멈춘다
  const [aborting, setAborting] = useState(false);
  async function abortTurn() {
    if (aborting) return;
    setAborting(true);
    try { await api(`/api/companies/${ws}/chat/abort`, { slug }); } catch { /* 이미 끝난 턴 */ }
    finally { setAborting(false); }
  }

  // 메시지 복사 — 잠깐 "복사됨"으로 바뀌는 피드백
  const [copied, setCopied] = useState(-1);
  function copyMsg(i, text) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(i);
      setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1500);
    }).catch(() => {});
  }

  // 부분 코멘트(빨간펜) — 답변에서 고칠 부분을 드래그로 인용하고, 코멘트를 모아 묶음 수정 지시로 보낸다.
  // "전체 다시 써" 대신 "여기 이 문장만" — 상사가 보고서에 빨간펜 긋는 방식 그대로.
  const [annotIdx, setAnnotIdx] = useState(null);   // 코멘트 다는 중인 답변 index
  const [annotItems, setAnnotItems] = useState([]); // [{quote, note}]
  const [pendQuote, setPendQuote] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  function resetAnnot() { setAnnotIdx(null); setAnnotItems([]); setPendQuote(''); setNoteDraft(''); }
  function toggleAnnot(i) { annotIdx === i ? resetAnnot() : (resetAnnot(), setAnnotIdx(i)); }
  function captureQuote() {
    const sel = String(window.getSelection?.() ?? '').replace(/\s+/g, ' ').trim();
    if (sel) setPendQuote(sel.slice(0, 240));
  }
  function addAnnot() {
    if (!pendQuote || !noteDraft.trim()) return;
    setAnnotItems((cur) => [...cur, { quote: pendQuote, note: noteDraft.trim() }].slice(0, 8));
    setPendQuote(''); setNoteDraft('');
    window.getSelection?.()?.removeAllRanges?.();
  }
  async function sendAnnots() {
    if (!annotItems.length || busy) return;
    const body = annotItems.map((a, j) => `${j + 1}. "${a.quote}"\n   → ${a.note}`).join('\n\n');
    const message = `${t('chat.annotate.msgHead')}\n\n${body}`;
    resetAnnot();
    await sendMessage(message);
  }

  async function newChat() {
    if (busy) return;
    // 현재 대화는 서버(resetThread)가 .archive로 적재한 뒤 비우므로 비파괴 — 확인창 없이 바로 새 대화.
    // window.confirm은 Tauri 데스크톱 웹뷰에서 막혀 무동작(버튼이 안 열리던 원인) → 제거. 파괴적 액션만 DangerModal.
    await fetch(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
    setThread([]); sessionRef.current = null; setError(''); setThreadTitle(null);
    setViewing(null); setArchMsgs(null); resetAnnot();
    loadSessions(); // 방금 넘긴 대화가 좌측 레일에 적재된다
  }

  return (
    // 세션레일(216, 좌측 원위치) + 채팅 컬럼(나머지 전체). 채팅은 .thread를 컬럼 전체폭으로 두고 안쪽 레인만 중앙정렬 →
    // 스크롤바는 컬럼 우측 끝에 고정되고 메시지는 중앙 레인에 담긴다(가장 LLM다운 형태).
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start', height: 'calc(100vh - 100px)', marginBottom: -70 }}>
      {/* offset 100 = topbar56+상단26+하단여백18, marginBottom -70 = .content 하단 패딩(88) 상쇄로 body 스크롤 방지. 회의실·컨테스트와 동일(입력창 하향·대화영역 확대, 스레드만 내부 스크롤). */}
      {/* 세션 레일 — 대화가 여기 적재된다. 무템플릿 grid는 트랙이 max-content로 자라 긴 제목이 폭을 밀어낸다 — minmax(0,1fr) 고정 */}
      <div className="side-rail" style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('chat.sessions.title')}{sessions.length ? ` · ${sessions.length + 1}` : ''}
        </span>
        <div className="rail-item" style={{ position: 'relative' }}>
          <button className={`nav-item${!viewing ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', paddingRight: 30 }} onClick={() => openSession(null)}>
            <span style={{ minWidth: 0 }}>
              {/* 사장이 이름을 붙였으면 그 이름을 — '현재 대화'는 이름 없을 때의 기본 라벨일 뿐 */}
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{threadTitle || t('chat.sessions.current')}</span>
              <span className="nav-sub">{thread?.length ? t('chat.sessions.msgs', { n: thread.length }) : t('chat.newSession')}</span>
            </span>
          </button>
          <span className="rail-actions" style={{ position: 'absolute', right: 5, top: 7, display: 'flex' }}>
            <button type="button" title={t('chat.sessions.rename')} aria-label={t('chat.sessions.rename')}
              onClick={(e) => { e.stopPropagation(); setRenameSess({ id: null, title: threadTitle, gist: '' }); }}
              style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: !viewing ? 'var(--primary-fg)' : 'var(--fg-3)', cursor: 'pointer', borderRadius: 6 }}>
              <Icon name="edit" size={12} />
            </button>
          </span>
        </div>
        {sessions.map((s) => {
          const active = viewing === s.id;
          // 활성 행 배경은 골드(--primary)라 골드 핀이 묻힌다 — 활성이면 온-골드 전경색(--primary-fg)으로 대비 확보.
          // 인라인 색이 .nav-item.active svg CSS를 특이도로 이기므로 여기서 활성 분기해야 실제로 바뀐다.
          const pinColor = active ? 'var(--primary-fg)' : 'var(--primary)';
          const actColor = active ? 'var(--primary-fg)' : 'var(--fg-3)';
          return (
          <div key={s.id} className="rail-item" style={{ position: 'relative' }}>
            <button className={`nav-item${active ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', paddingRight: 66 }} onClick={() => openSession(s.id)}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600 }}>
                  {/* 고정 표식 — 상시 노출(hover 아니어도) so 어느 대화가 고정됐는지 한눈에 */}
                  {s.pinned && <Icon name="pin" size={11} style={{ flex: 'none', color: pinColor }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title || s.gist || t('chat.sessions.untitled')}</span>
                </span>
                <span className="nav-sub">{new Date(s.ts).toLocaleDateString('sv-SE')} · {t('chat.sessions.msgs', { n: s.count })}</span>
              </span>
            </button>
            {/* 호버 시 노출 — 고정 토글 / 대화명 편집 / 삭제(보관함으로) */}
            <span className="rail-actions" style={{ position: 'absolute', right: 5, top: 7, display: 'flex', gap: 1 }}>
              <button type="button" title={s.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')} aria-label={s.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')}
                onClick={(e) => { e.stopPropagation(); doTogglePin(s); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: s.pinned ? pinColor : actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="pin" size={12} />
              </button>
              <button type="button" title={t('chat.sessions.rename')} aria-label={t('chat.sessions.rename')}
                onClick={(e) => { e.stopPropagation(); setRenameSess(s); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="edit" size={12} />
              </button>
              <button type="button" title={t('chat.sessions.delete')} aria-label={t('chat.sessions.delete')}
                onClick={(e) => { e.stopPropagation(); setTrashSess(s); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="trash" size={12} />
              </button>
            </span>
          </div>
          );
        })}
        {sessions.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('chat.sessions.empty')}</span>}
      </div>
    <div
      style={{ width: '100%', display: 'grid', gridTemplateRows: '1fr auto', height: '100%', minHeight: 0, position: 'relative' }}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
    >
      {dragOver && <div className="drop-overlay">{t('chat.dropHere')}</div>}
      {/* 크루 컨트롤은 타이틀바 슬롯으로 — 콘텐츠 위 스티키 밴드 대신 topbar에 상주(테마 무관) */}
      {slotEl && createPortal(
        <>
          <span className="nav-sub" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent?.role}</span>
          {sessionRef.current ? (
            <span className="pill ok" style={{ flex: 'none' }}><span className="dot" />{t('chat.sessionOngoing')}</span>
          ) : (
            <span className="pill" style={{ flex: 'none' }}><span className="dot" />{t('chat.newSession')}</span>
          )}
          <button className="btn sm" style={{ flex: 'none' }} onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>{t('crew.panel.open')}</button>
          <button className="btn sm" style={{ flex: 'none' }} onClick={() => setCardOpen(true)}>{t('chat.card')}</button>
          <button className="btn sm" style={{ flex: 'none' }} onClick={newChat} disabled={busy || !(thread?.length)}>{t('chat.newChat')}</button>
        </>,
        slotEl,
      )}

      <div className="thread" ref={threadRef} style={{ overflowY: 'auto', minHeight: 0 }}>
        {/* 안쪽 레인만 중앙정렬 — .thread(스크롤 컨테이너)는 컬럼 전체폭이라 스크롤바가 우측 끝에 고정된다.
            레인 래퍼가 flex 컬럼이어야 메시지 간 gap·유저버블 우측정렬(align-self)이 유지된다(.thread의 flex를 이 레인이 이어받음). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: '100%', maxWidth: LANE, margin: '0 auto' }}>
        {thread === null && (
          <><Skeleton h={46} w="60%" /><Skeleton h={90} /></>
        )}
        {!viewing && thread?.length === 0 && !busy && (
          <div className="empty fade-up">
            {agent?.tone && <p style={{ marginBottom: 6, color: 'var(--fg-2)' }}>"{agent.tone}"</p>}
            {t('chat.firstPrompt')}
          </div>
        )}
        {((viewing ? archMsgs : thread) ?? []).map((m, i) =>
          m.who === 'user' ? (
            <div key={i} className="msg-wrap fade-up" style={{ alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '75%' }}
              ref={(el) => { if (!m.mid) return; if (el) msgRefs.current.set(m.mid, el); else msgRefs.current.delete(m.mid); }}>
              <div className="msg-user" style={{ alignSelf: 'auto', maxWidth: '100%', whiteSpace: 'pre-wrap', ...(m.failed ? { opacity: 0.72 } : {}) }}>
                {m.attachments?.length > 0 && (
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: m.text ? 8 : 0 }}>
                    {m.attachments.map((a, j) => a.isImage ? (
                      <img key={j} className="att-thumb" src={`/api/companies/${ws}/files?rel=${encodeURIComponent(a.rel)}`} alt={a.name} />
                    ) : (
                      <span key={j} className="att-chip" style={{ borderColor: 'var(--primary-fg-line)', background: 'transparent', color: 'inherit' }}>
                        <Icon name="clip" size={11} /><span className="name">{a.name}</span>
                      </span>
                    ))}
                  </span>
                )}
                {m.text}
              </div>
              {/* 실패한 턴 — 글은 스레드에 그대로 두고 사유와 재시도만 붙인다(호버로 숨지 않게 항상 표시) */}
              {m.failed && !viewing && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, fontSize: 12, color: 'var(--danger)', maxWidth: '100%' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.failed}</span>
                  <button type="button" className="btn sm" style={{ flex: 'none' }} disabled={busy || uploading}
                    onClick={() => sendMessage(m.text, m.attachments ?? [])}>{t('chat.resend')}</button>
                </div>
              )}
              <div className="msg-actions">
                <button type="button" onClick={() => copyMsg(i, m.text)}>{copied === i ? t('chat.copied') : t('chat.copy')}</button>
                {!viewing && <button type="button" disabled={busy || uploading} onClick={() => sendMessage(m.text, m.attachments ?? [])}>{t('chat.resend')}</button>}
              </div>
            </div>
          ) : (
            <div key={i} className="msg-crew fade-up">
              <Avatar name={agent?.name} sm />
              <div className="msg-wrap">
                <div className="card" style={{ minWidth: 0, padding: '13px 16px', ...(annotIdx === i ? { borderColor: 'var(--primary)', cursor: 'text' } : {}) }}
                  onMouseUp={annotIdx === i ? captureQuote : undefined}>
                  <Markdown text={m.text} />
                  {m.handover && (
                    <a className="memo-chip" href={`/c/${ws}/vault?doc=${encodeURIComponent(m.handover.rel)}`}>
                      <Icon name="memory" size={12} />
                      {t('chat.recordedInMemory')}
                      {m.handover.linked?.length > 0 && <span>{t('chat.linkedMemories', { n: m.handover.linked.length })}</span>}
                    </a>
                  )}
                </div>
                <div className="msg-actions">
                  <button type="button" onClick={() => copyMsg(i, m.text)}>{copied === i ? t('chat.copied') : t('chat.copy')}</button>
                  {!viewing && (
                    <button type="button" disabled={busy} onClick={() => toggleAnnot(i)}>
                      {annotIdx === i ? t('common.cancel') : t('chat.annotate')}
                    </button>
                  )}
                </div>
                {/* 부분 코멘트 패널 — 인용 수집 + 묶음 전송 */}
                {!viewing && annotIdx === i && (
                  <div className="card fade-up" style={{ padding: '12px 14px', display: 'grid', gap: 9, borderColor: 'var(--primary)', minWidth: 0 }}>
                    <span className="microlabel">{t('chat.annotate.title')}</span>
                    {annotItems.map((a, j) => (
                      <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
                        <span style={{ flex: 'none', fontWeight: 700, color: 'var(--primary-strong)' }}>{j + 1}</span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', color: 'var(--fg-2)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{a.quote}"</span>
                          <span style={{ display: 'block' }}>→ {a.note}</span>
                        </span>
                        <button type="button" className="btn sm" style={{ flex: 'none' }} aria-label={t('common.cancel')}
                          onClick={() => setAnnotItems((c) => c.filter((_, k) => k !== j))}>✕</button>
                      </div>
                    ))}
                    {pendQuote ? (
                      <div style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--fg-2)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{pendQuote}"</span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input suppressHydrationWarning autoFocus
                            value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                            placeholder={t('chat.annotate.notePh')}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addAnnot(); } }}
                            style={{ flex: 1, minWidth: 0, background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '7px 10px', fontSize: 12.5, outline: 'none' }} />
                          <button type="button" className="btn sm" disabled={!noteDraft.trim()} onClick={addAnnot}>{t('chat.annotate.add')}</button>
                        </div>
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0 }}>{t('chat.annotate.hint')}</p>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" className="btn btn-primary sm" disabled={busy || !annotItems.length} onClick={sendAnnots}>
                        {t('chat.annotate.send', { n: annotItems.length })}
                      </button>
                      <button type="button" className="btn sm" onClick={resetAnnot}>{t('common.cancel')}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        )}
        {!viewing && pendings.map((p) => (
          <div key={p.id} className="msg-crew fade-up">
            <Avatar name={agent?.name} sm />
            <div className="card" style={{ padding: '13px 16px', minWidth: 0, flex: 1, borderColor: 'var(--accent)' }}>
              <div className="microlabel" style={{ marginBottom: 6, color: 'var(--accent)' }}>
                {p.kind === 'capability' ? t('chat.approval.capTitle') : t('chat.approval.pendingTitle')}
              </div>
              {/* 위임 흐름 표기 — 이 카드가 누구의 결재인지(이 크루가 위임한 동료의 요청 / 위임받아 진행 중) */}
              {p.slug !== slug ? (
                <div style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: '-2px 0 6px' }}>{t('chat.approval.viaDelegate', { name: p.crewName ?? p.slug })}</div>
              ) : p.from ? (
                <div style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: '-2px 0 6px' }}>{t('chat.approval.fromNote', { name: p.fromName ?? p.from })}</div>
              ) : null}
              <div style={{ fontSize: 13.5, fontWeight: 650 }}>{p.action}</div>
              {p.reason && <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 0', lineHeight: 1.55 }}>{p.reason}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
                <button className="btn btn-primary sm" disabled={!!resolving} onClick={() => resolvePending(p.id, true)}>
                  {resolving === p.id ? <Spinner size={12} /> : (p.kind === 'capability' ? t('chat.approval.yes') : t('common.approve'))}
                </button>
                <button className="btn sm" disabled={!!resolving} onClick={() => resolvePending(p.id, false)}>
                  {p.kind === 'capability' ? t('chat.approval.no') : t('common.reject')}
                </button>
              </div>
            </div>
          </div>
        ))}
        {!viewing && working && (
          <div className="msg-crew">
            <Avatar name={agent?.name} sm />
            <div className="card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minWidth: 0 }}>
              {/* 크루가 이미 말한 부분 — 완료를 기다리지 않고 흘러 들어온다(스트리밍 체감) */}
              {liveStage?.partial && (
                <div style={{ color: 'var(--fg-2)', fontSize: 13 }}><Markdown text={liveStage.partial} /></div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-2)', fontSize: 13, minWidth: 0 }}>
                <ArgoSpinner size={15} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t('chat.stageEllipsis', { stage: liveStage ? stageLabel(t, liveStage.stage, liveStage.detail) : WAIT_STAGES[stage] })}
                  {liveStage?.detail && liveStage.stage !== 'runner' && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', marginLeft: 8 }}>{liveStage.detail}</span>
                  )}
                </span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
                  {fmtElapsed(elapsed)}
                </span>
                <button type="button" className="btn sm" style={{ flex: 'none' }} disabled={aborting} onClick={abortTurn}>
                  {aborting ? <Spinner size={11} /> : t('chat.stop')}
                </button>
              </div>
            </div>
          </div>
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}
        {/* 작업 중 여백 — 방금 보낸 글을 화면 상단까지 밀어올릴 스크롤 여유를 만든다.
            이게 없으면 마지막 메시지가 컨테이너 바닥에 걸려 "내 글 위 / 작업 과정 아래" 배치가 성립하지 않는다.
            턴이 끝나면 사라져 대화가 자연스럽게 정렬된다. */}
        {!viewing && working && <div aria-hidden style={{ flex: 'none', height: 'calc(100vh - 180px)' }} />}
        <div ref={endRef} />
        </div>
      </div>

      {viewing ? (
        <div className="card card-float" style={{ width: '100%', maxWidth: LANE, margin: '12px auto 0', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
          <Icon name="doc" size={13} /> {t('chat.sessions.readonly')}
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary sm" disabled={busy} onClick={resumeViewing}>{t('chat.sessions.resume')}</button>
          <button className="btn sm" onClick={() => openSession(null)}>{t('chat.sessions.back')}</button>
        </div>
      ) : (
      // 하단 고정 행(grid auto) — 스레드는 위 1fr 행에서 자체 스크롤되므로 컴포저는 겹침 없이 항상 하단. sticky·스크림 불필요(스크롤 시 입력창 뒤로 콘텐츠가 비치던 버그 제거).
      <div style={{ width: '100%', maxWidth: LANE, margin: '0 auto', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(att.length > 0 || uploading) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {att.map((a, i) => (
              <span key={i} className="att-chip">
                <Icon name="clip" size={11} />
                <span className="name">{a.name}</span>
                <button type="button" onClick={() => setAtt((c) => c.filter((_, j) => j !== i))} aria-label={t('common.delete')}>✕</button>
              </span>
            ))}
            {uploading && <span className="att-chip"><Spinner size={11} /> {t('chat.uploading')}</span>}
          </div>
        )}
        {/* 여러 줄 입력 — textarea(Enter 전송·Shift+Enter 줄바꿈). 버튼은 하단 정렬(입력이 자라도 자리 고정) */}
        <form onSubmit={send} className="input-bar" style={{ background: 'var(--card-2)', alignItems: 'flex-end', borderRadius: 22 }}>
          <button type="button" className="btn btn-icon sm" style={{ border: 0, flex: 'none', color: 'var(--fg-3)' }}
            onClick={() => fileRef.current?.click()} disabled={busy} aria-label={t('chat.attach')} title={t('chat.attach')}>
            <Icon name="clip" size={14} />
          </button>
          <input hidden multiple type="file" ref={fileRef} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea suppressHydrationWarning
            ref={inputRef}
            rows={1}
            placeholder={t('chat.inputPlaceholder', { name: agent?.name ?? t('chat.crewFallback') })}
            value={input}
            onChange={(e) => { histIdx.current = -1; setInput(e.target.value); }}
            onKeyDown={onInputKeyDown}
            onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            disabled={busy}
            autoFocus
          />
          <button className="btn btn-primary btn-icon" disabled={busy || uploading || !input.trim()} aria-label={t('chat.send')}>
            <Icon name="send" size={15} />
          </button>
        </form>
        {/* 입력창 아래 슬림 줄 — 우측 텍스트형 모델 버튼(클릭 시 위로 팝오버). 레퍼런스: Claude Code 입력바 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 6px', minHeight: 18 }}>
          <ModelMenu runners={runners} sel={sel} onChange={saveRunner} disabled={busy} />
        </div>
      </div>
      )}

      {cardOpen && (
        <CardPanel
          agentName={agent?.name}
          ws={ws}
          slug={slug}
          runners={runners}
          sel={sel}
          onRunnerChange={saveRunner}
          onClose={() => setCardOpen(false)}
          onFired={() => { window.dispatchEvent(new Event('argo:refresh')); router.push(`/c/${ws}`); }}
        />
      )}

      {panelOpen && (
        <aside className="crew-drawer" role="dialog" aria-label={t('crew.panel.title')}>
          <div className="crew-drawer-tabs">
            <button type="button" className={`crew-tab${panelTab === 'tasks' ? ' active' : ''}`} onClick={() => setPanelTab('tasks')}>{t('crew.panel.tab.tasks')}</button>
            <button type="button" className={`crew-tab${panelTab === 'files' ? ' active' : ''}`} onClick={() => setPanelTab('files')}>{t('crew.panel.tab.files')}</button>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn sm" onClick={() => setPanelOpen(false)}>{t('crew.panel.close')}</button>
          </div>
          <div className="crew-drawer-body">
            {panelTab === 'tasks' && (() => {
              const run = panelTasks?.running ?? [];
              const rec = panelTasks?.recent ?? [];
              if (!run.length && !rec.length) return <div className="crew-drawer-empty">{t('crew.panel.tasks.empty')}</div>;
              return (
                <>
                  {run.map((r) => (
                    <div key={r.slug} className="task-row">
                      <ArgoSpinner size={14} />
                      <span className="t-main">
                        <span className="t-title">{stageLabel(t, r.stage, r.detail)}</span>
                        <span className="t-sub mono">{r.stage === 'runner' ? '' : (r.detail || '')}</span>
                      </span>
                    </div>
                  ))}
                  {rec.length > 0 && <div className="microlabel" style={{ padding: '10px 12px 4px' }}>{t('crew.panel.tasks.recent')}</div>}
                  {rec.map((e, i) => (
                    <a key={e.ts ?? i} className="task-row" href={`/c/${ws}/activity`}>
                      <span style={{ width: 6, height: 6, borderRadius: 999, flex: 'none', background: e.ok ? 'var(--ok)' : 'var(--danger)' }} aria-hidden="true" />
                      <span className="t-main"><span className="t-title">{e.gist || t(`tasks.type.${e.type}`)}</span></span>
                    </a>
                  ))}
                </>
              );
            })()}
            {panelTab === 'files' && (() => {
              const files = ((viewing ? archMsgs : thread) ?? []).flatMap((m) => m.attachments ?? []);
              if (!files.length) return <div className="crew-drawer-empty">{t('crew.panel.files.empty')}</div>;
              return (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '6px 8px' }}>
                  {files.map((a, i) => a.isImage ? (
                    <a key={i} href={`/api/companies/${ws}/files?rel=${encodeURIComponent(a.rel)}`} target="_blank" rel="noopener noreferrer">
                      <img className="att-thumb" src={`/api/companies/${ws}/files?rel=${encodeURIComponent(a.rel)}`} alt={a.name} />
                    </a>
                  ) : (
                    <a key={i} className="att-chip" href={`/api/companies/${ws}/files?rel=${encodeURIComponent(a.rel)}`} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
                      <Icon name="clip" size={11} /><span className="name">{a.name}</span>
                    </a>
                  ))}
                </div>
              );
            })()}
          </div>
        </aside>
      )}

      {renameSess && (
        <InputModal
          title={t('chat.sessions.renameTitle')}
          defaultValue={renameSess.title || renameSess.gist || ''}
          placeholder={t('chat.sessions.renamePh')}
          confirmLabel={t('common.save')}
          onConfirm={doRenameSess}
          onClose={() => setRenameSess(null)}
        />
      )}
      {trashSess && (
        <ConfirmModal
          title={t('chat.sessions.deleteTitle')}
          description={t('chat.sessions.deleteConfirm')}
          confirmLabel={t('chat.sessions.deleteDo')}
          tone="danger"
          onConfirm={doTrashSess}
          onClose={() => setTrashSess(null)}
        />
      )}
    </div>
    </div>
  );
}

/** 채팅바 모델 메뉴 — 텍스트 버튼("Claude Code · Fable 5") 클릭 시 위로 뜨는 팝오버.
    러너를 그룹 헤더로, 그 아래 모델(기본 포함)을 항목으로. 선택 즉시 저장(다음 턴부터 적용). */
function ModelMenu({ runners, sel, onChange, disabled }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false); // 두 프레임 마운트 — scale 0.97→1 진입(끊김 없는 transition)
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) { setEntered(false); return; }
    const raf = requestAnimationFrame(() => setEntered(true));
    const away = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const cur = runners?.find((r) => r.id === sel.runner);
  const curModel = cur?.models?.find((m) => m.id === sel.model);
  // 모델 미선택(레거시 크루)이면 러너 이름만 — "기본" 같은 가짜 항목을 만들지 않는다
  const label = sel.model ? `${cur?.name ?? 'Claude Code'} · ${curModel?.label ?? sel.model}` : (cur?.name ?? 'Claude Code');
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button type="button" disabled={disabled || runners === null} onClick={() => setOpen((v) => !v)}
        aria-label={t('chat.engineLabel')} aria-expanded={open}
        style={{ background: 'none', border: 0, cursor: 'pointer', padding: '2px 4px', fontSize: 11.5,
          fontFamily: 'var(--mono)', color: 'var(--fg-3)', transition: 'color 150ms ease-out' }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-3)'; }}>
        {label} <span aria-hidden style={{ fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div className="card card-float" role="menu" style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, zIndex: 40,
          minWidth: 230, maxHeight: 320, overflowY: 'auto', padding: 6,
          boxShadow: '0 8px 28px rgba(0,0,0,.14)',
          transformOrigin: 'bottom right',
          transform: entered ? 'scale(1) translateY(0)' : 'scale(0.97) translateY(4px)',
          opacity: entered ? 1 : 0,
          transition: 'transform 160ms cubic-bezier(0.23, 1, 0.32, 1), opacity 160ms cubic-bezier(0.23, 1, 0.32, 1)',
        }}>
          {(runners ?? []).map((r) => (
            <div key={r.id} style={{ padding: '2px 0' }}>
              <div className="microlabel" style={{ padding: '4px 8px 2px', color: r.authed ? undefined : 'var(--fg-3)' }}>
                {r.name}{r.authed ? '' : ` — ${t('runner.needConnect')}`}
              </div>
              {(r.models ?? []).map((m) => {
                const active = sel.runner === r.id && (sel.model || '') === m.id;
                // 미연결 러너의 모델은 선택 불가 — 설정에서 연결(키/OAuth) 후에만 활성화
                return (
                  <button key={`${r.id}:${m.id}`} type="button" role="menuitemradio" aria-checked={active}
                    disabled={!r.authed}
                    onClick={() => { onChange({ runner: r.id, model: m.id }); setOpen(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                      background: active ? 'var(--card-2)' : 'none', border: 0, borderRadius: 7,
                      cursor: r.authed ? 'pointer' : 'not-allowed',
                      padding: '6px 8px', fontSize: 12.5, color: r.authed ? 'var(--fg)' : 'var(--fg-3)',
                      opacity: r.authed ? 1 : 0.55 }}>
                    <span style={{ flex: 1 }}>{m.label}</span>
                    {/* 접근권 게이트 모델(gated) — 무료 계정은 턴이 죽으므로 이유를 미리 보여준다 (강등 가드가 받쳐줌) */}
                    {m.gated && <span className="microlabel" style={{ fontSize: 9.5, color: 'var(--fg-3)' }}>{t('runner.gatedBadge')}</span>}
                    {active && <span aria-hidden style={{ fontSize: 11, color: 'var(--fg-2)' }}>✓</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 러너·모델 셀렉터 — 카드 패널 공용. authed=false 러너는 "— 연결 필요" 접미.
    회사 자격(?ws=)이 반영된 카탈로그라 호스트 로그인이 없어도 회사 키가 있으면 authed=true. */
function RunnerPicker({ runners, sel, onChange, disabled, compact }) {
  const { t } = useLang();
  const cur = runners?.find((r) => r.id === sel.runner);
  const runnerLabel = (r) => r.name + (r.authed ? '' : ` — ${t('runner.needConnect')}`);
  const box = {
    height: compact ? 28 : 30,
    padding: compact ? '0 7px' : '0 9px',
    background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8,
    outline: 'none', fontSize: compact ? 11.5 : 12, color: 'var(--fg)',
    fontFamily: 'var(--mono)', maxWidth: compact ? 190 : 260,
  };
  const busy = disabled || runners === null;
  return (
    <>
      <select value={sel.runner} disabled={busy} style={box}
        onChange={(e) => {
          const next = runners?.find((r) => r.id === e.target.value);
          // 러너를 바꾸면 그 러너의 첫 모델을 바로 선택 — "기본" 가짜 항목 없이 항상 실제 모델
          onChange({ runner: e.target.value, model: next?.models?.[0]?.id ?? '' });
        }}>
        {(runners ?? [{ id: 'claude', name: 'Claude Code', authed: true }]).map((r) => (
          <option key={r.id} value={r.id} disabled={!r.authed}>{runnerLabel(r)}</option>
        ))}
      </select>
      {/* 현재 러너가 미연결(레거시)이면 모델 선택도 잠금 — 설정에서 연결 후 활성화 */}
      <select value={sel.model} disabled={busy || (cur && !cur.authed)} style={box}
        onChange={(e) => onChange({ runner: sel.runner, model: e.target.value })}>
        {!sel.model && <option value="" disabled>—</option>}{/* 레거시 미선택 크루 표시용 */}
        {(cur?.models ?? []).map((m) => (
          <option key={m.id} value={m.id}>{m.label}{m.gated ? ` — ${t('runner.gatedBadge')}` : ''}</option>
        ))}
      </select>
    </>
  );
}

/** 카드 패널 — 카드가 곧 시스템 프롬프트. 열람·편집·해고(깃헙식 확인). */
/** 능력 범위 원문 해석 — 백엔드 parseScopeList와 동일 계약(''=전체→null, 'none'=[], csv=목록). */
const parseScopeStr = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.toLowerCase() === 'none') return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
};

/** 능력 범위 그룹 — 칩 토글(켜짐=사용). 설치 목록이 비면 렌더하지 않는다. */
function ScopeGroup({ label, items, value, onToggle, t }) {
  if (!items.length) return null;
  const cur = parseScopeStr(value);
  const ids = items.map((i) => i.id);
  const on = new Set(cur ?? ids);
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
      <span className="microlabel">
        {label} · {on.size}/{items.length}{cur === null ? ` — ${t('chat.card.scopeAll')}` : on.size === 0 ? ` — ${t('chat.card.scopeNone')}` : ''}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {items.map((it) => {
          const active = on.has(it.id);
          return (
            <button key={it.id} type="button" className="chip" onClick={() => onToggle(it.id, ids)} aria-pressed={active}
              style={{ cursor: 'pointer', ...(active ? { color: 'var(--ok)', borderColor: 'currentColor' } : { opacity: 0.5 }) }}>
              {active && <span className="dot" />}{it.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CardPanel({ ws, slug, agentName, runners, sel, onRunnerChange, onClose, onFired }) {
  const { t, fmtMoney } = useLang();
  useScrollLock();
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
  const [md, setMd] = useState(null);
  const [profile, setProfile] = useState({ recent: [], skills: [], mcp: [] });
  const [scope, setScope] = useState({ skills: '', mcp: '' }); // 카드 능력 범위 원문('' = 전체 사용)
  const [stats, setStats] = useState(null); // { turns, contextTotal, output, costUsd, avgMs, topTools }
  const [ruleInput, setRuleInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fireOpen, setFireOpen] = useState(false);
  const [firing, setFiring] = useState(false);
  // 기억 카드 — 회사가 아는 사장 (vault/notes/사장-프로필.md)
  const [boss, setBoss] = useState(null); // { items: [{section, text}] }
  const [bossInput, setBossInput] = useState('');
  const [bossSection, setBossSection] = useState('취향');
  // 능력 범위 저장 — 칩 토글 즉시 PATCH(엔진 셀렉터와 동일 관례). 전부 켬=''(전체), 전부 끔='none'.
  async function saveScope(field, next) {
    setScope((s) => ({ ...s, [field]: next }));
    try {
      const r = await fetch(`/api/companies/${ws}/agents/${slug}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
    } catch (e) { setMsg(String(e.message)); }
  }
  function toggleScope(field, ids, id) {
    const on = new Set(parseScopeStr(scope[field]) ?? ids);
    if (on.has(id)) on.delete(id); else on.add(id);
    const next = on.size === ids.length ? '' : on.size === 0 ? 'none' : ids.filter((x) => on.has(x)).join(', ');
    saveScope(field, next);
  }
  async function saveBoss(items) {
    try {
      const r = await fetch(`/api/companies/${ws}/boss-profile`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setBoss(d);
    } catch (e) { setMsg(String(e.message)); }
  }
  // 텔레그램 직통 봇 — 이 크루의 개인 연락처
  const [tgBot, setTgBot] = useState(null); // { hasToken, botUsername, paired }
  const [tgAlive, setTgAlive] = useState(false);
  const [tgToken, setTgToken] = useState('');
  const [tgBusy, setTgBusy] = useState(false);
  const [tgMsg, setTgMsg] = useState('');

  const loadTg = useCallback(() => {
    api(`/api/companies/${ws}/connections`).then((d) => {
      setTgBot(d.connections?.telegram?.agents?.[slug] ?? { hasToken: false });
      setTgAlive(!!d.gateway?.agents?.[slug]?.alive);
    }).catch(() => {});
  }, [ws, slug]);

  useEffect(() => {
    api(`/api/companies/${ws}/agents/${slug}`)
      .then((d) => {
        setMd(d.md); setStats(d.stats ?? null);
        setProfile({ recent: d.recent ?? [], skills: d.skills ?? [], mcp: d.mcp ?? [] });
        setScope({ skills: d.meta?.skills ?? '', mcp: d.meta?.mcp ?? '' });
      })
      .catch((e) => setMsg(String(e.message)));
    api(`/api/companies/${ws}/boss-profile`).then(setBoss).catch(() => setBoss({ items: [] }));
    loadTg();
    const iv = setInterval(loadTg, 10000);
    return () => clearInterval(iv);
  }, [ws, slug, loadTg]);

  async function tgConnect() {
    if (tgBusy || !tgToken.trim()) return;
    setTgBusy(true); setTgMsg('');
    try {
      const d = await api(`/api/companies/${ws}/agents/${slug}/telegram`, { token: tgToken });
      setTgBot(d.connections?.telegram?.agents?.[slug] ?? { hasToken: true });
      setTgToken(''); setTgMsg(t('chat.tg.pairHint'));
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setTgMsg(String(e.message)); } finally { setTgBusy(false); }
  }
  async function tgDisconnect() {
    if (tgBusy) return;
    setTgBusy(true); setTgMsg('');
    try {
      await fetch(`/api/companies/${ws}/agents/${slug}/telegram`, { method: 'DELETE' });
      setTgBot({ hasToken: false }); setTgAlive(false);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setTgMsg(String(e.message)); } finally { setTgBusy(false); }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(next = md) {
    if (saving || next === null) return;
    setSaving(true); setMsg('');
    try {
      await fetch(`/api/companies/${ws}/agents/${slug}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ md: next }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      window.dispatchEvent(new Event('argo:refresh'));
      setMsg(t('chat.saved'));
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  // 규칙(## 일하는 방식) — 카드 md에서 파싱해 보여주고, 추가하면 그 섹션에 불릿으로 append 후 즉시 저장
  const rules = (() => {
    const m = (md ?? '').match(/## 일하는 방식\s*\n([\s\S]*?)(?=\n## |$)/);
    return m ? m[1].split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter((l) => l && !l.startsWith('(')) : [];
  })();
  function addRule() {
    const text = ruleInput.trim();
    if (!text || md === null) return;
    const h = '## 일하는 방식';
    let next;
    const i = md.indexOf(h);
    if (i === -1) {
      next = `${md.trimEnd()}\n\n${h}\n- ${text}\n`;
    } else {
      const rest = md.indexOf('\n## ', i + h.length);
      const end = rest === -1 ? md.length : rest;
      next = `${md.slice(0, end).trimEnd()}\n- ${text}\n${rest === -1 ? '' : md.slice(end)}`;
    }
    setMd(next); setRuleInput('');
    save(next);
  }

  async function fire() {
    setFiring(true);
    await fetch(`/api/companies/${ws}/agents/${slug}`, { method: 'DELETE' });
    onFired();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card card-float fade-up" style={{ width: 'min(680px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{t('chat.cardTitle')}</span>
          <span className="microlabel">{t('chat.systemPromptEq')}</span>
          <span className="rule" />
          <button className="btn sm" onClick={onClose}>{t('chat.closeEsc')}</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>
          {/* 크루 프로필 — 자주 하는 업무와 적용 스킬이 카드에서 한눈에 */}
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="microlabel">{t('chat.recentWork')}</span>
            {profile.recent.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.noRecentWork')}</span>
            ) : (
              <div style={{ display: 'grid', gap: 3 }}>
                {profile.recent.slice(0, 5).map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                    <span style={{ width: 5, height: 5, borderRadius: 999, flex: 'none', background: r.ok ? 'var(--ok)' : 'var(--danger)' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.gist}</span>
                  </div>
                ))}
              </div>
            )}
            {/* 능력 범위 — 설치는 회사 공용(모든 크루 기본), 크루별로 좁힐 수 있다(유건 지시 2026-07-19).
                칩 토글 = 즉시 저장(엔진 셀렉터와 동일 관례). 전부 켬=''(전체 — 새 설치 자동 포함), 전부 끔='none'. */}
            <ScopeGroup label={t('chat.card.scopeSkills')} items={profile.skills.map((s) => ({ id: s.id, title: s.title }))}
              value={scope.skills} onToggle={(id, ids) => toggleScope('skills', ids, id)} t={t} />
            <ScopeGroup label={t('chat.card.scopeMcp')} items={profile.mcp.map((n) => ({ id: n, title: n }))}
              value={scope.mcp} onToggle={(id, ids) => toggleScope('mcp', ids, id)} t={t} />
          </div>
          {/* 엔진 — 러너·모델을 카드에서 바로 선택. 채팅 셀렉터와 같은 상태(즉시 저장). */}
          <div style={{ display: 'grid', gap: 7 }}>
            <span className="microlabel">{t('chat.card.engine')}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <RunnerPicker runners={runners} sel={sel} onChange={onRunnerChange} />
            </div>
          </div>
          {/* 상세 정보 — 처리량·토큰·비용·많이 쓴 도구 (usage.jsonl 집계) */}
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="microlabel">{t('chat.card.stats')}</span>
            {!stats || stats.turns === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.card.noStats')}</span>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                  {[
                    [t('chat.card.turns'), String(stats.turns)],
                    [t('chat.card.tokens'), `${fmtTok(stats.contextTotal)} / ${fmtTok(stats.output)}`],
                    [t('chat.card.cost'), stats.costUsd != null ? fmtMoney(stats.costUsd, { approx: false }) : '—'],
                    [t('chat.card.avgTime'), stats.avgMs != null ? `${(stats.avgMs / 1000).toFixed(0)}s` : '—'],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 650 }}>{v}</div>
                      <div className="microlabel" style={{ marginTop: 2 }}>{k}</div>
                    </div>
                  ))}
                </div>
                {stats.topTools?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                    <span className="microlabel">{t('chat.card.topTools')}</span>
                    {stats.topTools.map((tool) => (
                      <span key={tool.name} className="chip mono" style={{ fontSize: 10.5 }}>{tool.name} ×{tool.count}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          {/* 규칙 — 카드의 "일하는 방식" 섹션을 그대로 파싱. 추가하면 카드에 불릿으로 붙고 즉시 저장 */}
          <div style={{ display: 'grid', gap: 7 }}>
            <span className="microlabel">{t('chat.card.rules')} · {rules.length}</span>
            {rules.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.card.noRules')}</span>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {rules.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 7 }}>
                    <span style={{ color: 'var(--fg-3)', flex: 'none' }}>{i + 1}.</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input suppressHydrationWarning value={ruleInput} onChange={(e) => setRuleInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addRule(); } }}
                placeholder={t('chat.card.addRulePh')}
                style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }} />
              <button className="btn sm" disabled={saving || !ruleInput.trim()} onClick={addRule}>{t('chat.card.add')}</button>
            </div>
          </div>
          {/* 기억 카드 — 회사가 아는 사장. 크루가 대화에서 자동 축적, 여기서 정정("그거 잊어") */}
          <div style={{ display: 'grid', gap: 7 }}>
            <span className="microlabel">{t('chat.boss.title')}{boss?.items?.length ? ` · ${boss.items.length}` : ''}</span>
            {!boss ? <Skeleton h={40} /> : boss.items.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.boss.empty')}</span>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {boss.items.map((it, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                    <span className="chip" style={{ flex: 'none', fontSize: 10 }}>{t(`chat.boss.sec.${it.section}`)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>{it.text}</span>
                    <button className="btn sm" style={{ flex: 'none', padding: '1px 8px', fontSize: 10.5 }}
                      title={t('chat.boss.forget')}
                      onClick={() => saveBoss(boss.items.filter((_, j) => j !== i))}>
                      {t('chat.boss.forget')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={bossSection} onChange={(e) => setBossSection(e.target.value)}
                style={{ height: 30, padding: '0 8px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }}>
                {['취향', '결정', '금지'].map((s) => <option key={s} value={s}>{t(`chat.boss.sec.${s}`)}</option>)}
              </select>
              <input suppressHydrationWarning value={bossInput} onChange={(e) => setBossInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && bossInput.trim()) { e.preventDefault(); saveBoss([...(boss?.items ?? []), { section: bossSection, text: bossInput.trim() }]); setBossInput(''); } }}
                placeholder={t('chat.boss.addPh')}
                style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }} />
              <button className="btn sm" disabled={!bossInput.trim()}
                onClick={() => { saveBoss([...(boss?.items ?? []), { section: bossSection, text: bossInput.trim() }]); setBossInput(''); }}>
                {t('chat.card.add')}
              </button>
            </div>
          </div>
          {/* 텔레그램 직통 봇 — 이 크루의 개인 연락처. 연결되면 그린 도트 */}
          <div style={{ display: 'grid', gap: 7, padding: '12px 14px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="microlabel">{t('chat.tg.title')}</span>
              {tgBot?.hasToken && (
                <span className="chip" style={{ color: tgAlive ? 'var(--ok)' : 'var(--warn)', borderColor: 'currentColor' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor', display: 'inline-block', marginRight: 5 }} />
                  {tgAlive ? t('chat.tg.live') : t('chat.tg.waiting')}
                  {tgBot.paired ? ` · ${t('chat.tg.paired')}` : ''}
                </span>
              )}
              {tgBot?.botUsername && <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{tgBot.botUsername}</span>}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('chat.tg.help')}</p>
            {/* 페어링 코드 — 봇에 먼저 말건 사람이 주인이 되는 것 차단. 미페어링 상태에서만 노출 */}
            {tgBot?.hasToken && !tgBot?.paired && tgBot?.pairCode && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--border)' }}>
                <span className="microlabel" style={{ flex: 'none' }}>{t('settings.conn.pairCodeLabel')}</span>
                <span className="mono" style={{ fontSize: 17, letterSpacing: 3, fontWeight: 600 }}>{tgBot.pairCode}</span>
                <button type="button" className="btn sm" style={{ flex: 'none' }}
                  onClick={() => navigator.clipboard?.writeText(tgBot.pairCode).catch(() => {})}>{t('common.copy')}</button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {tgBot?.hasToken ? (
                <button className="btn sm" disabled={tgBusy} onClick={tgDisconnect}>{t('chat.tg.disconnect')}</button>
              ) : (
                <>
                  <input suppressHydrationWarning type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)}
                    placeholder={t('chat.tg.placeholder')}
                    style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }} />
                  <button className="btn btn-primary sm" disabled={tgBusy || !tgToken.trim()} onClick={tgConnect}>
                    {tgBusy ? <Spinner size={12} /> : t('chat.tg.connect')}
                  </button>
                </>
              )}
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{tgMsg}</span>
            </div>
          </div>
          <span className="microlabel">{t('chat.card.raw')}</span>
          {md === null ? (
            <Skeleton h={220} />
          ) : (
            <textarea
              value={md}
              onChange={(e) => setMd(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 320, resize: 'vertical',
                background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12,
                padding: '12px 14px', outline: 'none',
                fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.65,
              }}
            />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-primary sm" onClick={() => save()} disabled={saving || md === null}>
              {saving ? <Spinner size={12} /> : t('chat.save')}
            </button>
            <span style={{ fontSize: 12, color: msg === t('chat.saved') ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => setFireOpen(true)}>{t('chat.fire')}</button>
          </div>
        </div>
      </div>
      {fireOpen && (
        <DangerModal
          title={t('chat.fireTitle')}
          description={t('chat.fireDesc')}
          requireText={agentName || slug}
          phraseKey="danger.phrase.fire"
          confirmLabel={t('chat.fireConfirm')}
          busy={firing}
          onConfirm={fire}
          onClose={() => setFireOpen(false)}
        />
      )}
    </div>
  );
}
