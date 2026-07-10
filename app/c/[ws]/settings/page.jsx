'use client';
// 설정 — 회사 정보 수정, 제원, 위험 구역(보관).
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, Spinner, Skeleton, api, imeGuard } from '../../../ui';

export default function Settings({ params }) {
  const { ws } = use(params);
  const router = useRouter();
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api(`/api/companies/${ws}`).then((d) => { setData(d); setName(d.company?.name ?? ''); }).catch(() => setData({}));
  }, [ws]);

  async function saveName(e) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true); setMsg('');
    try {
      await fetch(`/api/companies/${ws}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      window.dispatchEvent(new Event('argo:refresh'));
      setMsg('저장됨');
    } catch (e2) {
      setMsg(String(e2.message));
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    const typed = window.prompt(`회사를 보관하면 목록에서 사라집니다(폴더는 .archive/에 보존).\n확인을 위해 회사 이름을 입력하세요: ${data?.company?.name}`);
    if (typed !== data?.company?.name) return;
    await fetch(`/api/companies/${ws}`, { method: 'DELETE' });
    router.push('/');
  }

  const c = data?.company;
  const rows = c && [
    ['Unit', c.id],
    ['Captain', c.owner],
    ['Commissioned', String(c.created ?? '').slice(0, 10)],
    ['Crew', `${data.agents?.length ?? 0}`],
    ['Vault', `${data.memoryCount ?? 0} records · ${data.stats?.links ?? 0} links`],
    ['Engine', 'Claude Agent SDK'],
    ['Runtime', 'Local (P1: 클라우드 워커)'],
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <span className="microlabel">Settings · 회사 설정</span>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, alignItems: 'start' }}>
      <form onSubmit={saveName} className="card" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
        <span className="card-title">회사 정보</span>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">Company Name</span>
          <input suppressHydrationWarning
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...imeGuard}
            style={{ height: 36, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13.5 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary sm" disabled={saving || !name.trim()}>
            {saving ? <Spinner size={12} /> : '저장'}
          </button>
          <span style={{ fontSize: 12, color: msg === '저장됨' ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>
        </div>
      </form>

      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span className="card-title">제원</span>
          <span className="microlabel">S/N ARGO-01</span>
        </div>
        {!rows ? <Skeleton h={130} /> : (
          <div style={{ display: 'grid', gap: 5 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
                <span className="microlabel">{k}</span>
                <span className="mono" style={{ fontSize: 11 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          <span className="barcode" aria-hidden="true" />
          <span className="microlabel">Sail Together</span>
        </div>
      </div>

      <ConnectionCard ws={ws} kind="telegram" title="텔레그램"
        help='@BotFather로 봇을 만들어 토큰을 붙여넣고 가동하세요. 봇에게 첫 메시지를 보내면 이 회사와 연결됩니다. "@크루이름 지시"로 특정 크루를 부를 수 있고, 결재는 버튼으로 처리됩니다.'
        agents={data?.agents ?? []} />
      <ConnectionCard ws={ws} kind="slack" title="슬랙"
        help='봇 토큰(xoxb-)과 채널 ID를 넣고 봇을 그 채널에 초대하세요. 채널 메시지가 크루에게 전달되고, 결재는 "승인 <번호>" 회신으로 처리됩니다.'
        agents={data?.agents ?? []} />

      <div className="card" style={{ padding: 18, borderColor: 'var(--danger)' }}>
        <span className="card-title" style={{ color: 'var(--danger)' }}>위험 구역</span>
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: '8px 0 12px' }}>
          회사를 보관하면 목록에서 사라집니다. 데이터(크루·기억·루틴)는 삭제되지 않고
          <span className="mono" style={{ fontSize: 11 }}> workspaces/.archive/</span>에 보존됩니다.
        </p>
        <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={archive}>
          <Icon name="trash" size={13} /> 회사 보관
        </button>
      </div>
      </div>
    </div>
  );
}

const fieldStyle = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, width: '100%' };

/** 메신저 연결 카드 — 토큰은 서버에만 저장(화면은 마스킹), 가동 토글로 게이트웨이 시작/중지. */
function ConnectionCard({ ws, kind, title, help, agents }) {
  const [conn, setConn] = useState(null);
  const [token, setToken] = useState('');
  const [channel, setChannel] = useState('');
  const [crew, setCrew] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  function load() {
    api(`/api/companies/${ws}/connections`).then((d) => {
      const c = d.connections[kind];
      setConn(c); setChannel(c.channel ?? ''); setCrew(c.defaultCrew ?? '');
    }).catch(() => setConn({}));
  }
  useEffect(load, [ws]);

  async function save(enabled) {
    setSaving(true); setMsg('');
    try {
      const d = await api(`/api/companies/${ws}/connections`, {
        kind, token, enabled, defaultCrew: crew, ...(kind === 'slack' ? { channel } : {}),
      });
      setConn(d.connections[kind]); setToken('');
      setMsg(enabled ? '가동 중 — 게이트웨이가 곧 연결됩니다' : '중지됨');
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  const on = conn?.enabled;
  return (
    <div className="card" style={{ padding: 18, display: 'grid', gap: 10, alignContent: 'start' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-title">{title} 연결</span>
        <span className="chip">{on ? <><span className="dot" />가동</> : '중지'}{kind === 'telegram' && conn?.chatId ? ' · 페어링됨' : ''}</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{help}</p>
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="microlabel">Bot Token{conn?.hasToken ? ` · 저장됨 ${conn.token}` : ''}</span>
        <input suppressHydrationWarning type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder={conn?.hasToken ? '변경할 때만 입력' : (kind === 'telegram' ? '123456:ABC-…' : 'xoxb-…')} style={fieldStyle} />
      </label>
      {kind === 'slack' && (
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">Channel ID</span>
          <input suppressHydrationWarning value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C0…" style={fieldStyle} />
        </label>
      )}
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="microlabel">기본 크루 — 이름 없이 보낸 지시를 받는다</span>
        <select value={crew} onChange={(e) => setCrew(e.target.value)} style={fieldStyle}>
          <option value="">첫 번째 크루</option>
          {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} — {a.role}</option>)}
        </select>
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-primary sm" disabled={saving || (!conn?.hasToken && !token.trim())} onClick={() => save(true)}>
          {saving ? <Spinner size={12} /> : on ? '설정 저장' : '가동'}
        </button>
        {on && <button className="btn sm" disabled={saving} onClick={() => save(false)}>중지</button>}
        <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{msg}</span>
      </div>
    </div>
  );
}
