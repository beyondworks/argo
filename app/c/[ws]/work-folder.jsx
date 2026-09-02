'use client';
// 작업 폴더 고정 — 크루 채팅·회의실 **공용**(유건 지시 2026-09-02: 회의실도 같은 컴포넌트·계약). 설정까지 가지 않고
// 컴포저에서 바로 등록한다(유건 확정 2026-07-28). 데스크톱은 네이티브 픽커(ui.jsx openFolderDialog — 설정
// FolderField와 같은 경로), 웹은 실경로 미제공이라 경로 입력 폼으로 정직 폴백.
// 저장은 `.workroots.json`의 pins(기기 로컬·동기화 제외)이고, 해제 전까지 매 턴 프롬프트에 "지금 일할 폴더"로
// 들어간다(src/chat.mjs activeFolders). 예전엔 입력창에 문구를 붙일 뿐이라 한 번 보내면 풀렸다(실사용 신고
// 2026-07-31). 등록 목록(roots)이 '가도 되는 곳', 이 고정이 '지금 일할 곳'이다. 서버가 등록 목록과 대조해 정본
// 문자열로 저장한다. slug = 크루 슬러그 또는 '@room'(회의실 — 크루 슬러그 [a-z0-9-]와 불충돌, src/room.mjs ROOM_FOLDER_SLUG).
import { useEffect, useState } from 'react';
import { Icon, Spinner, api, imeGuard, isTauriApp, openFolderDialog, isFolderDialogBroken, FOLDER_DIALOG_EVENT } from '../../ui';
import { useLang } from '../../i18n';

/** 고정 상태 + 조작. onError = 고정 실패 문구(팝오버는 닫힌 뒤라 스레드 상단 배너로), onPinned = 고정 뒤(입력창 포커스 복귀). */
export function useWorkFolder({ ws, slug, onError, onPinned }) {
  const { t } = useLang();
  const [pinned, setPinned] = useState(''); // 고정 작업 폴더('' = 없음) — 정본은 서버 pins
  const [open, setOpen] = useState(false); // 인라인 경로 폼 — 웹 폴백 + 픽커 경로의 검증 실패 표시 겸용
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [isApp, setIsApp] = useState(false);
  const [pickerDead, setPickerDead] = useState(false); // 픽커 실패로 폼이 열렸는가(서버 거부와 구분)
  // 고정 폴더는 기기 로컬(.workroots.json pins)이라 회사 응답에 없다 — 화면 진입 시 1회만 읽는다
  useEffect(() => {
    let alive = true;
    api(`/api/companies/${ws}/workroots`).then((d) => { if (alive) setPinned(d.pins?.[slug] ?? ''); }).catch(() => {});
    return () => { alive = false; };
  }, [ws, slug]);
  // 감지식은 ui.jsx isTauriApp을 쓴다(#170 통일 방침 — 여기서 다시 복제하지 않는다).
  // 픽커 성공/실패는 이벤트로 따라간다 — 성공했는데 "열 수 없다"가 남으면 거짓말이다(재검수 LOW-1·2).
  useEffect(() => {
    setIsApp(isTauriApp());
    const sync = () => setPickerDead(isFolderDialogBroken());
    sync();
    window.addEventListener(FOLDER_DIALOG_EVENT, sync);
    return () => window.removeEventListener(FOLDER_DIALOG_EVENT, sync);
  }, []);
  // 서버는 코드만 반환 — 여기서 i18n 매핑(설정 WorkRootsCard와 동일 계약). 미등록 코드는 일반 문구로.
  const mapErr = (code) => { const key = `settings.workroots.err.${code}`; const m = t(key); return m === key ? t('settings.workroots.err.invalid') : m; };
  const close = () => { setOpen(false); setErr(''); };

  /** 고정/해제 — 빈 값이면 해제. 낙관 반영(칩이 즉시 뜬다/사라진다), 실패는 되돌리고 onError. */
  async function pin(path) {
    const prev = pinned;
    setPinned(path);
    try {
      const d = await api(`/api/companies/${ws}/workroots`, { pin: { slug, path } });
      setPinned(d.pinned ?? '');
    } catch (e) {
      setPinned(prev);
      onError?.(mapErr(String(e.message || '')));
    }
  }
  async function register(path) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await api(`/api/companies/${ws}/workroots`, { add: path });
      close(); setInput('');
      await pin(path); // 저장은 서버가 등록 정본(realpath)으로 맞춘다 — 표기가 프롬프트와 어긋나지 않게
      onPinned?.();
    } catch (e) {
      const code = String(e.message || '');
      if (code === 'duplicate') { close(); setInput(''); await pin(path); onPinned?.(); return; } // 이미 등록된 폴더 = 목적 달성 — 고정만 하고 진행
      setErr(mapErr(code));
      setInput(path); setOpen(true); // 픽커로 고른 경로가 거부돼도 폼을 열어 그 자리에서 고치게 한다
    } finally { setBusy(false); }
  }
  /** 폴더 버튼 — 데스크톱은 픽커(취소는 아무 일 없음), 픽커 실패·웹은 경로 폼 토글 */
  async function openPicker() {
    if (isApp) {
      try {
        // 픽커 정본은 ui.jsx openFolderDialog(설정 FolderField와 동일 경로) — 취소는 null, 실패는 throw
        const dir = await openFolderDialog(t('settings.workroots.pickTitle'));
        if (dir) await register(dir);
        return; // 취소도 여기서 끝 — 취소했는데 입력 폼이 열리면 "안 고른 것"이 되레 일거리가 된다
      } catch { setPickerDead(true); } // 픽커 불가 → 사유를 달고 입력 폼 폴백(warn은 openFolderDialog가 남긴다)
    }
    setErr('');
    setOpen((o) => !o);
  }
  return { pinned, pin, open, close, openPicker, busy, isApp, pickerDead, input, setInput, err, register };
}

/** 팝오버 — 웹 폴백 경로 입력 + 픽커 거부 사유 표시. 부르는 쪽의 relative 래퍼 안, 입력창 위(bottom 100%).
    메인 폼과 중첩되면 invalid HTML이라 **형제로** 둔다. note = 화면별 한 줄 안내(회의실: 전원 공유). */
export function WorkFolderPopover({ wf, note = '' }) {
  const { t } = useLang();
  const p = { fontSize: 11.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 };
  return (
    <div className="card card-float" role="dialog" aria-label={t('chat.workFolder.open')}
      onKeyDown={(e) => { if (e.key === 'Escape') wf.close(); }}
      style={{
        position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 40,
        width: 'min(460px, 100%)', padding: 12, display: 'grid', gap: 8,
        boxShadow: '0 8px 28px rgba(0,0,0,.14)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="microlabel">{t('chat.workFolder.open')}</span>
        <button type="button" onClick={wf.close} aria-label={t('common.close')}
          style={{ border: 0, background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer', fontSize: 11, borderRadius: 5 }}>✕</button>
      </div>
      {note && <p style={p}>{note}</p>}
      {/* 웹은 왜 직접 쓰는지, 데스크톱은 왜 Finder가 안 떴는지 사유를 준다(분리 검수 H1).
          단 이 폼은 **서버가 고른 폴더를 거부했을 때도** 열린다 — 그땐 픽커가 멀쩡하므로
          "열 수 없다"고 하면 거짓말이다. 그래서 픽커 실패 여부를 따로 들고 판단한다. */}
      {!wf.isApp && <p style={p}>{t('chat.workFolder.webHint')}</p>}
      {wf.isApp && wf.pickerDead && <p style={p}>{t('common.pickerUnavailable')}</p>}
      <form onSubmit={(e) => { e.preventDefault(); const path = wf.input.trim(); if (path) wf.register(path); }}
        style={{ display: 'flex', gap: 8 }}>
        <input value={wf.input} onChange={(e) => wf.setInput(e.target.value)} placeholder={t('settings.workroots.placeholder')}
          {...imeGuard} autoFocus style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-soft)', background: 'var(--card)' }} />
        <button className="btn" type="submit" disabled={wf.busy || !wf.input.trim()}>{wf.busy ? <Spinner /> : t('settings.workroots.add')}</button>
      </form>
      {wf.err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }}>{wf.err}</p>}
      <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0, lineHeight: 1.6 }}>{t('settings.workroots.runnerNote')}</p>
    </div>
  );
}

/** 컴포저 스택(.composer-stack) 한 줄 — 고정된 폴더. 끝 두 조각만 보인다: 전체 경로는 폭을 다 먹고, CSS 말줄임
    (direction:rtl)은 앞의 '/'를 끝으로 밀어 "…보고서-2026-07/"처럼 없는 슬래시를 만든다(실측). 전체는 title로. */
export function WorkFolderRow({ wf }) {
  const { t } = useLang();
  return (
    <div className="row" title={wf.pinned}>
      <span className="lead"><Icon name="folder" size={13} /></span>
      <span className="name">…/{wf.pinned.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}</span>
      <button type="button" className="act" onClick={() => wf.pin('')}
        aria-label={t('chat.workFolder.unpin')} title={t('chat.workFolder.unpin')}>✕</button>
    </div>
  );
}

/** 폴더 버튼 — 러너별 한계는 툴팁으로 정직 표기(runnerNote 재사용, hint로 대체 가능). 배치·폭은 부르는 쪽(style)이 정한다. */
export function WorkFolderButton({ wf, disabled = false, style, iconStyle, hint = '' }) {
  const { t } = useLang();
  const label = wf.pinned ? t('chat.workFolder.pinned', { path: wf.pinned }) : t('chat.workFolder.open');
  return (
    <button type="button" className="btn btn-icon sm"
      style={{ border: 0, flex: 'none', color: wf.pinned ? 'var(--fg)' : 'var(--fg-3)', ...style }}
      onClick={wf.openPicker} disabled={disabled || wf.busy} aria-label={t('chat.workFolder.open')}
      title={`${label} — ${hint || t('settings.workroots.runnerNote')}`}>
      {wf.busy ? <Spinner size={14} /> : <Icon name="folder" size={14} style={iconStyle} />}
    </button>
  );
}
