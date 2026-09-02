'use client';
// 회의실 — 사장 + 여러 크루가 한 방에서. "@이름"으로 부르면 그 크루들이 순서대로 발언한다.
// 좌측 레일에 지난 회의가 적재되고(회의 마치기), 클릭으로 읽기 전용 열람 — 맥락 공유가 눈에 보이는 화면.
import { use, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, Spinner, InputModal, api, imeGuardWith } from '../../../ui';
import { useLang, stageLabel } from '../../../i18n';
import { dropUpClamp } from '../zoom-math.mjs';
import { ArtifactChips } from '../artifact-chips';
import { matchSlash, SLASH_TOKEN_RE } from '../slash-match.mjs';
import { keepSide, sideParam, withSide } from '../split.mjs';
import { useSplitAlive } from '../split-alive';
import { useWorkFolder, WorkFolderPopover, WorkFolderRow, WorkFolderButton } from '../work-folder';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// 크루 대화와 같은 읽기 레인(crew/[slug]/page.jsx LANE과 같은 값) — 대화 영역·입력창·아래 줄이 이 폭에 가운데 정렬(유건 지시 2026-09-02: 입력창이 너무 길다)
const LANE = 'min(768px, 100%)';

export default function Room({ params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const router = useRouter();
  const [agents, setAgents] = useState([]);
  const [messages, setMessages] = useState(null);
  const [input, setInput] = useState('');
  // 입력 보존 — 페이지 이동·새로고침에도 쓰던 안건이 남는다(유건 요청 2026-09-02). 크루 채팅(crew/[slug])의
  // argo-draft 패턴(마운트 복원·입력 따라 저장/제거): input 상태를 따라가므로 전송(setInput(''))이면 자동 삭제.
  // 실패 시 복원 조건은 크루와 다르다 — 회의실은 서버가 크루 실행 전에 안건을 저장하므로 send()의 saved 분기 참조.
  // 키 이름공간 '@room' — 크루 슬러그([a-z0-9-])와 절대 겹치지 않게('room'이라는 크루가 있어도 충돌 0).
  const draftKey = `argo-draft:${ws}:@room`;
  useEffect(() => {
    try { const d = localStorage.getItem(draftKey); if (d) setInput((cur) => cur || d); } catch { /* 사파리 프라이빗 등 — 보존은 부가기능이라 실패해도 무시 */ }
  }, [draftKey]);
  useEffect(() => {
    try { if (input) localStorage.setItem(draftKey, input); else localStorage.removeItem(draftKey); } catch { /* 저장 불가 환경 — 무시 */ }
  }, [input, draftKey]);
  // 여러 줄 입력 — 줄바꿈(Shift+Enter)하면 입력창이 따라 자란다(유건 2026-08-23). 크루 대화창과 같은 규칙: 최대 6줄 후 내부 스크롤
  const composerRef = useRef(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    if (!input) { el.style.height = ''; return; }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [input]);
  const [busy, setBusy] = useState(false); // 자기 탭의 POST 대기
  // 서버에서 도는 턴(다른 탭·페이지 이동 후 복귀). busy와 분리하는 이유: 복원 상태에서는 폴링이 계속
  // 돌아야 답변이 들어오고 표시가 꺼진다 — busy 하나로 합치면 폴링(!busy)이 멈춰 영구 '회의 중'.
  const [serverBusy, setServerBusy] = useState(false);
  // 서버 턴의 발언자·단계·부분 텍스트·다음 순서(GET turn). 발언이 끝나야 말풍선이 통째로 뜨던 방을,
  // 크루 채팅처럼 쓰는 중인 문장이 자라며 보이게(유건 2026-09-02 "보는 재미"). 진행 판정(serverBusy)과 분리.
  const [turn, setTurn] = useState(null);
  const [error, setError] = useState('');
  // 회의 작업 폴더 — 크루 채팅과 같은 컴포넌트·계약(work-folder.jsx, 유건 지시 2026-09-02). 키 '@room'(서버
  // ROOM_FOLDER_SLUG — 크루 슬러그와 불충돌)로 고정하면 발언 크루 전원이 매 턴 "지금 일할 폴더"로 받는다
  // (src/room.mjs → chat workFolder). 기기 로컬(.workroots.json pins)이고 사장이 풀기 전까지 유지된다.
  const wf = useWorkFolder({ ws, slug: '@room', onError: (m) => setError(m), onPinned: () => composerRef.current?.focus() });
  const endRef = useRef(null);
  // 회의 적재 레일 — 마친 회의들이 좌측에 쌓인다
  const [sessions, setSessions] = useState([]);
  const [renameSess, setRenameSess] = useState(null); // 회의명 편집 모달 대상
  // 회의명 편집·고정 — 채팅 세션 레일과 동일 계약(PATCH {id,title}|{id,pinned})
  async function doRenameSess(title) {
    const sess = renameSess; setRenameSess(null);
    if (!sess) return;
    try {
      await fetch(`/api/companies/${ws}/room/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sess.id, title }),
      });
      loadSessions();
    } catch { /* 레일 갱신 실패는 다음 로드에서 복구 */ }
  }
  async function doTogglePin(sess) {
    try {
      await fetch(`/api/companies/${ws}/room/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sess.id, pinned: !sess.pinned }),
      });
      loadSessions();
    } catch { /* 동일 */ }
  }
  const [viewing, setViewing] = useState(null); // 보관 회의 id (null = 현재 회의)
  const [archMsgs, setArchMsgs] = useState(null);

  const loadSessions = useCallback(() => {
    api(`/api/companies/${ws}/room/sessions`).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
  }, [ws]);

  function load() {
    // 조회 실패를 '빈 회의실'로 붕괴시키지 않는다 — 회의 대화가 통째로 사라진 것처럼 보이던 실사용
    // 신고(2026-07-25 "크루들의 대화 내용이 사라지는 경우가 많습니다, 특히 회의실에서")의 원인.
    // 디스크의 회의록은 멀쩡한데 화면만 비는 케이스라, 실패는 에러로 드러내고 기존 표시를 유지한다.
    api(`/api/companies/${ws}/room`)
      .then((d) => { setMessages(d.messages ?? []); setServerBusy(!!d.turn?.active); setTurn(d.turn ?? null); setError(''); })
      .catch((e) => setError(String(e?.message || '') || t('room.loadFail')));
    api(`/api/companies/${ws}/agents`).then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }
  // 회의 다시 열기 — 보관 회의를 현재 방으로 되돌린다. 진행 중 회의가 있으면 서버가 409로 거절하므로
  // 덮어쓰기가 원천 차단된다(실사용 요청 2026-07-26 "보관한 회의를 다시 열어 이어갈 수 없나요").
  const [reopening, setReopening] = useState(null); // 진행 중인 id — 중복 클릭 차단
  // 라우트 오류 → 표시 언어. room_busy(크루 발언 중 — 새 회의·전환·마치기 공통 서버 게이트, apiError 바디의 errorCode)는
  // 사전 문구로 다시 그리고(언어 전환 직후·쿠키 없는 요청에도 화면 언어를 따른다), 그 외는 서버 문구 그대로.
  const routeError = (d, fallback = '') => new Error(d?.errorCode === 'room_busy' ? t('room.busyGate') : (d?.error || fallback));
  // 열기·전환 — 현재 회의가 있으면 서버가 '진행 중'으로 자동 보관하고 연다(종전 409 거절은 새 회의 분기로 폐지).
  async function doReopen(sess) {
    if (reopening || busy || serverBusy) return;
    setReopening(sess.id);
    try {
      const r = await fetch(`/api/companies/${ws}/room/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sess.id, reopen: true }),
      });
      if (!r.ok) { setError(routeError(await r.json().catch(() => ({})), t('room.reopenFail')).message); return; }
      setViewing(null); setArchMsgs(null); atBottomRef.current = true; setUnseen(false); // 보관 열람 상태 해제 — 되살린 회의는 '현재 회의'다(최신으로, 검수 D4)
      load(); loadSessions();
    } catch { setError(t('room.reopenFail')); } finally { setReopening(null); }
  }
  useEffect(load, [ws]);
  useEffect(loadSessions, [loadSessions]);
  useEffect(() => {
    // 진행 중엔 2.5초(크루 채팅의 busy 주기) — 부분 텍스트가 자라는 걸 보는 화면이라 8초면 끊겨 보인다.
    // 자기 턴(busy) 중에도 읽는다: 발언을 지켜보는 사람이 곧 안건을 올린 사람이다. 메시지 목록은 서버가 내
    // 안건을 이미 저장했을 때(길이 ≥ 로컬)만 받는다 — 저장 전 스냅샷이 낙관 말풍선을 지우지 않게. 그래야 앞 크루의
    // 완성 답변이 뒤 크루 발언 중에 보인다(격리 실측: 종전 !busy 동결은 턴이 다 끝나야 페퍼 답변이 떴다).
    const live = busy || serverBusy;
    const iv = setInterval(() => {
      api(`/api/companies/${ws}/room`).then((d) => {
        setTurn(d.turn ?? null); setServerBusy(!!d.turn?.active);
        const srv = d.messages ?? [];
        setMessages((cur) => (!busy || srv.length >= (cur?.length ?? 0)) ? srv : cur);
      }).catch(() => {});
    }, live ? 2500 : 8000);
    return () => clearInterval(iv);
  }, [ws, busy, serverBusy]);
  // 하단 추종은 **하단 근처(80px)일 때만** — 위로 올려 읽는 중에 새 발언이 와도 화면을 끌어내리지
  // 않는다(실사용 신고 2026-07-27 "윗 글을 읽을 수 없음"). 크루 채팅의 atBottom 판정(v0.1.21
  // 계열)과 같은 원칙. 떨어져 있으면 '새 메시지' 점프 칩만 띄운다.
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (atBottomRef.current) setUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  // 칩은 **실제 증가**에만(검수 D1: 8초 폴이 매번 새 배열을 넣어 내용 동일에도 켜졌다 — 거짓 신호).
  // 보관 열람 중엔 상태를 만들지 않는다(D2: viewing 중 쌓인 stale 칩). 하단이면 명시 해제(D3).
  const lastLenRef = useRef(0);
  useEffect(() => {
    const n = messages?.length ?? 0;
    const grew = n > lastLenRef.current;
    lastLenRef.current = n;
    if (viewing) return;
    if (atBottomRef.current) { setUnseen(false); endRef.current?.scrollIntoView({ block: 'end' }); }
    else if (grew) setUnseen(true);
  }, [messages, busy, viewing, turn?.partial, turn?.stage]); // 부분 텍스트가 자라는 동안에도 하단 추종(크루 채팅과 같은 규칙)
  const jumpToLatest = () => { atBottomRef.current = true; setUnseen(false); endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); };

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;

  // 발언자 클릭 → 그 크루의 개별 스레드를 옆 패널로(유건 요청 2026-09-02). 상태는 ?side=crew:<slug> 하나 —
  // 패널은 레이아웃(SplitPane)이 그리므로 여기서는 URL만 바꾼다(크루 채팅 SideOpenMenu.onPick과 같은 호출).
  const openSide = (slug) => router.replace(withSide(`${window.location.pathname}${window.location.search}`, sideParam({ type: 'crew', key: slug })));
  // 분할 패널 가용 여부 — SplitPane 렌더·크루 채팅 진입로와 공용 훅 하나(실뷰포트 축 + 표시 배율 축).
  // 죽은 패널로 보내는 진입로는 무언 실패이므로 노출하지 않는다(안 될 버튼 노출 금지 원칙).
  const splitAlive = useSplitAlive();
  // 진입로 조건 = 패널 살아 있음 + 크루 실존(해고된 크루의 옛 발언은 열 스레드가 없다 — 종전 평문 그대로)
  const canOpenSide = (slug) => splitAlive && agents.some((a) => a.slug === slug);

  async function openSession(id) {
    wf.close(); // 작업 폴더 팝오버 — 열람 갔다 오면 리마운트로 되살아나(autoFocus) 포커스를 뺏는다(크루 채팅과 동일)
    if (!id) { setViewing(null); setArchMsgs(null); atBottomRef.current = true; setUnseen(false); return; } // 복귀=최신으로(검수 D2·D4)
    try {
      const d = await api(`/api/companies/${ws}/room/sessions?id=${encodeURIComponent(id)}`);
      setViewing(id); setArchMsgs(d.messages ?? []);
    } catch (e) { setError(String(e.message)); }
  }

  // 첨부 — 크루 채팅과 같은 관문(클립 버튼·붙여넣기, 업로드 즉시 vault/files 저장). 실사용 요청
  // 2026-07-27 "대화창에서 파일 첨부 바로": 크루 채팅엔 있었고 회의실이 공백이었다.
  const fileRef = useRef(null);
  const [att, setAtt] = useState([]);
  const [uploading, setUploading] = useState(false);
  async function addFiles(fileList) {
    const files = [...(fileList ?? [])].filter(Boolean);
    if (!files.length || uploading) return;
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

  async function send(e) {
    e.preventDefault();
    // 전송 버튼 경로에서도 '/' 커맨더 우선 — '/end' 같은 명령 토큰이 안건으로 방에 적립되지 않게(크루 채팅과 동일)
    if (slashOpen) { runSlash(slashList[slashSel]); return; }
    const text = input.trim();
    if (!text || busy || uploading) return;
    // 이름만 있는 발언("@카맥")은 보내지 않는다 — Enter 멘션 완성이 뒤에 공백 하나만 붙여 눈에 안 띄고, 한 번 더 누르면
    // 빈 안건이 방에 올라가 크루가 발언을 시작하던 길(유건 제보 2026-09-02). 안건을 이어 적으라고 알린다.
    if (!text.replace(/(^|\s)@\S+/g, '').trim()) { setError(t('room.mentionOnly')); return; }
    const attachments = att;
    setBusy(true); setError('');
    atBottomRef.current = true; // 자기 발언은 항상 하단 추종(읽던 위치 보존은 수신에만 적용)
    setMessages((m) => [...(m ?? []), { who: 'user', text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) }]);
    setInput(''); setAtt([]);
    try {
      const d = await api(`/api/companies/${ws}/room`, { message: text, attachments });
      // 서버 스냅샷이 비어 있으면(동시 '회의 마치기'로 방이 리셋됐거나 응답 형태 이상) 화면을 지우지
      // 않는다 — 방금까지 보던 대화가 사라지는 것으로 보이던 경로. 답변만 이어 붙이고, 8초 폴이 정본으로 수렴시킨다.
      const snap = Array.isArray(d.room?.messages) ? d.room.messages : null;
      if (snap?.length) setMessages(snap);
      else if (d.replies?.length) {
        // artifacts도 옮긴다 — 서버가 replies에 실어도 여기서 버리면 폴백 경로의 말풍선만 칩이 빈다(분리 검수 MEDIUM-1)
        setMessages((m) => [...(m ?? []), ...d.replies.map((r) => ({ who: r.slug, text: r.reply, ts: Date.now(), ...(r.artifacts?.length ? { artifacts: r.artifacts } : {}) }))]);
      }
    } catch (err) {
      setError(String(err.message));
      // 전송 실패 시 첨부 복구(검수 LOW) — 업로드는 이미 끝난 파일들이라 다시 고르게 하지 않는다.
      // 대기 중 사용자가 새로 첨부했으면(컴포저가 비어 있지 않으면) 그쪽을 존중해 덮지 않는다.
      setAtt((cur) => (cur.length ? cur : attachments));
      // 안건 복원은 **서버가 저장 못 했을 때만**(크루 0명 등 — 폴링이 낙관 말풍선까지 지워 글이 사라진다).
      // 저장된 뒤의 실패(크루 발언 실패)는 방에 안건과 실패 안내가 남아 있으므로 되돌리지 않는다 — 되돌리면
      // 같은 안건이 방·입력창에 나란히 남아 Enter 한 번에 두 번 적립된다(분리 검수 #392 HIGH-1 실측).
      if (!err?.data?.saved) setInput((cur) => cur || text);
    } finally {
      // 자기 턴 종료 — turn만 즉시 내린다(마지막 partial이 완성 말풍선과 겹치지 않게). serverBusy는 다음 폴이 정본으로
      // 수렴시킨다: 여기서 끄면 다른 탭의 턴이 도는 중에 '회의 마치기' 잠금이 최대 8초 풀린다(#393 검수 MEDIUM-1 — main 대비 회귀).
      setBusy(false); setTurn(null);
    }
  }

  async function endMeeting() {
    if (busy || serverBusy) return; // 서버 턴 중 마치기 = 도는 발언이 방·개인 스레드 어디에도 안 남는다(검수 MEDIUM-2)
    // 회의록은 서버(endMeeting)가 journal + .archive로 남기므로 비파괴 — 확인창 없이 바로 마친다.
    // window.confirm은 Tauri 데스크톱 웹뷰에서 막혀 무동작 → 제거(새 대화와 동일 근본 원인).
    try {
      const r = await fetch(`/api/companies/${ws}/room`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw routeError(d);
      setMessages([]); setError('');
      atBottomRef.current = true; setUnseen(false); // 빈 방 = 초기 상태(검수 D4 — 우연한 클램프 의존 제거)
      loadSessions(); // 방금 마친 회의가 좌측 레일에 적재된다
      window.dispatchEvent(new Event('argo:refresh')); // 항해일지에 회의록이 바로 잡힌다
    } catch (e2) { setError(String(e2.message)); }
  }

  // 새 회의 — 지금 회의를 마치지 않고(회의록 없음) '진행 중'으로 레일에 보관한 뒤 빈 방을 연다(유건 요청 2026-09-02).
  // 마치기와 같은 잠금(busy || serverBusy): 도는 발언은 sid 불일치로 버려진다 — 서버 게이트(409 ROOM_BUSY)가 2차 방어.
  // 항해일지 갱신(argo:refresh)은 없다 — 회의록을 쓰지 않았다.
  async function newMeeting() {
    if (busy || serverBusy) return;
    try {
      const r = await fetch(`/api/companies/${ws}/room/sessions`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw routeError(d);
      setMessages([]); setError('');
      atBottomRef.current = true; setUnseen(false);
      loadSessions(); // 방금 넘긴 회의가 '진행 중'으로 레일에 적재된다
    } catch (e2) { setError(String(e2.message)); }
  }

  // 컴포저 위 드롭업(멘션·'/' 커맨더)의 공통 기준 박스 — 입력바를 감싸는 relative 래퍼(측정형 클램프의 앵커).
  const mentionWrapRef = useRef(null);

  // '/' 커맨더 — 크루 채팅(crew/[slug])의 커맨더를 회의실에도(유건 요청 2026-09-02, 회의실 개선 1/6).
  // 문법·후보 계산은 공유 매처(slash-match.mjs): 입력이 슬래시 토큰 하나일 때만 발동, ↑↓ 이동·Enter 실행.
  // 후보 = 내장 명령 + 회사 별칭(/별칭 → 저장된 지시 삽입) + 회사 스킬(/스킬 → 사용 지시 삽입 — 크루 채팅과 같은
  // 문장이라 서버는 손댈 것이 없다: 스킬 본문은 chat()이 출처 무관하게 매 턴 주입한다). 삽입 뒤 사장이 @이름·안건을
  // 덧붙여 보낸다. 별칭 등록·삭제는 크루 채팅 커맨더에서(회사 공용 목록이라 여기서도 그대로 보인다).
  const [aliases, setAliases] = useState([]);
  const [skillCmds, setSkillCmds] = useState(null); // null = 아직 안 열어봄(첫 열림에 별칭·스킬을 1회 로드)
  const SLASH_CMDS = [
    // 이동은 keepSide로 — 생 router.push는 ?side=를 떨어뜨려 옆에 열어 둔 보조 패널이 닫힌다(레이아웃 내부 링크 규약과 동일)
    { id: 'memory', aliases: ['memory', '기억', 'vault'], label: t('nav.memory'), run: () => router.push(keepSide(`/c/${ws}/vault`, window.location.search)) },
    { id: 'deck', aliases: ['deck', '데크', 'home'], label: t('nav.deck'), run: () => router.push(keepSide(`/c/${ws}`, window.location.search)) },
    // 회의 마치기 — 헤더 버튼과 같은 노출 조건(빈 방·진행 중엔 후보에서 빠진다: 실행해도 안 되는 명령은 보이지 않게).
    // 맨 뒤에 두는 이유: `/` 직후 Enter의 기본 선택이 방을 비우는 명령이면 탐색 중 Enter 한 번에 회의가 마쳐진다
    // (분리 검수 LOW-1 — 레일에서 되살릴 수는 있지만 처음 보는 제스처의 기본값으로는 부적합).
    ...(!viewing && (messages?.length ?? 0) > 0 && !busy && !serverBusy ? [{ id: 'end', aliases: ['end', '마치기', '회의마치기'], label: t('room.end'), run: () => endMeeting() }] : []),
  ];
  const slashTok = !viewing && SLASH_TOKEN_RE.test(input); // 토큰 존재(별칭·스킬 로드 트리거) — 후보 유무와 별개
  const slashList = viewing ? null : matchSlash(input, { builtins: SLASH_CMDS, aliases, skills: skillCmds ?? [], skillInsert: (s) => t('chat.cmd.skillPrefix', { name: s.title }) });
  const slashOpen = !!slashList?.length;
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => { setSlashIdx(0); }, [input]);
  // 선택 항목은 한 곳에서만 계산 — 표시(aria-selected)와 실행(Enter·전송 버튼)이 항상 같은 항목을 가리킨다.
  // 패널이 열린 채 후보가 줄 수 있다(8초 폴이 serverBusy를 켜면 /end가 빠진다): slashIdx가 범위를 벗어나면
  // 표시는 비고 실행만 되는 어긋남이 생기므로(분리 검수 MEDIUM-1) 클램프한 값을 양쪽이 같이 쓴다.
  const slashSel = slashOpen ? Math.min(slashIdx, slashList.length - 1) : 0;
  // 회사 별칭·스킬 — 커맨더를 처음 여는 순간 1회 로드(크루 채팅과 같은 출처: company.aliases, 마켓 GET installedSkills).
  // 방 진입마다 요청하지 않는다. 실패해도 내장 명령은 동작(스킬은 빈 목록으로 확정해 재시도 폭주를 막는다).
  useEffect(() => {
    if (!slashTok || skillCmds !== null) return;
    api(`/api/companies/${ws}/market`).then((d) => setSkillCmds(d.installedSkills ?? [])).catch(() => setSkillCmds([]));
    api(`/api/companies/${ws}?light=1`).then((d) => setAliases(d.company?.aliases ?? [])).catch(() => {});
  }, [slashTok, skillCmds, ws]);
  function runSlash(cmd) {
    if (cmd.kind === 'builtin') { setInput(''); cmd.run(); }
    else setInput(cmd.insert); // 별칭·스킬 = 지시 텍스트 삽입(바로 전송하지 않는다 — 사장이 @이름·안건을 덧붙여 보냄)
    composerRef.current?.focus();
  }
  // 좌우 클램프 — 멘션 패널과 같은 기준 박스(mentionWrapRef)·같은 측정형 처방(dropUpClamp, #367)
  const slashPanelRef = useRef(null);
  const slashNatW = useRef(0);
  const [slashClamp, setSlashClamp] = useState({ shift: 0, maxW: 0 });
  useIsoLayoutEffect(() => {
    if (!slashOpen) { setSlashClamp({ shift: 0, maxW: 0 }); slashNatW.current = 0; return; }
    const measure = () => {
      if (!mentionWrapRef.current || !slashPanelRef.current) return;
      if (!slashNatW.current) slashNatW.current = slashPanelRef.current.offsetWidth;
      setSlashClamp(dropUpClamp(mentionWrapRef.current.getBoundingClientRect(),
        document.documentElement.clientWidth, slashNatW.current));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('argo:zoom', measure);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('argo:zoom', measure); };
  }, [slashOpen]);

  // @멘션 드롭업 — 입력 끝이 @word면 입력창 위로 후보 패널이 열린다(칩 가로 나열이 크루 수만큼
  // 옆으로 흘러 지저분했다 — 유건 지시 2026-07-21: 드롭다운식 + 위로). @all이 항상 첫 후보.
  const mention = input.match(/@(\S*)$/);
  const mq = mention ? mention[1].toLowerCase() : '';
  const suggests = mention
    ? agents.filter((a) => !mq || a.name.toLowerCase().startsWith(mq) || a.slug.startsWith(mq)).slice(0, 12)
    : [];
  const suggestAll = !!mention && agents.length > 1 && (!mq || 'all'.startsWith(mq) || '전체'.startsWith(mention[1]));
  const completeMention = (name) => setInput(input.replace(/@\S*$/, `@${name} `));
  // 커맨더가 떠 있으면 멘션 패널은 양보한다(같은 자리 bottom 100%). 기준은 후보 유무(slashOpen) — `/@이름`처럼 커맨더
  // 후보가 없는 입력은 종전대로 멘션 완성이 된다(분리 검수 LOW-2). slashOpen ⟹ 슬래시 토큰이라 둘이 동시에 뜨지 않는다.
  // 작업 폴더 팝오버가 열려 있어도 닫는다(같은 자리) — 멘션은 입력 파생 상태라 버튼 클릭으로는 안 닫혀, '@' 입력 중 폴더
  // 버튼이 무동작이었고 멘션을 완성하는 순간 팝오버가 불쑥 열려 포커스를 뺏었다(분리 검수 MEDIUM-4). Enter 완성 분기도 이 값을 본다.
  const mentionOpen = !!mention && !slashOpen && (suggestAll || suggests.length > 0) && !wf.open;
  const mentionPanelRef = useRef(null);
  const mentionNatW = useRef(0);
  const [mentionClamp, setMentionClamp] = useState({ shift: 0, maxW: 0 });
  useIsoLayoutEffect(() => {
    if (!mentionOpen) { setMentionClamp({ shift: 0, maxW: 0 }); mentionNatW.current = 0; return; }
    const measure = () => {
      if (!mentionWrapRef.current || !mentionPanelRef.current) return;
      if (!mentionNatW.current) mentionNatW.current = mentionPanelRef.current.offsetWidth;
      setMentionClamp(dropUpClamp(mentionWrapRef.current.getBoundingClientRect(),
        document.documentElement.clientWidth, mentionNatW.current));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('argo:zoom', measure);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('argo:zoom', measure); };
  }, [mentionOpen]);

  const shown = viewing ? archMsgs : messages;
  const viewingOpen = !!viewing && !!sessions.find((s) => s.id === viewing)?.open; // 열람 중인 보관본이 '진행 중'인가(배너 문구·버튼 라벨)

  return (
    // 그리드 기하(레일 216px + 본문 열, 높이 calc, marginBottom -70)는 .chat-cols(globals) — 크루 DM·
    // 컨테스트와 정본 공용(값이 동일한데 인라인로 남아 정본이 둘로 갈라져 있던 것을 편입).
    // 폰 폭(≤560px)의 레일 스택 전환도 이 클래스로 함께 받는다.
    <div className="chat-cols">
      {/* 회의 레일 — 마친 회의가 적재된다. 무템플릿 grid 함정 방지: minmax(0,1fr).
          sticky·폭 216은 .chat-cols > .side-rail(globals) — 폰 폭에서 static·전폭 스택으로 뒤집힌다 */}
      <div className="side-rail" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('room.sessions.title')}{sessions.length ? ` · ${sessions.length}` : ''}
        </span>
        <button className={`nav-item${!viewing ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openSession(null)}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t('room.sessions.current')}</span>
            <span className="nav-sub">{messages?.length ? t('chat.sessions.msgs', { n: messages.length }) : t('room.sessions.idle')}</span>
          </span>
        </button>
        {sessions.map((s) => {
          const active = viewing === s.id;
          const pinColor = active ? 'var(--primary-fg)' : 'var(--primary)'; // 활성 골드 배경 위 골드 핀 겹침 방지(세션 레일 공통)
          const actColor = active ? 'var(--primary-fg)' : 'var(--fg-3)';
          return (
          <div key={s.id} className="rail-item" style={{ position: 'relative' }}>
            <button className={`nav-item${active ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', paddingRight: 48 }} onClick={() => openSession(s.id)}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600 }}>
                  {s.pinned && <Icon name="pin" size={11} style={{ flex: 'none', color: pinColor }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title || s.topic || t('chat.sessions.untitled')}</span>
                </span>
                <span className="nav-sub" style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {/* 진행 중 칩 — '새 회의'로 넘긴 회의(회의록 없음). .chip을 쓰지 않는다(uppercase — 시스템 줄과 같은 이유).
                      진행 중 항목은 날짜를 뺀다: 보관본 ts는 회의 날짜가 아니라 넘긴 시각이라 오해를 부르고, en에서
                      칩+날짜+"3 messages"가 레일 폭(216px)을 넘겨 "3 …"로 잘렸다(격리 실측 스크린샷). */}
                  {s.open && <span style={{ flex: 'none', fontSize: 10, fontWeight: 650, lineHeight: 1.5, color: pinColor, padding: '0 5px', borderRadius: 999, border: `1px solid ${pinColor}` }}>{t('room.sessions.open')}</span>}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.open ? '' : `${new Date(s.ts).toLocaleDateString('sv-SE')} · `}{t('chat.sessions.msgs', { n: s.count })}</span>
                </span>
              </span>
            </button>
            <span className="rail-actions" style={{ position: 'absolute', right: 5, top: 7, display: 'flex', gap: 1 }}>
              <button type="button" title={s.open ? t('room.sessions.switch') : t('room.sessions.reopen')} aria-label={s.open ? t('room.sessions.switch') : t('room.sessions.reopen')}
                disabled={reopening === s.id || busy || serverBusy}
                onClick={(e) => { e.stopPropagation(); doReopen(s); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: actColor, cursor: reopening === s.id ? 'wait' : 'pointer', borderRadius: 6 }}>
                <Icon name="play" size={12} />
              </button>
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
            </span>
          </div>
          );
        })}
        {sessions.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('room.sessions.empty')}</span>}
      </div>

      {renameSess && (
        <InputModal
          title={t('chat.sessions.renameTitle')}
          defaultValue={renameSess.title || renameSess.topic || ''}
          placeholder={t('chat.sessions.renamePh')}
          confirmLabel={t('common.save')}
          onConfirm={doRenameSess}
          onClose={() => setRenameSess(null)}
        />
      )}

      {/* 열 잠금 minmax(0,1fr) — 무템플릿 grid의 암묵 auto 열은 자식 min-content(컴포저 textarea 고유폭
          ~260px)만큼 부풀어, 표시 배율 2의 좁은 유효 폭(1열 ~178px)에서 문서 가로 넘침을 만든다(실측
          scrollWidth 1507 > 1408). 아이템 minWidth:0은 바깥 트랙만 지키고 자기 내부 트랙은 못 지킨다. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'auto 1fr auto', gap: 12, height: '100%', minWidth: 0, minHeight: 0 }}>
        {/* 헤더 = 라벨 + 구분선만. 새 회의·마치기 버튼은 입력창 아래 줄 오른쪽(알약 .btn sm)으로 옮겨졌다(2026-09-02 룩 통일) —
            좁은 폭 넘침 처방(wrap·라벨 줄바꿈)도 그 줄이 이어받는다. 라벨은 한 줄 ellipsis(단어별 세로 쌓임 방지). */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <span className="microlabel" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('room.header')}</span>
          <span className="rule" style={{ flex: 1 }} />
        </div>

        <div style={{ position: 'relative', minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {/* 테두리 카드 없이 맨 스크롤 영역 — 크루 채팅 .thread와 같은 룩(유건 지시 2026-09-02: 대화 세션과 룩 통일).
            overflowWrap anywhere — 긴 무공백 토큰(URL·코드 조각)이 좁은 유효 폭에서 내부 가로 스크롤을
            만들지 않게 한다. .md는 자체 break-word가 우선하지만 아래 열 잠금으로 박스가 좁아지면 그걸로 충분히 꺾인다. */}
        <div ref={scrollRef} style={{ padding: '4px 2px', overflowY: 'auto', minHeight: 0, overflowWrap: 'anywhere' }}>
          {shown === null ? <Skeleton h={200} /> : shown.length === 0 ? (
            <div className="empty">{t('room.empty')}</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, width: '100%', maxWidth: LANE, margin: '0 auto' }}> {/* 열 잠금 — 본문 열과 같은 이유(메시지 행 min-content 전파 차단). 레인 = 크루 스레드와 동일 */}
              {shown.map((m, i) => m.who === 'user' ? (
                <div key={i} style={{ justifySelf: 'end', maxWidth: '78%' }}>
                  <div className="bubble-user" style={{ background: 'var(--primary)', color: 'var(--primary-fg)', borderRadius: 14, padding: '9px 13px', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
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
                </div>
              ) : m.who === 'system' ? (
                // 라우팅 안내(참조 전달·루프 등록·못 알아본 멘션) — 크루 발언이 아니라 방의 상태 표시.
                // .chip을 쓰지 않는다: text-transform:uppercase가 걸려 있어 크루 slug가 대문자로 뒤집힌다
                // (@verify → @VERIFY). 안내문 안의 이름은 사용자가 그대로 따라 칠 값이라 원문이어야 한다.
                <div key={i} style={{ justifySelf: 'center', maxWidth: '80%' }}>
                  <span style={{
                    display: 'inline-block', fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.55, textAlign: 'center',
                    padding: '4px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'transparent',
                  }}>{m.text}</span>
                </div>
              ) : (
                <div key={i} style={{ display: 'flex', gap: 10, maxWidth: '86%' }}>
                  {/* 발언자 아바타·이름 = '옆에 열기' 진입로 — canOpenSide일 때만 버튼(.room-speaker), 아니면 종전 평문.
                      아바타는 이름 버튼과 같은 동작이라 탭 순서에서 뺀다(tabIndex −1) — 발언마다 정지점 둘은 키보드 중복(검수 F) */}
                  {canOpenSide(m.who) ? (
                    <button type="button" className="room-speaker" tabIndex={-1} onClick={() => openSide(m.who)} title={t('room.openSide', { name: nameOf(m.who) })} aria-label={t('room.openSide', { name: nameOf(m.who) })}>
                      <Avatar name={nameOf(m.who)} />
                    </button>
                  ) : <Avatar name={nameOf(m.who)} />}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {canOpenSide(m.who) ? (
                        <button type="button" className="room-speaker name" onClick={() => openSide(m.who)} title={t('room.openSide', { name: nameOf(m.who) })}>{nameOf(m.who)}</button>
                      ) : nameOf(m.who)}
                      {/* 위임으로 들어온 발언 — 누가 무엇을 맡겨 나온 답인지 방 안에서 드러낸다(다른 창으로 새지 않는다) */}
                      {m.via && (
                        // 이름이 들어가는 라벨이라 .chip(uppercase)을 피한다 — 위 시스템 줄과 같은 이유
                        <span style={{
                          fontSize: 10.5, fontWeight: 500, color: 'var(--fg-3)',
                          padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border)',
                        }}>{t('room.viaDelegate', { from: nameOf(m.via.from) })}</span>
                      )}
                    </div>
                    {m.via?.task && (
                      <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 4, lineHeight: 1.5 }}>{m.via.task}</div>
                    )}
                    <div style={{ fontSize: 13.5 }}><Markdown text={m.text} wsId={ws} /></div>
                    {/* 산출물 칩 — 크루 채팅과 같은 컴포넌트(바로 보기=눈 토글, 바로 가기=칩 클릭). 방 메시지의 artifacts는
                        room.mjs가 chat() 결과에서 실어 저장한다(개인 스레드에만 기록되던 비대칭 해소). 보관 회의 열람도 같은 경로. */}
                    {m.artifacts?.length > 0 && <ArtifactChips ws={ws} rels={m.artifacts} />}
                  </div>
                </div>
              ))}
              {!viewing && (busy || serverBusy) && (
                turn?.slug ? (
                  // 발언 중인 크루 — 아바타·이름·단계(도구·파일)·쓰는 중인 문장·다음 발언 순서. 크루 말풍선과 같은 골격.
                  <div style={{ display: 'flex', gap: 10, maxWidth: '86%' }}>
                    <Avatar name={nameOf(turn.slug)} size={26} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {nameOf(turn.slug)}
                        <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <ArgoSpinner size={11} />
                          {/* 단계 미상(상태 파일 없음·만료 — CLI 러너는 턴당 1회만 쓰고, 2분 넘는 도구도 만료)이면 '시동 거는 중'을
                              지어내지 않는다(#393 검수 HIGH-1: CLI 발언은 2분 뒤 결정적으로 거짓 표시) — 발언자만 정직하게. */}
                          {turn.stage ? t('chat.stageEllipsis', { stage: stageLabel(t, turn.stage, turn.detail) }) : t('room.speaking')}
                          {turn.stage !== 'runner' && turn.detail ? ` · ${String(turn.detail).slice(0, 60)}` : ''}
                        </span>
                      </div>
                      {turn.partial && (
                        <div style={{ fontSize: 13.5, color: 'var(--fg-2)' }}><Markdown text={turn.partial} wsId={ws} /></div>
                      )}
                      {turn.queue?.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>{t('room.next', { names: turn.queue.map(nameOf).join(' → ') })}</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--fg-2)', fontSize: 12.5 }}>
                    <ArgoSpinner size={16} /> {t('room.meeting')}
                  </div>
                )
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
        {unseen && !viewing && (
          <button type="button" onClick={jumpToLatest} className="btn btn-primary sm"
            style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', boxShadow: '0 6px 18px rgba(0,0,0,.18)', zIndex: 5 }}>
            {t('room.newMsgs')}
          </button>
        )}
        </div>

        {viewing ? (
          <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--fg-2)', width: '100%', maxWidth: LANE, margin: '0 auto' }}>
            <Icon name="doc" size={13} /> {viewingOpen ? t('room.sessions.openReadonly') : t('room.sessions.readonly')}
            <span style={{ flex: 1 }} />
            {/* 열기·전환 — 레일의 play 아이콘과 같은 동작(doReopen). 크루 채팅 배너의 '이어가기' 자리와 동형 */}
            <button className="btn btn-primary sm" disabled={!!reopening || busy || serverBusy} onClick={() => doReopen({ id: viewing })}>{viewingOpen ? t('room.sessions.switchShort') : t('room.sessions.reopenShort')}</button>
            <button className="btn sm" onClick={() => openSession(null)}>{t('chat.sessions.back')}</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, width: '100%', maxWidth: LANE, margin: '0 auto' }}> {/* 열 잠금 — 본문 열과 같은 이유(한 층 아래 같은 함정). 레인 = 크루 컴포저와 동일 */}
            {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
            {/* 라우팅 문법 안내 — 모르면 없는 기능이다. 방을 떠나지 않고 지시하는 법을 입력창 옆에 붙여 둔다 */}
            {/* 멘션 드롭업의 위치 기준 — 입력바를 relative로 감싼다 */}
            <div ref={mentionWrapRef} style={{ position: 'relative' }}>
              {mentionOpen && (
                <div ref={mentionPanelRef} className="card card-float" role="listbox" style={{
                  position: 'absolute', bottom: 'calc(100% + 6px)', left: mentionClamp.shift, zIndex: 40,
                  minWidth: mentionClamp.maxW ? Math.min(280, mentionClamp.maxW) : 280,
                  maxWidth: mentionClamp.maxW ? Math.min(mentionClamp.maxW, 420) : undefined, maxHeight: 300, overflowY: 'auto', padding: 6,
                  boxShadow: '0 8px 28px rgba(0,0,0,.14)',
                }}>
                  <div className="microlabel" style={{ padding: '4px 8px 2px' }}>{t('room.mention')}</div>
                  {/* @all — 전 크루 호출(서버 runRoomTurn이 @all/@전체를 전원 발언으로 해석). 항상 첫 후보 = Enter 완성 대상 */}
                  {suggestAll && (
                    <button type="button" role="option" onClick={() => completeMention('all')}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 0, borderRadius: 7, cursor: 'pointer', padding: '6px 8px', fontSize: 12.5 }}>
                      <span className="mono" style={{ color: 'var(--primary-strong)', fontWeight: 650 }}>@all</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: 11.5 }}>{t('room.allCrew')}</span>
                    </button>
                  )}
                  {suggests.map((a) => (
                    <button key={a.slug} type="button" role="option" onClick={() => completeMention(a.name)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 0, borderRadius: 7, cursor: 'pointer', padding: '6px 8px', fontSize: 12.5, color: 'var(--fg)' }}>
                      <span style={{ fontWeight: 650, flex: 'none' }}>@{a.name}</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: 11.5 }}>{a.role}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* '/' 커맨더 드롭업 — 크루 채팅 커맨더와 같은 룩(입력창 위 세로 목록, ↑↓ 이동·Enter 실행). 멘션 패널과
                  같은 기준 박스라 순서만 뒤(래퍼 첫 자식은 멘션 — 기존 클램프 핀). 별칭 관리 행은 없다(크루 채팅에서). */}
              {slashOpen && (
                <div ref={slashPanelRef} className="card card-float" role="listbox" style={{
                  position: 'absolute', bottom: 'calc(100% + 6px)', left: slashClamp.shift, zIndex: 40,
                  minWidth: slashClamp.maxW ? Math.min(320, slashClamp.maxW) : 320,
                  maxWidth: slashClamp.maxW ? Math.min(slashClamp.maxW, 480) : undefined, maxHeight: 320, overflowY: 'auto', padding: 6,
                  boxShadow: '0 8px 28px rgba(0,0,0,.14)',
                }}>
                  <div className="microlabel" style={{ padding: '4px 8px 2px' }}>{t('chat.commands')}</div>
                  {slashList.map((c, i) => (
                    <button key={c.key} type="button" role="option" aria-selected={i === slashSel}
                      onClick={() => runSlash(c)} onMouseEnter={() => setSlashIdx(i)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                        background: i === slashSel ? 'var(--card-2)' : 'none', border: 0, borderRadius: 7,
                        cursor: 'pointer', padding: '6px 8px', fontSize: 12.5, color: 'var(--fg)' }}>
                      <span className="mono" style={{ flex: 'none', fontWeight: 650 }}>/{c.cmd}</span>
                      <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: 11.5 }}>{c.desc}</span>
                      {c.kind !== 'builtin' && (
                        <span className="microlabel" style={{ flex: 'none', fontSize: 9 }}>
                          {c.kind === 'skill' ? t('chat.cmd.skills') : t('chat.cmd.aliases')}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {/* 작업 폴더 팝오버(work-folder.jsx 공용) — 멘션 드롭업과 같은 자리(bottom 100%, absolute라 DOM 순서 무관).
                  상호 배타의 우선순위는 팝오버(mentionOpen이 !wf.open을 본다). 멘션 패널 뒤에 두는 이유: 기준 박스 핀
                  (display-zoom-layout)이 래퍼 첫 자식을 멘션 패널로 잡는다 */}
              {wf.open && <WorkFolderPopover wf={wf} note={t('room.workFolder.hint')} />}
              {(att.length > 0 || uploading) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
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
              {/* 고정된 회의 작업 폴더 — 해제 전까지 발언 크루 전원의 프롬프트에 "지금 일할 폴더"로 들어간다(크루 채팅과 같은 컴포저 스택) */}
              {wf.pinned && (
                <div className="composer-stack" aria-label={t('chat.workFolder.open')}>
                  <WorkFolderRow wf={wf} />
                </div>
              )}
              <form onSubmit={send} className="input-bar" style={{ background: 'var(--card-2)', alignItems: 'flex-end', borderRadius: 22 }}>
                <input hidden multiple type="file" ref={fileRef} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                <textarea suppressHydrationWarning
                  ref={composerRef}
                  rows={1}
                  placeholder={t('room.placeholder')}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
                  disabled={busy}
                  {...imeGuardWith((e) => {
                    // '/' 커맨더가 떠 있으면 ↑↓ = 항목 순환 이동(커서 이동 아님)
                    if (slashOpen && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                      e.preventDefault();
                      setSlashIdx(e.key === 'ArrowDown' ? (slashSel + 1) % slashList.length : (slashSel - 1 + slashList.length) % slashList.length);
                      return;
                    }
                    if (e.key !== 'Enter' || e.shiftKey) return; // Shift+Enter = 줄바꿈(textarea 기본)
                    e.preventDefault();
                    // 커맨더가 떠 있으면 Enter = 선택 항목 실행(명령은 방에 전송되지 않는다)
                    if (slashOpen) { runSlash(slashList[slashSel]); return; }
                    // 멘션 패널이 열려 있으면 Enter = 첫 후보 완성(전송 아님)
                    if (mentionOpen) { completeMention(suggestAll ? 'all' : suggests[0].name); return; }
                    e.currentTarget.form?.requestSubmit(); // Enter = 전송
                  })}
                />
                <button className="btn btn-primary btn-icon" disabled={busy || uploading || !input.trim()} aria-label={t('chat.send')}>
                  <Icon name="send" size={15} />
                </button>
              </form>
            </div>
            {/* 입력창 아래 슬림 줄 — 왼쪽 폴더·클립, 오른쪽 새 회의·마치기(크루 채팅의 모델 버튼 자리). 크루 채팅 입력바와
                같은 골격(유건 지시 2026-09-02: 대화 세션과 룩 통일). 폴더·클립 26px 폭·폴더 -0.18px 보정은 크루 정본 그대로. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 6px', minHeight: 18, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 0, flex: 'none' }}>
                {/* 작업 폴더(work-folder.jsx 공용) — 순서는 폴더 → 클립(유건 지시 2026-07-28, 크루 채팅과 동일) */}
                <WorkFolderButton wf={wf} disabled={busy} hint={t('room.workFolder.hint')} style={{ width: 26 }} iconStyle={{ transform: 'translateY(-0.18px)' }} />
                <button type="button" className="btn btn-icon sm" style={{ border: 0, flex: 'none', width: 26, color: 'var(--fg-3)' }}
                  onClick={() => fileRef.current?.click()} disabled={busy} aria-label={t('chat.attach')} title={t('chat.attach')}>
                  <Icon name="clip" size={14} />
                </button>
              </div>
              {/* 새 회의·마치기 — 회의 상태를 바꾸는 행동이라 알약(.btn sm)으로(유건 2026-09-02: 텍스트형은 링크처럼 읽힘). 같은 잠금.
                  좁은 폭 처방은 헤더 시절 그대로: 행 wrap + 라벨 줄바꿈·세로 자람(.btn.sm 고정 height 28은 en 2줄 라벨이 알약 밖으로). 회의 없으면 숨김. */}
              {(messages?.length ?? 0) > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
                  <button type="button" className="btn sm" style={{ whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' }} disabled={busy || serverBusy} onClick={newMeeting}>{t('room.new')}</button>
                  <button type="button" className="btn sm" style={{ whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' }} disabled={busy || serverBusy} onClick={endMeeting}>{t('room.end')}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
