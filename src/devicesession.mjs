// 기기 세션 — "이 기기 = 이 계정" (M-2 로그인=연동의 심장).
// Supabase Auth 세션(access+refresh)을 기기 파일(0600)에 보관하고, 만료 임박 시 스스로 회전한다.
// 회전 충돌 방지 원칙: 이 파일이 세션의 단일 소유자 — 브라우저 쿠키/클라이언트와 refresh 토큰을
// 공유하지 않는다(공유하면 Supabase 토큰 회전 재사용 감지로 세션 일가족이 폐기된다).
// 진단 흔적(2026-09-02 실사용 제보 "세션 만료가 또 뜬다" — 거절 사유를 볼 곳이 없었다):
//   .device-session.json.dead = 거절 사유 JSON({ at, lastAt, count, kind, reason, status, code, retried })
//   .device-session.log       = 회전 성공·거절·오류 한 줄씩(JSONL, 같은 사유의 연속 반복은 한 줄만)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename, rm, appendFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT } from './workspace.mjs';
import { withLock } from './mutex.mjs';
import { createHash } from 'node:crypto';

const FILE = '.device-session.json';
const LOG = '.device-session.log';
const LOG_MAX = 256 * 1024; // 넘치면 .1로 한 세대만 밀어낸다
let cache = null; // { root, sess, stamp } — stamp = 디스크 mtime+size. 다른 모듈 사본·프로세스가 회전해 파일이 바뀌면 캐시는 무효다
let epoch = 0;
export const deviceEpoch = () => epoch;
const fileOf = (root) => join(root, FILE);
const deadMarkerOf = (root) => `${fileOf(root)}.dead`;

/** 디스크 원본 — 캐시를 거치지 않는다. 손상은 경고(경로만) 후 null — 시크릿 값은 절대 출력하지 않는다. */
function readDisk(root) {
  try {
    const d = JSON.parse(readFileSync(fileOf(root), 'utf8'));
    if (d.url && d.anonKey && d.refresh_token && d.access_token && d.user?.id) return d;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[argo] 기기 세션 파일 손상 — 재로그인 필요: ${fileOf(root)}`);
  }
  return null;
}

/** 디스크 파일의 정체 도장(mtime+size). 없음 = 'none'. */
function diskStamp(root) {
  try { const st = statSync(fileOf(root)); return `${st.mtimeMs}:${st.size}`; } catch { return 'none'; }
}

/** 기기 세션 또는 null. 캐시는 디스크 도장(mtime+size)이 같을 때만 쓴다 — Next는 instrumentation(동기화 루프)과
    API 라우트에 이 모듈을 **따로 번들**하므로 한 프로세스에 캐시가 둘이다. 도장 없는 캐시는 한쪽이 회전한 뒤
    다른 쪽이 옛 토큰으로 갱신을 보내게 했고, GoTrue는 재사용 간격(10초) 밖 재사용을 "가족 폐기"로 처리해
    새 토큰까지 죽였다(2026-09-03 실사고 — 라우트 사본이 8분 뒤 옛 토큰 재사용 → 다음 회전 Already Used). */
export function loadDeviceSession({ root = WS_ROOT } = {}) {
  const stamp = diskStamp(root);
  if (cache && cache.root === root && cache.stamp === stamp) return cache.sess;
  const sess = readDisk(root);
  cache = { root, sess, stamp };
  return sess;
}

async function persist(sess, root) {
  await mkdir(root, { recursive: true });
  const tmp = join(root, `.tmp-devsess-${process.pid}-${Date.now().toString(36)}`);
  await writeFile(tmp, JSON.stringify(sess, null, 2), { mode: 0o600 }); // 생성 시점부터 0600
  await rename(tmp, fileOf(root)); // 원자 교체 — 모드 보존
  // 새 세션을 저장했으면 옛 사망 마커는 무효다 — 안 지우면 재로그인 후에도 UI가 계속 "세션 만료"를
  // 띄운다(실사용 제보 2026-09-01). 마커 해제가 갱신 성공 경로에만 있던 갭 — 로그인도 회생 경로다.
  await rm(deadMarkerOf(root), { force: true }).catch(() => {});
  cache = null;
  epoch++;
}

/** 로그인/링크 시 저장. session = Supabase Auth 세션(user 포함).
 * getFreshDeviceSession의 회전과 같은 락(devsess:root)으로 직렬화 — 회전 대기 중 끼어들어도 lost update 없음. */
export async function saveDeviceSession({ url, anonKey, session }, { root = WS_ROOT } = {}) {
  return withLock(`devsess:${root}`, async () => {
    if (!url || !anonKey || !session?.access_token || !session?.refresh_token || !session?.user?.id) {
      throw new Error('기기 세션 저장에 필요한 값 누락 (url/anonKey/session)');
    }
    await persist({
      url, anonKey,
      user: { id: session.user.id, email: session.user.email ?? '' },
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at ?? 0,
    }, root);
  });
}

/** 같은 락(devsess:root)으로 직렬화 — 회전 중 삭제가 끼어들어도 순서 보장. */
export async function clearDeviceSession({ root = WS_ROOT } = {}) {
  return withLock(`devsess:${root}`, async () => {
    await rm(fileOf(root), { force: true });
    cache = null;
    epoch++;
  });
}

/* ─── 사망 마커·진단 로그 ─── */

/** 사유 문구의 토큰 모양(20자 이상 base64url 런 — JWT 헤더 세그먼트 20자·리프레시 토큰 22자를 덮는다)을 가린다 —
    마커·로그·콘솔·/api/me 응답에 실리는 값 전부 이 함수를 거친다. */
const mask = (s) => String(s ?? '').replace(/[A-Za-z0-9_-]{20,}/g, '***').slice(0, 300);
/** 리프레시 토큰 지문(sha256 앞 16자) — 마커에 "어느 토큰이 거절됐나"를 값 노출 없이 남긴다. */
const tokenTag = (rt) => createHash('sha256').update(String(rt ?? '')).digest('hex').slice(0, 16);
/** 리프레시 토큰 거절인가(Invalid Refresh Token 계열) — 네트워크 실패·5xx는 거절이 아니다. */
const isRejection = (err) => /refresh token/i.test(String(err?.message ?? ''));

/** 거절 사유 분류(Supabase GoTrue 문구 기준). UI 문구는 i18n `me.sessionDead.kind.<kind>` — 값 집합을 바꾸면 사전도 같이.
 *  reused   = "Already Used" — 이 토큰을 누가 먼저 썼다(이중 회전 의심, 가족 폐기 후에도 같은 문구)
 *  revoked  = "Not Found"    — 서버에 세션이 없다(다른 곳 로그아웃·관리자 회수)
 *  expired  = "Session Expired(...)" — 세션 정책 만료(괄호 안 원문에 타임박스·비활동·신규 로그인 세부)
 *  rejected = 그 외 거절 */
export function rejectionKind(msg) {
  const m = String(msg ?? '');
  if (/already used/i.test(m)) return 'reused';
  if (/not found/i.test(m)) return 'revoked';
  if (/session expired/i.test(m)) return 'expired';
  return 'rejected';
}

/** 사망 마커 내용(JSON) 또는 null — 마커 없음·구형(ISO 문자열) 마커. 존재 판정은 deviceSessionDead. */
export function deviceSessionDeadInfo({ root = WS_ROOT } = {}) {
  try {
    const d = JSON.parse(readFileSync(deadMarkerOf(root), 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch { return null; }
}

/** 마커 기록 — 같은 사유가 반복되면 최초 시각(at)을 보존하고 count만 올린다(동기화가 8초마다 다시 부딪친다). */
async function markDead(root, err, retried, sess) {
  const reason = mask(err?.message ?? 'no session');
  const prev = deviceSessionDeadInfo({ root });
  const same = prev?.reason === reason;
  const now = new Date().toISOString();
  const info = {
    at: same ? prev.at : now, lastAt: now, count: same ? (prev.count ?? 0) + 1 : 1,
    kind: rejectionKind(reason), reason, status: err?.status ?? null, code: err?.code ?? null, retried,
    tokenTag: tokenTag(sess?.refresh_token), // 이 토큰이 거절됐다 — 같은 토큰이면 다시 보내지 않는다(아래 게이트)
  };
  await writeFile(deadMarkerOf(root), JSON.stringify(info), { mode: 0o600 }).catch(() => {});
  await chmod(deadMarkerOf(root), 0o600).catch(() => {}); // 발행본이 mode 없이 쓴 구형 마커(0644) 위에 덮어도 승격(검수 LOW-2)
  return info;
}

const lastLogKey = new Map(); // root → 마지막 줄 키. 같은 사유의 연속 반복(rejected/error)은 한 줄만 — rotated·reread는 항상 남긴다(회전 이력이 진단의 핵심)
async function logLine(root, entry) {
  const key = `${entry.ev}|${entry.reason ?? ''}`;
  if ((entry.ev === 'rejected' || entry.ev === 'error' || entry.ev === 'skipped') && key === lastLogKey.get(root)) return;
  const file = join(root, LOG);
  try { if (statSync(file).size > LOG_MAX) await rename(file, `${file}.1`); } catch { /* 없음 */ }
  try {
    await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry })}\n`, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
    lastLogKey.set(root, key); // 실제로 남긴 뒤에만 — 쓰기 실패가 그 사유를 영구 침묵시키지 않게(검수 LOW-5)
  } catch { /* 로그는 진단 보조 — 실패해도 회전 경로를 막지 않는다 */ }
}

/** 기기 세션이 "만료 + 갱신 사망(리프레시 거절)" 상태인가 — 회전을 유발하지 않는 읽기 전용 판정.
    /api/me 같은 UI 경로가 갱신을 직접 트리거하면 상주·사이드카 이중 회전으로 세션 가족이 폐기된다
    (2026-08-14 사고 구조 — 분리 검수 M4). 마커는 실제 갱신 시도(피드백·동기화 등 기존 경로)가 남긴다. */
export function deviceSessionDead({ root = WS_ROOT } = {}) {
  const sess = loadDeviceSession({ root });
  if (!sess) return false;
  if ((sess.expires_at ?? 0) * 1000 - Date.now() > 60_000) return false;
  return existsSync(deadMarkerOf(root));
}

/** 유효한 access token 보장 — 만료 60초 전이면 회전 후 저장(락으로 직렬화). null = 세션 없음/회전 실패.
 * _mkClient: 테스트 주입용 — 기본값은 실제 Supabase 클라이언트 팩토리(createClient). 프로덕션 호출부는 지정하지 않는다. */
export async function getFreshDeviceSession({ root = WS_ROOT, _mkClient = createClient } = {}) {
  return withLock(`devsess:${root}`, async () => {
    let sess = loadDeviceSession({ root });
    let retried = false;
    for (;;) {
      if (!sess) return null;
      if ((sess.expires_at ?? 0) * 1000 - Date.now() > 60_000) return sess;
      // 사망 게이트 — 마커가 "바로 이 토큰"의 거절이면 다시 보내지 않는다. 8초 동기화 루프가 죽은 토큰을
      // 계속 보내 기기당 하루 1만 회(24기기 11만 회/일)의 "Possible abuse attempt"를 만들었다(2026-09-04 인증 로그 실측).
      // 디스크 토큰이 바뀌면(재로그인·다른 사본 회전) 지문이 달라져 게이트가 열린다 — persist도 마커를 지운다.
      const dead = deviceSessionDeadInfo({ root });
      if (dead?.tokenTag && dead.tokenTag === tokenTag(sess.refresh_token)) {
        await logLine(root, { ev: 'skipped', reason: dead.reason });
        return null;
      }
      const sb = _mkClient(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await sb.auth.refreshSession({ refresh_token: sess.refresh_token });
      if (!error && data?.session) {
        const s = data.session;
        const next = {
          ...sess,
          access_token: s.access_token,
          refresh_token: s.refresh_token, // 회전된 토큰 즉시 영속 — 유실 시 세션 일가족 폐기
          expires_at: s.expires_at ?? 0,
          user: { id: s.user?.id ?? sess.user.id, email: s.user?.email ?? sess.user.email },
        };
        await persist(next, root);
        await rm(deadMarkerOf(root), { force: true }).catch(() => {}); // 회생 — 마커 해제(persist의 해제와 같은 계약: '새/살아난 세션을 디스크에 쓰면 옛 사망 판정은 무효'. 한쪽만 고치지 말 것 — 검수 LOW-1)
        await logLine(root, { ev: 'rotated', retried, expires_at: next.expires_at });
        return next;
      }
      console.warn('[argo] 기기 세션 갱신 실패 — 재로그인 필요:', mask(error?.message ?? 'no session')); // stderr 로그(0644)에도 토큰 모양은 안 싣는다
      // 사망 마커 — **리프레시 토큰이 서버에서 거절된 경우만**(Invalid Refresh Token 계열 = 가족 폐기,
      // 재시도 무의미). 네트워크 실패·5xx는 마커를 남기지 않는다 — 오프라인을 "재로그인 필요"로
      // 오진하면 사용자가 기기 재바인딩(다른 계정이면 이전 주인 로그아웃)까지 가는 과잉 처방이 된다
      // (분리 검수 M3). /api/me가 이 마커만 읽어 회전 없이 판정한다(M4 — UI 마운트발 이중 회전 금지).
      if (!isRejection(error)) {
        await logLine(root, { ev: 'error', reason: mask(error?.message ?? 'no session'), status: error?.status ?? null });
        return null;
      }
      // 거절 = 이 프로세스가 든 토큰이 서버에서 무효. 다른 프로세스(사이드카·재로그인)가 먼저 회전해
      // 디스크가 바뀌었을 수 있다 — 캐시를 무시하고 디스크를 재독해 토큰이 다르면 그 세션으로 딱 한 번
      // 다시 간다(자가 치유). 디스크도 같은 토큰(=진짜 사망)이거나 재시도까지 거절될 때만 마커를 남긴다.
      if (!retried) {
        const disk = readDisk(root);
        cache = { root, sess: disk };
        if (!disk || disk.refresh_token !== sess.refresh_token) {
          await logLine(root, { ev: 'reread', disk: disk ? 'changed' : 'gone' });
          retried = true;
          sess = disk;
          continue;
        }
      }
      const info = await markDead(root, error, retried, sess);
      await logLine(root, { ev: 'rejected', kind: info.kind, reason: info.reason, status: info.status, code: info.code, retried, count: info.count });
      return null;
    }
  });
}
