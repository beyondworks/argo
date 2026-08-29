// E2EE(종단간 암호화) 관리 — 계정 스코프. 설계 정본: 루트 E2EE-DESIGN.md.
// 원칙: 서버(이 라우트 포함)는 DEK 평문을 절대 만지지 않는다 — 여기서 다루는 것은 공개키·랩(암호문)·
// 지문뿐이고, DEK 생성·개봉은 전부 로컬 프로세스(src/e2ee.mjs)에서 일어난다.
// 인증: 기기 세션의 사용자 스코프 클라이언트(RLS own) — me/billing과 같은 패턴. 서비스키 불요.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { currentUser, authError, requestLang } from '../../../auth.mjs';
import { getFreshDeviceSession } from '../../../../src/devicesession.mjs';
import { getDeviceId } from '../../../../src/workspace.mjs';
import {
  loadDeviceE2ee, dek, setDek, wrapDekFor, openDekWrap, pubFingerprint,
  generateRecoveryCode, deriveRecoveryKek, RECOVERY_KDF, wrapDekWithKek, openDekWithKek,
  tryClaimDek, _resetClaimForTest,
} from '../../../../src/e2ee.mjs';
import { markResealAll, nudgeSync } from '../../../../src/sync.mjs';
import { proRowActive, TRIAL_DAYS } from '../../../../src/entitlement.mjs';

export const maxDuration = 60;

/** 기기 세션 기반 사용자 스코프 클라이언트 — 없으면 null(E2EE는 로그인-연동 기기 전용). */
async function userSb() {
  if (process.env.ARGO_TENANT_OWNER?.trim()) return null; // 워커는 E2EE 관리 주체가 아니다(위임은 별도 트랙)
  const sess = await getFreshDeviceSession().catch(() => null);
  if (!sess?.access_token) return null;
  return createClient(sess.url, sess.anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${sess.access_token}` }, fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(15_000) }) },
  });
}

async function snapshot(sb, deviceId) {
  const [{ data: keys, error: e1 }, { data: wraps, error: e2 }] = await Promise.all([
    sb.from('device_keys').select('device_id,pubkey,created_at'),
    sb.from('wrapped_deks').select('device_id,created_at'),
  ]);
  if (e1 || e2) throw new Error((e1 ?? e2).message);
  const wrapped = new Set((wraps ?? []).map((w) => w.device_id));
  const my = await loadDeviceE2ee();
  const devices = (keys ?? []).map((k) => ({
    deviceId: k.device_id,
    fingerprint: pubFingerprint(k.pubkey),
    hasWrap: wrapped.has(k.device_id),
    createdAt: k.created_at,
    isThis: k.device_id === deviceId,
    // 등록된 pubkey와 이 기기 키 파일의 불일치 — 키 파일 유실 후 재생성 신호(제거 후 재등록 필요, §10.5)
    keyMismatch: k.device_id === deviceId && k.pubkey !== my.pub,
  }));
  return { devices, enabled: wrapped.size > 0, hasDek: !!dek(), fingerprint: pubFingerprint(my.pub) };
}

export async function GET() {
  try {
    const user = await currentUser();
    if (!user?.id || user.id === 'local' || user.id === 'guest') return Response.json({ available: false, reason: 'unauthenticated' });
    const sb = await userSb();
    if (!sb) return Response.json({ available: false, reason: 'no-device-session' });
    const deviceId = await getDeviceId();
    const s = await snapshot(sb, deviceId);
    return Response.json({ available: true, deviceId, ...s });
  } catch (e) {
    return Response.json({ available: false, reason: String(e.message || e).slice(0, 120) }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const user = await currentUser();
    if (!user?.id || user.id === 'local' || user.id === 'guest') return authError('auth_required', await requestLang());
    const sb = await userSb();
    if (!sb) return Response.json({ error: '기기 연동 세션이 필요합니다 — Argo 앱에서 로그인해 주세요' }, { status: 401 });
    const deviceId = await getDeviceId();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    if (action === 'enable') {
      // 켜기 = 이 기기가 DEK를 생성해 계정의 첫 열쇠 보유자가 된다. 이미 활성이면 claim/승인 경로로 안내.
      if (dek()) return Response.json({ error: '이미 이 기기에서 켜져 있습니다' }, { status: 400 });
      // "이미 켜짐" 판정에서 **자기 기기 행은 제외**(분리 검수 MEDIUM): 이전 enable이 자기 랩 기록 후
      // 복구 랩에서 실패하면 자기 잔재를 "남이 켰다"로 오판해 영구 교착이 된다. 자기 랩만 남았으면
      // 그 랩을 열어(개인키 보유) 같은 DEK로 이어간다 — 재시도가 곧 자가 치유.
      const { data: mine } = await sb.from('wrapped_deks').select('wrap').eq('device_id', deviceId).maybeSingle();
      const { data: others } = await sb.from('wrapped_deks').select('device_id').neq('device_id', deviceId).limit(1);
      if ((others ?? []).length > 0) {
        return Response.json({ error: '이미 다른 기기에서 켜져 있습니다 — 그 기기에서 이 기기를 승인해 주세요' }, { status: 409 });
      }
      // 플랜 게이트 — 동기화가 실제로 도는 상태(Pro·체험)에서만: 재봉인 push가 free RLS에 막혀
      // "켰는데 아무것도 암호화 안 됨"이 되는 것을 정직하게 사전 차단(#325 HIGH-2와 같은 원칙).
      const { data: ent } = await sb.from('entitlements').select('plan,ends_at').maybeSingle();
      const created = (await sb.auth.getUser()).data?.user?.created_at;
      const trial = created ? (Date.now() - new Date(created).getTime()) < TRIAL_DAYS * 86_400_000 : false;
      if (!(proRowActive(ent ?? {}) || trial)) {
        return Response.json({ error: '종단간 암호화는 동기화가 도는 상태(Pro·체험)에서 켤 수 있습니다' }, { status: 403 });
      }
      const myKeys = await loadDeviceE2ee();
      const dekBytes = mine?.wrap ? await openDekWrap(Buffer.from(mine.wrap, 'base64')) : randomBytes(32);
      // 복구 코드 — 생성 시 1회만 반환하고 어디에도 저장하지 않는다(서버엔 랩+KDF 파라미터만).
      const code = generateRecoveryCode();
      const salt = randomBytes(16).toString('base64');
      const kek = deriveRecoveryKek(code, salt);
      const recoveryWrap = wrapDekWithKek(kek, dekBytes).toString('base64');
      const myWrap = wrapDekFor(myKeys.pub, dekBytes).toString('base64');
      // 서버 기록(전부 암호문·파라미터) → 성공 후에만 로컬 DEK 확정 — 반쪽 활성(로컬만 켜짐) 방지
      const { error: e1 } = await sb.from('wrapped_deks').upsert({ user_id: user.id, device_id: deviceId, wrap: myWrap, wrapped_by: deviceId }, { onConflict: 'user_id,device_id' });
      if (e1) throw new Error(e1.message);
      const { error: e2 } = await sb.from('recovery_wraps').upsert({ user_id: user.id, wrap: recoveryWrap, kdf: { ...RECOVERY_KDF, salt } }, { onConflict: 'user_id' });
      if (e2) throw new Error(e2.message);
      await setDek(dekBytes);
      const resealed = await markResealAll();
      nudgeSync();
      const s = await snapshot(sb, deviceId);
      return Response.json({ ok: true, recoveryCode: code, resealed, ...s });
    }

    if (action === 'approve') {
      // 대기 기기 승인 — 이 기기(DEK 보유)가 대상 기기 공개키로 DEK를 랩해 서버에 둔다.
      // 사용자는 두 화면의 지문(fingerprint)을 대조한 뒤 눌러야 한다(SAS — 서버의 공개키 바꿔치기 방어).
      const dk = dek();
      if (!dk) return Response.json({ error: '이 기기에 열쇠가 없습니다 — 열쇠 보유 기기에서 승인해 주세요' }, { status: 400 });
      const target = String(body.deviceId ?? '');
      if (!target || target === deviceId) return Response.json({ error: '승인할 기기를 지정해 주세요' }, { status: 400 });
      const { data: row, error } = await sb.from('device_keys').select('pubkey').eq('device_id', target).maybeSingle();
      if (error) throw new Error(error.message);
      if (!row?.pubkey) return Response.json({ error: '대상 기기의 공개키가 없습니다(앱 업데이트·로그인 확인)' }, { status: 404 });
      const wrap = wrapDekFor(row.pubkey, dk).toString('base64');
      const { error: e1 } = await sb.from('wrapped_deks').upsert({ user_id: user.id, device_id: target, wrap, wrapped_by: deviceId }, { onConflict: 'user_id,device_id' });
      if (e1) throw new Error(e1.message);
      return Response.json({ ok: true, fingerprint: pubFingerprint(row.pubkey), ...(await snapshot(sb, deviceId)) });
    }

    if (action === 'claim') {
      // 새 기기 — 서버의 내 랩을 회수해 잠김 해제(승인·복구가 넣어준 랩)
      _resetClaimForTest(); // 60초 스로틀 해제 — 사용자가 버튼으로 즉시 시도
      const ok = await tryClaimDek(sb, deviceId, { force: true });
      if (ok) nudgeSync();
      return Response.json({ ok, ...(await snapshot(sb, deviceId)) });
    }

    if (action === 'recover') {
      // 복구 코드로 DEK 복원 — 전 기기 분실 폴백. 코드는 160bit 랜덤이라 브루트포스는 계산상 무의미하고,
      // 이 스로틀은 인증된 사용자의 scrypt(N=2^17) 반복 호출이 서버 CPU를 갉는 것만 막는다(검수 LOW).
      if (Date.now() - (globalThis.__argoE2eeRecoverTs ?? 0) < 5_000) {
        return Response.json({ error: '잠시 후 다시 시도해 주세요' }, { status: 429 });
      }
      globalThis.__argoE2eeRecoverTs = Date.now();
      if (dek()) return Response.json({ error: '이미 이 기기에 열쇠가 있습니다' }, { status: 400 });
      const { data: rec, error } = await sb.from('recovery_wraps').select('wrap,kdf').maybeSingle();
      if (error) throw new Error(error.message);
      if (!rec?.wrap) return Response.json({ error: '복구 코드가 설정돼 있지 않습니다' }, { status: 404 });
      let dekBytes;
      try {
        const kek = deriveRecoveryKek(String(body.code ?? ''), rec.kdf?.salt, rec.kdf ?? undefined);
        dekBytes = openDekWithKek(kek, Buffer.from(rec.wrap, 'base64'));
      } catch (e2) {
        return Response.json({ error: String(e2.message || '복구 코드가 맞지 않습니다') }, { status: 400 });
      }
      await setDek(dekBytes);
      const myKeys = await loadDeviceE2ee();
      // 이 기기 랩도 등록해 다음부터는 승인·복구 없이 claim으로 열리게
      await sb.from('wrapped_deks').upsert({ user_id: user.id, device_id: deviceId, wrap: wrapDekFor(myKeys.pub, dekBytes).toString('base64'), wrapped_by: deviceId }, { onConflict: 'user_id,device_id' });
      nudgeSync();
      return Response.json({ ok: true, ...(await snapshot(sb, deviceId)) });
    }

    if (action === 'revoke') {
      // 기기 제거 — 해당 기기의 랩·공개키 행 삭제(재등록 가능해짐). DEK 회전은 후속 트랙(E2EE-DESIGN §10.5) —
      // 제거된 기기가 이미 로컬에 DEK 사본을 가졌을 수 있음을 UI가 정직하게 고지한다.
      const target = String(body.deviceId ?? '');
      if (!target) return Response.json({ error: '제거할 기기를 지정해 주세요' }, { status: 400 });
      if (target === deviceId) return Response.json({ error: '이 기기 자신은 제거할 수 없습니다' }, { status: 400 });
      const { error: e1 } = await sb.from('wrapped_deks').delete().eq('device_id', target);
      if (e1) throw new Error(e1.message);
      const { error: e2 } = await sb.from('device_keys').delete().eq('device_id', target);
      if (e2) throw new Error(e2.message);
      return Response.json({ ok: true, rotated: false, ...(await snapshot(sb, deviceId)) });
    }

    return Response.json({ error: '알 수 없는 action' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e).slice(0, 160) }, { status: 400 });
  }
}
