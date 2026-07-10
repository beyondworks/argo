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
    <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
      <span className="microlabel">Settings · 회사 설정</span>

      <form onSubmit={saveName} className="card" style={{ padding: 18, display: 'grid', gap: 10 }}>
        <span className="card-title">회사 정보</span>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">Company Name</span>
          <input
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
  );
}
