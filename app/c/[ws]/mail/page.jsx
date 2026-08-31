'use client';
// 쪽지함 — 크루 우편함(mail/)의 화면. 사장 발신 + 대기/배달 기록/실패함. 5초 폴링(배달은 스케줄러가 1분 틱으로).
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, Avatar, Spinner, Skeleton, ConfirmModal, DropUp, api, timeAgo } from '../../../ui';
import { useLang } from '../../../i18n';

const CC_MAX = 4; // src/crewmail.mjs CC_MAX와 같은 값 — 서버가 최종 강제, 여기선 안내·토글 상한

export default function Mail({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(''); // 진행 중인 행 조작 키
  const [delTarget, setDelTarget] = useState(null);

  const load = useCallback(() => api(`/api/companies/${ws}/mail`)
    .then((d) => { setData(d); setError(''); })
    .catch((e) => { setError(String(e?.message || '') || t('mail.loadFail')); }), [ws, t]);

  useEffect(() => {
    api(`/api/companies/${ws}?light=1`).then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }, [ws]);
  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);
  useEffect(() => { if (!to && agents.length) setTo(agents[0].slug); }, [agents, to]);

  const nameOf = (slug) => (slug === 'captain' ? t('mail.fromCaptain') : (agents.find((a) => a.slug === slug)?.name ?? slug));

  async function send(e) {
    e.preventDefault();
    if (sending || !to || !message.trim()) return;
    setSending(true); setError(''); setNotice('');
    try {
      await api(`/api/companies/${ws}/mail`, { to, cc: cc.filter((s) => s !== to), message });
      setMessage(''); setCc([]); setNotice(t('mail.sent'));
      load();
    } catch (err) {
      setError(String(err.message));
    } finally { setSending(false); }
  }

  async function cancel(m) {
    setBusy(`c:${m.to}:${m.id}`); setError('');
    try {
      await fetch(`/api/companies/${ws}/mail?to=${encodeURIComponent(m.to)}&id=${encodeURIComponent(m.id)}`, { method: 'DELETE' })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); });
      load();
    } catch (err) { setError(String(err.message)); } finally { setBusy(''); }
  }

  async function patch(op, file) {
    setBusy(`${op}:${file}`); setError('');
    try {
      await fetch(`/api/companies/${ws}/mail`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, file }) })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); });
      load();
    } catch (err) { setError(String(err.message)); } finally { setBusy(''); }
  }

  async function doDelete() {
    const d = delTarget; if (!d) return;
    setDelTarget(null); // 모달을 await 전에 닫아 더블클릭 이중 요청 차단(루틴 페이지와 동일)
    await patch('deleteDead', d.file);
  }

  const toggleCc = (slug) => setCc((cur) => (cur.includes(slug) ? cur.filter((s) => s !== slug) : (cur.length >= CC_MAX ? cur : [...cur, slug])));
  const pending = data?.pending ?? [];
  const log = data?.log ?? [];
  const dead = data?.dead ?? [];
  const kindChip = (k) => <span className="chip" style={{ fontSize: 10.5 }}>{k === 'cc' ? t('mail.kind.cc') : t('mail.kind.to')}</span>;
  const who = (slug) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
      <Avatar name={nameOf(slug)} sm />{nameOf(slug)}
    </span>
  );

  return (
    /* 전 계층 grid 열 잠금 minmax(0,1fr) — 무템플릿 grid의 암묵 auto 열은 자식 min-content만큼
       부푼다(#350 회의실·#357 경쟁에서 확립된 계열). 실측(배율 2·1280·en): 초장문 크루 이름(60자)
       칩의 nowrap min-content가 CC 그룹 → 작성 폼 → 페이지 열을 사슬로 부풀려 문서 sw 1832 > cw
       1264. 일반 폭·일반 이름 레이아웃은 종전과 동일(1fr 채움 동작 불변). */
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
      {delTarget && (
        <ConfirmModal title={t('mail.deleteTitle')} description={t('mail.deleteConfirm')} confirmLabel={t('common.delete')} tone="danger"
          onConfirm={doDelete} onClose={() => setDelTarget(null)} />
      )}
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>{t('mail.intro')}</p>

      {/* 보내기 */}
      <form onSubmit={send} className="card" style={{ padding: 18, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
        <span className="card-title"><Icon name="mail" size={14} />{t('mail.compose')}</span>
        {agents.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-2)' }}>{t('mail.noCrew')}</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>
                <span className="microlabel">{t('mail.to')}</span>
                <DropUp value={to} width={220} height={34} ariaLabel={t('mail.to')}
                  groups={[{ items: agents.map((a) => ({ value: a.slug, label: `${a.name} — ${a.role}` })) }]}
                  onChange={(v) => { setTo(v); setCc((cur) => cur.filter((s) => s !== v)); }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, flex: 1, minWidth: 120 }}>
                <span className="microlabel">{t('mail.cc')} <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>— {t('mail.ccHint', { n: CC_MAX })}</span></span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} role="group" aria-label={t('mail.cc')}>
                  {agents.filter((a) => a.slug !== to).map((a) => {
                    const on = cc.includes(a.slug);
                    return (
                      /* 칩 자체 잠금 — .chip은 nowrap이라 초장문 이름의 min-content가 수축 불가.
                         하중은 내부 span(minWidth 0 + ellipsis, DropUp 트리거 라벨과 같은 문법 — flex
                         컨테이너인 버튼에는 text-overflow가 직접 안 걸린다)이고, 버튼 maxWidth 100%
                         (행 폭은 잠긴 트랙이라 확정 길이)는 이중 방어다(분리 검수 실측 — 단독 롤백 무영향).
                         nowrap은 .chip 상속에 맡기지 않고 span에 명시, title로 잘린 원문 확인 제공. */
                      <button key={a.slug} type="button" aria-pressed={on} onClick={() => toggleCc(a.slug)} className="chip" title={a.name}
                        style={{ cursor: 'pointer', maxWidth: '100%', minWidth: 0, ...(on ? { color: 'var(--primary-strong)', borderColor: 'var(--primary)', fontWeight: 700 } : { color: 'var(--fg-3)' }) }}>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('mail.messagePlaceholder')} aria-label={t('mail.message')}
              style={{ width: '100%', minHeight: 80, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', outline: 'none', fontSize: 13, lineHeight: 1.65, color: 'var(--fg)' }} />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary sm" disabled={sending || !to || !message.trim()}>
                {sending ? <Spinner size={12} /> : <><Icon name="send" size={12} /> {t('mail.send')}</>}
              </button>
              {notice && <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{notice}</span>}
              {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
            </div>
          </>
        )}
      </form>

      {/* ① 대기 중 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="clock" size={14} />{t('mail.pending')}</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{pending.length}</span>
        </div>
        {data === null ? (
          error ? <div style={{ padding: '0 18px 18px', fontSize: 12.5, color: 'var(--danger)' }}>{error}</div>
            : <div style={{ padding: '0 18px 18px' }}><Skeleton h={60} /></div>
        ) : pending.length === 0 ? (
          <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13, margin: 0 }}>{t('mail.emptyPending')}</p>
        ) : (
          /* 배율 2의 좁은 유효 폭(유효 712 CSS)에서 표 고정 열(150+130+420+150+90=940px)이 카드를
             넘는다. 카드 overflow:hidden이 가둬 문서 넘침은 아니지만, 취소 버튼이 잘려 조작 불가가
             된다(검수 실측: elementFromPoint 히트 null). 표 래퍼에 overflow-x:auto를 두어 카드
             안에서 가로 스크롤이 되게 하면 취소 버튼에 도달할 수 있다. 배율 1(표가 카드 안)에서는
             스크롤바가 안 나타나 종전 불변. */
          <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr><th style={{ width: 150 }}>{t('mail.to')}</th><th style={{ width: 130 }}>{t('mail.from')}</th><th>{t('mail.message')}</th><th style={{ width: 150 }} /><th style={{ width: 90 }} /></tr>
            </thead>
            <tbody>
              {pending.map((m) => (
                <tr key={`${m.to}/${m.file}`} style={{ cursor: 'default' }}>
                  <td>{who(m.to)}</td>
                  <td style={{ fontSize: 12, color: 'var(--fg-2)' }}>{m.fromRole === 'captain' ? t('mail.fromCaptain') : (m.fromName ?? m.from)} {kindChip(m.kind)}</td>
                  <td><span style={{ fontSize: 12.5, display: 'block', maxWidth: 420, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={m.message}>{m.message}</span></td>
                  <td style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                    {m.ts ? timeAgo(m.ts, lang) : '—'} · {t('mail.attempts', { n: m.attempts })}
                    {m.claimed && <span className="chip primary" style={{ marginLeft: 6, fontSize: 10.5 }}><span className="dot" />{t('mail.claimed')}</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm" disabled={m.claimed || busy === `c:${m.to}:${m.id}`} onClick={() => cancel(m)}>{t('mail.cancel')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* ② 배달 기록 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="tasks" size={14} />{t('mail.log')}</span>
          <span className="rule" />
        </div>
        {data === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={60} /></div>
        ) : log.length === 0 ? (
          <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13, margin: 0 }}>{t('mail.emptyLog')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <tbody>
              {log.map((l, i) => (
                <tr key={`${l.ts}-${l.id}-${i}`} style={{ cursor: 'default' }}>
                  <td style={{ width: 24 }}>
                    <span title={l.ok ? t('mail.ok') : (l.error === 'cancelled' ? t('mail.cancelled') : t('mail.fail'))}
                      style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: l.ok ? 'var(--primary)' : (l.error === 'cancelled' ? 'var(--fg-3)' : 'var(--danger)') }} />
                  </td>
                  <td style={{ width: 150 }}>{who(l.to)}</td>
                  <td style={{ fontSize: 12, color: 'var(--fg-2)' }}>{l.from === 'captain' ? t('mail.fromCaptain') : (l.fromName ?? l.from)} {l.kind && kindChip(l.kind)}</td>
                  <td style={{ fontSize: 11.5, color: l.ok ? 'var(--fg-2)' : 'var(--danger)' }}>
                    {l.ok ? t('mail.ok') : (l.error === 'cancelled' ? t('mail.cancelled') : `${t('mail.fail')} — ${l.error ?? ''}`)}
                  </td>
                  <td style={{ width: 120, fontSize: 11.5, color: 'var(--fg-3)' }}>{timeAgo(l.ts, lang)}</td>
                  <td style={{ width: 110, textAlign: 'right' }}>
                    <Link className="btn sm" href={`/c/${ws}/crew/${l.to}`}>{t('mail.openChat')}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* ③ 실패함 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="trash" size={14} />{t('mail.dead')}</span>
          <span className="rule" />
          {dead.length > 0 && <span className="pill"><span className="dot" />{dead.length}</span>}
        </div>
        {data === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={60} /></div>
        ) : dead.length === 0 ? (
          <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13, margin: 0 }}>{t('mail.emptyDead')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <tbody>
              {dead.map((d) => (
                <tr key={d.file} style={{ cursor: 'default' }}>
                  <td style={{ width: 150 }}>{d.corrupt ? <span className="mono" style={{ fontSize: 11 }}>{d.file}</span> : who(d.to)}</td>
                  <td style={{ fontSize: 12, color: 'var(--fg-2)' }}>{d.corrupt ? '' : <>{d.from === 'captain' ? t('mail.fromCaptain') : (d.fromName ?? d.from)} {d.kind && kindChip(d.kind)}</>}</td>
                  <td>
                    {d.corrupt
                      ? <span style={{ fontSize: 12, color: 'var(--danger)' }}>{t('mail.corrupt')}</span>
                      : <>
                        <span style={{ fontSize: 12.5, display: 'block', maxWidth: 360, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={d.message}>{d.message}</span>
                        <span style={{ fontSize: 11, color: 'var(--danger)', display: 'block' }}>{t('mail.attempts', { n: d.attempts })} · {d.lastError}</span>
                      </>}
                  </td>
                  <td style={{ width: 170, textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {!d.corrupt && <button className="btn sm" disabled={busy === `requeue:${d.file}`} onClick={() => patch('requeue', d.file)}><Icon name="play" size={12} /> {t('mail.requeue')}</button>}
                      <button className="btn sm btn-icon" style={{ width: 28 }} aria-label={t('mail.delete')} onClick={() => setDelTarget(d)}><Icon name="trash" size={13} /></button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
