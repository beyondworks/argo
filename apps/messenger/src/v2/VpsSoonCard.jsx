// 메신저 v2 'VPS 에이전트 연결 준비 중' 안내 카드(유건 사용 검수 2026-10-23 — 설정 '에이전트와 서버'·'외부 에이전트 연결'·폰 '서버'·실행기 '외부 에이전트'가 v2에서 빈 화면이었다).
// 옛 VPS 봇 연결(명령 표시 → 실행 → 목록 체크 → 저장)은 v2 서버에 아직 없다. 같은 자리를 나중에 VPS 연결 카드(feat/msgr2-vps-connect)가 대신하므로
// 이 카드는 따로 두고 App.jsx(OrgCard)는 이 카드를 부르는 한 줄만 바꾼다. 서버를 읽지 않는다(요청 0). 모양은 기존 설정 카드(msgr-setcard).
import { useCallback } from 'react';
import { useLang } from '@argo/i18n';
import { t as tm } from '../i18n.js';

export function VpsSoonCard() {
  const { lang } = useLang();
  const t = useCallback((k, v) => tm(k, lang, v), [lang]);
  return (
    <section className="msgr-setcard msgr-v2-vps-soon" data-v2="vps-soon">
      <h2>{t('v2.vps.soon.title')}</h2>
      <p>{t('v2.vps.soon.body')}</p>
    </section>
  );
}
