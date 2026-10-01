'use client';
// 위임 제한 스위치 — 1:1 대화창과 회의실이 **같이 쓰는** 칩(작업 폴더 work-folder.jsx와 같은 공용 방식).
// 켜짐(기본) = "위임 제한 2회"(종전 제한), 풀림 = "위임 제한 풀림"(안전 상한까지: 위임 10·단계 4·회의실 이어받기 6명·반응 4라운드).
// 값은 대화방마다 서버가 저장한다(1:1 = 스레드 파일, 회의실 = 방 파일 — src/thread.mjs·room.mjs). 이 컴포넌트는 표시와 첫 해제 안내만 맡는다.
// 처음 풀 때만 확인 모달(사용량 증가 안내) — 이후 같은 기기에서는 바로 토글. 다시 거는 쪽은 언제나 바로(되돌리기가 안전한 방향).
import { useState } from 'react';
import { ConfirmModal } from '../../ui';
import { useLang } from '../../i18n';
import { DELEGATION_LIMITS } from '../../../src/delegation-limits.mjs';

const ACK_KEY = 'argo-deleg-ack'; // 안내를 한 번 확인한 기기 표시(언어 argo-lang·반응 라운드 argo-room-rounds와 같은 기기 단위 UI 설정)

/** limited: true = 켜짐(제한), false = 풀림, null = 아직 읽는 중(그리지 않는다).
    onChange(nextLimited) → Promise — 저장 호출은 화면(부모)이 맡는다(1:1·회의실의 엔드포인트가 다르다). scope: 'chat' | 'room'. */
export function DelegationToggle({ limited, onChange, scope = 'chat', disabled = false }) {
  const { t } = useLang();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const { on, off } = DELEGATION_LIMITS;
  const vars = { n: off.delegate, hop: off.hop, on: on.delegate, relay: off.relay, rounds: off.rounds };
  const flip = async (next) => { setBusy(true); try { await onChange(next); } finally { setBusy(false); } };
  const click = () => {
    if (busy) return;
    if (limited === false) { flip(true); return; } // 다시 걸기 = 확인 없이
    let acked = false;
    try { acked = localStorage.getItem(ACK_KEY) === '1'; } catch { /* 저장소 없음 — 매번 안내(안전한 쪽) */ }
    if (acked) flip(false); else setAsk(true);
  };
  if (limited === null) return null; // 읽는 중에는 그리지 않는다 — 자리표시로 '2회'를 먼저 보이면 이미 풀린 대화가 잠깐 제한된 것처럼 보인다
  const released = limited === false;
  return (
    <>
      <button type="button" className="btn sm" data-testid="deleg-toggle" aria-pressed={released}
        title={released ? t(`deleg.hintOff.${scope}`, vars) : t(`deleg.hintOn.${scope}`, { ...vars, n: on.delegate, hop: on.hop, relay: on.relay, rounds: on.rounds })}
        disabled={disabled || busy} onClick={click}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', minHeight: 24, height: 24, padding: '0 10px', fontSize: 11.5,
          ...(released ? { borderColor: 'var(--warn)', color: 'var(--warn)' } : { color: 'var(--fg-3)' }) }}>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, flex: 'none', background: released ? 'var(--warn)' : 'var(--fg-3)' }} />
        {released ? t('deleg.off') : t('deleg.on', { n: on.delegate })}
      </button>
      {ask && (
        <ConfirmModal tone="primary" title={t('deleg.confirmTitle')} description={t(`deleg.confirmBody.${scope}`, vars)}
          confirmLabel={t('deleg.confirmDo')} busy={busy}
          onConfirm={async () => { try { localStorage.setItem(ACK_KEY, '1'); } catch { /* 무시 */ } await flip(false); setAsk(false); }}
          onClose={() => setAsk(false)} />
      )}
    </>
  );
}
