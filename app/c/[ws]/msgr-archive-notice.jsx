'use client';
// 회사 화면 머리의 메신저 기록 옮기기 완료 안내(0.1.113) — 앱 시작 때 자동으로 옮긴 결과를 사용자가 설정에 가지 않아도 본다.
// 조회는 회사 화면을 열 때 한 번, 로컬 상태 파일만(?local=1 — Supabase 요청 0). 닫으면 같은 완료는 이 기기에서 다시 보이지 않는다(localStorage).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLang } from '../../i18n';
import { api } from '../../ui';
import { showArchiveNotice, archiveNoticeKey, ARCHIVE_NOTICE_SEEN } from './settings/msgr-archive-view.mjs';

const readSeen = () => { try { return localStorage.getItem(ARCHIVE_NOTICE_SEEN); } catch { return null; } };

export default function MsgrArchiveNotice({ ws }) {
  const { t } = useLang();
  const [st, setSt] = useState(null);
  const [seen, setSeen] = useState(null);
  useEffect(() => {
    setSeen(readSeen());
    api(`/api/companies/${ws}/msgr-archive?local=1`).then(setSt).catch(() => {});
  }, [ws]);
  if (!showArchiveNotice(st, seen)) return null;
  const close = () => { const k = archiveNoticeKey(st); try { localStorage.setItem(ARCHIVE_NOTICE_SEEN, k); } catch { /* 저장 못 해도 이번엔 닫는다 */ } setSeen(k); };
  return (
    <div role="status" className="card" style={{ margin: '0 0 12px', padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
      <span style={{ flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere' }}>
        {t(st.status === 'partial' ? 'msgrArchive.noticePartial' : 'msgrArchive.notice', { dir: st.dir, n: st.failed ?? 0 })}
      </span>
      <Link className="btn sm" href={`/c/${st.ws ?? ws}/settings`}>{t('msgrArchive.noticeSettings')}</Link>
      <button type="button" className="btn sm" onClick={close} aria-label={t('common.close')}>×</button>
    </div>
  );
}
