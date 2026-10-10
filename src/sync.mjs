// C-1 기기 간 동기화 — "회사 = 폴더" 하나가 진실의 원천이고, 이 엔진이 그 폴더를
// Supabase Storage에 복제해 어느 기기에서 켜도 같은 회사가 열리게 한다.
//
// 방식: 회사별 __manifest__.json(경로→mtime·size)을 기준으로 푸시/풀, 파일 단위 LWW.
// 삭제 전파는 로컬 .sync-state.json(마지막 동기화 시점의 매니페스트)과의 대조로 판별 —
// "내가 지운 것"과 "아직 안 받은 것"을 구분한다.
//
// 시크릿(connections.json·.secrets.json): 서비스 키가 있으면 봉투 암호화(secretbox)로 동기화 —
// 스토리지엔 암호문만 놓이고, 기기마다 재입력할 필요가 없다. 키 없는 환경은 기존대로 제외.
// 그 외 제외(동기화 금지): .gateway*·.gw-offset*(폴러 상태), *.status.json(턴 일시 상태),
// *.lock, .sync-state.json, .device-id, .index.sqlite*(기억 인덱스 캐시 — 정본에서 재구축).
//
// C-2 최소형: 오너별 _device-lease.json 클라우드 리스 — 두 기기가 동시에 켜져도
// 폴러·루틴 실행 주체는 한 기기만(게이트웨이·스케줄러가 isCloudLeader를 함께 본다).
//
// v1 한계(문서화): 서비스 키 기반(자가 호스팅 전제 — 패키징 앱은 사용자 JWT+RLS로 전환 예정),
// 충돌은 LWW(더 최근 mtime 승) — md 양쪽 보존은 후속.
import { mkdir, readFile, writeFile, readdir, stat, rm, utimes } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { collidesWithRoom } from './slug.mjs';
import { join, dirname, basename, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT, WS_ID_RE, paths, archiveCompany, writeTombstone, TOMBSTONE_DIR, getDeviceId } from './workspace.mjs';
import { applyDeparted, mergeDeparted, unscopedSummaryGone } from './departed.mjs';
import { writeJsonAtomic, writeFileAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock, withDirLock, withFileLock } from './mutex.mjs';
import { cryptoOn, isSecretRel, isSecretNameRel, isEncRel, encVaultOn, sealSecret, sealSecretV3, openSecret, openSecretCompat, isEnvelopeGeneration, CRED_WITHDRAWN, isCredWithdrawn } from './secretbox.mjs';
import { dek, tryClaimDek } from './e2ee.mjs';
import { loadSyncCreds, credsEpoch } from './synccreds.mjs';
import { loadDeviceSession, getFreshDeviceSession } from './devicesession.mjs';
import { accountKeyError, ensureAccountKey } from './accountkey.mjs';
import { ensureDeviceKeyRegistered } from './e2ee.mjs';
import { syncEntitled } from './entitlement.mjs';
import { cachedPlan, rememberPlan, invalidatePlanCache } from './plan-cache.mjs';
import { resolveRunner } from './runners.mjs'; // 리더 양보 판단 — 이 기기에서 턴을 돌릴 러너가 있는가
import { invalidatePath } from './memindex.mjs'; // 원격 mtime을 심는 수신 쓰기의 캐시 무효화
import { holdsDaemonLease, daemonLeasesSettled } from './lock.mjs'; // 실행 리스(게이트웨이·스케줄러) 주인만 클라우드 리스에 참여 — leaseTick
import { leaseRole, ROLE_RANK, docRank, roleMark } from './lease-role.mjs'; // 실행 담당 역할 순위(우선 > 일반 > 예비) — renewLease·standbyIdle
import { createPrefetch } from './sync-prefetch.mjs'; // 원격 파일 받기만 동시에 — 쓰기·판정은 루프 순서 그대로

const BUCKET = 'companies';
// 준실시간 — 기본 8s(웹↔앱 지연 단축). ARGO_SYNC_CYCLE_MS로 조정(비용/지연 트레이드오프).
const CYCLE_MS = Number(process.env.ARGO_SYNC_CYCLE_MS) || 8_000;
// 목록 조회(discoverRemote·원격 tombstone)는 **파일 동기화와 다른 주기**로 돈다.
//
// 왜: Storage list()는 서버에서 storage.search()로 실행되는데 이게 압도적으로 비싸다 — 프로덕션
// 실측(2026-07-26, Supabase CPU 80% 경보): 전체 DB CPU의 **98.3%**가 이 함수 하나였다(107만 회,
// 평균 177ms). 기기마다 8초 사이클에 목록을 2회(발견 + tombstone) 부르니 기기당 분당 15회이고,
// 켜져 있는 모든 기기가 각자 돈다 → 부하가 **동시 접속 기기 수에 선형**. 12대에서 이미 175회/분
// (코어 하나의 절반)이었고 사용자 73명 규모에선 DB가 먼저 포화된다.
//
// 두 조회 모두 8초일 이유가 없다: 발견은 **새 기기가 자기 회사를 처음 찾는** 용도고, tombstone은
// **보관 전파**라 분 단위 지연이 무해하다. 파일 push/pull만 CYCLE_MS로 두고 이 둘을 분리하면
// 목록 호출이 87% 줄면서 체감 지연은 그대로다. (첫 사이클은 항상 실행 — 신규 기기 복원 보장.)
//
// 2026-07-27 후속(DB 응답 불능 사후): 60초로도 부족했다 — storage.search **회당** 비용이 객체 수에
// 선형이라(실측: 객체 12,525→40,714개에서 177ms→5.27s/회) 빈도 절감이 상쇄됐다. 300초로 5배 더
// 줄인다. [규모 질문] 오너당 list 2회/300s × 기기 수 — 100명·기기 150대면 분당 60회 × 회당 수 초
// = 여전히 위험. **근본 해법은 list() 폐지(매니페스트 인덱스 1파일)**이며 이 상수는 지연 전술이다.
const DISCOVER_MS = Number(process.env.ARGO_SYNC_DISCOVER_MS) || 300_000;
// 소유자 접두사가 비면 list('') = 버킷 루트 나열이 되고, RLS가 23만 행을 하나씩 걸러 10~25초를 태운다(라이브 실측 2026-09-12: 느린
// storage.search의 접두사가 전부 ''). 자기 폴더 나열은 17ms. 빈 값·'undefined'·'null'·슬래시 포함만 거부한다(테스트의 가짜 오너는 통과).
const ownerPrefixOk = (o) => typeof o === 'string' && /^[^\s/]+$/.test(o) && o !== 'undefined' && o !== 'null';
const UPLOAD_BACKOFF_MS = 10 * 60_000; // 업로드가 전부 거절된 회사(플랜 미확인·무자격)는 이만큼 쉰다 — 8초마다 재시도하던 폭풍(30분 1만 건 RLS 거절) 차단
const uploadBackoff = new Map(); // wsId → until(ms)
const companyRetry = new Map(); // owner/ws → bounded failure cooldown; local nudge cannot bypass it
const companyIdle = new Map();
const IDLE_PROBE_MS = 60_000;
// 객체 없는 매니페스트 항목은 이만큼 다시 받으러 가지 않는다 — 활성 회사는 8초마다 전체 동기화라 매번 같은 404를 부른다.
// [규모] 빈 항목 1개당 기기·회사마다 시간당 GET 최대 1회(응답 88바이트). 이전에는 같은 GET이 실패로 세져 재시도(최대 10분)마다
// 매니페스트 GET 2회·PUT 1회(각 424KB, lean-ax-wqou 10/4 실측 하루 GET 214회 90.7MB·PUT 109회)를 끌고 왔다.
const MISSING_RECHECK_MS = 60 * 60_000;
const missingSeen = new Map(); // owner/ws/rel → { sig: 그때의 원격 메타, until }
const noticeLog = new Map(); // 같은 실패·빈 항목 경고는 목록이 바뀔 때만 로그에 남긴다(재시도마다 같은 줄 반복 방지)
// 받기 동시 실행(sync-prefetch.mjs) — 판정이 '원격 신규 → 받기'·'원격만 변경 → 받기'인 파일의 내려받기만 앞당긴다. 쓰기·판정·집계는 루프가 종전 순서 그대로.
// 실측(2026-10-10 VPS 첫 동기화): 한 번에 하나씩 받아 분당 약 65개(파일당 왕복 약 0.9초) — 3,734개 회사가 1시간 가까이 걸렸다.
// [규모] 요청 수·전송량은 그대로다(파일당 GET 1). 바뀌는 것은 받을 것이 많은 사이클의 순간 속도뿐 — 파일 받기 동시 최대 8(storage.objects 조회 8건),
// 기기 전체로는 따로 도는 리스 타이머 요청 1을 더해 최대 9. 유휴·평소 사이클(받을 파일 0~몇 개)은 종전과 같다. 쓰기(PUT·DB 행) 0 추가.
// 요청이 종전보다 느는 경우는 둘뿐이다: 사이클이 도중에 보류되면 앞서 받던 최대 16개를 멈추거나 버리고 다음 사이클이 다시 받는다 / 느린 회선에서 동시에 받다
// 시간 초과가 나면 그때 함께 받던 것(최대 8)을 하나씩 다시 받는다(종전이라면 실패 사이클이 매니페스트 재읽기·쓰기와 재시도 대기를 불렀다).
// 메모리: 앞서 받아 둔 내용 합 32MB(매니페스트 크기 기준) 상한, 그보다 큰 파일 하나는 혼자 받는다(종전과 같은 최대치). (export: 회귀 테스트용)
export const PULL_CONCURRENCY = 8;
export const PULL_AHEAD_MAX = 2 * PULL_CONCURRENCY;
const PULL_AHEAD_BYTES = 32 * 2 ** 20;
// 느린 회선(분리 검수 HIGH-1 재현: 3MB×8개·600KB/s에서 8개 모두 30초 시간 초과, 종전 하나씩은 42.9초에 다 받음) — 클라이언트 시간 초과(30초)는 본문을
// 받는 시간까지 포함하므로 여러 개가 회선을 나눠 쓰면 하나씩이면 받았을 파일이 실패한다. 그래서 동시에 받는 것은 작은 파일만, 받는 중인 크기 합 1MB까지로 두고
// 512KB보다 큰 파일은 혼자(종전과 같은 속도) 받는다. 그래도 시간 초과가 나면 그 사이클 남은 받기는 하나씩으로 바꾸고 회사별로 SLOW_LINK_MS 동안 기억한다.
const PULL_INFLIGHT_BYTES = 2 ** 20;
const PULL_SOLO_BYTES = 512 * 2 ** 10;
const SLOW_LINK_MS = 60 * 60_000;
const slowLinks = new Map(); // owner/ws → until(ms) — 이 회사는 하나씩 받는다
/** 요청 시간 초과인가 — 헤더 전 초과는 storage-js가 { error: StorageUnknownError('The operation was aborted due to timeout') }로, 본문 중 초과는 .blob()이
    던진 DOMException(TimeoutError)이 그대로 올라온다(storage-js 2.110.2 BlobDownloadBuilder). (export: 회귀 테스트용) */
export const isTimeoutError = (e) => e?.name === 'TimeoutError' || /aborted due to timeout|signal timed out/i.test(String(e?.message ?? ''));
const PULL_PROGRESS_MIN = 100; // 실제로 받으러 갈 파일이 이만큼 이상인 사이클(첫 동기화 등)만 진행을 로그로 남긴다
const PULL_PROGRESS_MS = 30_000; // 진행 로그 간격 — 받는 동안 로그가 비어 멈춘 것처럼 보이지 않게(10/10 VPS: 14분간 로그 0줄)
// 크기 제한 — Storage가 거절할 크기의 파일은 동기화에서 뺀다(diff 불가시, syncCompanyOnce의 oversize 주석).
// 운영 사고(2026-10-10 edge_logs): 한 기기가 162MB PDF 하나를 10분마다 올리려다 매번 400 — 24시간 129회·20.9GB. 업로드 실패가 파일 실패로 세져
// 회사 사이클이 재시도 대기(최대 10분)만 반복했다. companies 버킷은 file_size_limit가 없어(버킷 행 NULL) 프로젝트 전역 제한을 따른다 — 운영
// storage.objects(companies) 146,834개 중 가장 큰 객체 52,068,488바이트, 50MiB(52,428,800) 초과 0개(10/10 조회)라 50MiB로 둔다.
// 저장되는 것은 봉투를 씌운 크기(평문 + 42바이트, v2·v3 같음)라 평문 판정에 64바이트 여유를 둔다. 셀프호스트가 제한을 올렸으면 ARGO_SYNC_MAX_FILE_BYTES로 맞춘다.
// (export: 회귀 테스트용)
export const SYNC_MAX_OBJECT_BYTES = Number(process.env.ARGO_SYNC_MAX_FILE_BYTES) || 50 * 2 ** 20;
export const tooBigToSync = (size) => Number(size) + 64 > SYNC_MAX_OBJECT_BYTES;
/* 로컬 걷기 해시 캐시 — 8초마다(유휴 확인 전에도) 회사 폴더 전체를 읽고 해시하던 비용(lean-ax-wqou 3,928개·110.7MB에 0.6~1.2초, 10/10 측정)을
   바뀐 파일만으로 줄인다. 파일마다 (크기, mtime, ctime, inode, 장치)가 해시할 때와 같으면 그 해시를 다시 쓴다(git 색인과 같은 방식). 기기 메모리만 쓴다(파일·DB 쓰기 0).
   · 해상도가 낮은 파일 시스템(FAT 2초·HFS+ 1초·리눅스 굵은 시각)에서 같은 시각 칸 안의 두 번째 쓰기는 시각이 같다 — 걷기를 시작한 시각보다 WALK_RACY_MS 넘게
     이전에 바뀐 파일만 캐시한다(git의 'racy' 규칙). 그 뒤의 쓰기는 반드시 다른 시각을 받는다. 미래 시각 파일도 같은 규칙으로 캐시하지 않는다.
   · 동기화 자신이 원격 mtime을 심는다(writeLocal의 utimes — 아래 invalidatePath 주석 '심은 mtime과 크기가 이전 행과 우연히 일치하면 캐시가 변경을 못 본다'와
     같은 함정). 키에 ctime·inode를 넣어 막는다 — ctime은 utimes로 되돌릴 수 없고, 원자 쓰기(tmp→rename)는 새 inode다.
   · 시계가 되돌아가면(지난 걷기보다 지금이 이르면) 캐시를 통째로 버린다. 놓친 변경의 상한: 항목은 WALK_REHASH_MS가 지나면 다시 읽는다.
   · 캐시에서 온 해시로는 로컬을 덮거나 지우지 않는다 — 그 쓰기 직전에 실제 내용을 다시 읽어 확인하고 다르면 미룬다(syncCompanyOnce의 guarded). */
const WALK_RACY_MS = 3_000;
const WALK_REHASH_MS = 10 * 60_000;
const walkCache = { roots: new Map(), lastNow: 0 }; // root → Map<rel, { key, h, at }>
const walkFromCache = new WeakMap(); // walk 결과 객체 → 캐시에서 해시를 가져온 rel 집합
/** 테스트 전용 — 걷기 캐시를 비우거나 한 항목의 해시를 바꿔 '낡은 캐시'를 흉내 낸다(캐시 해시로 덮지 않는지 시험). */
export function _walkCacheForTest() { return walkCache; }
// 크로스 프로세스 락 스테일 판정 — CYCLE_MS와 분리한다. 주기 단축(45→8s)이 이중 동기화 방어막을
// 좁히면(느린 사이클의 살아있는 리더를 오탈취) 삭제 피드백 루프=대형 유실이 날 수 있다(리뷰 H1).
// 죽은 프로세스 락은 이 시간 내 회수하되, 살아있는 리더는 오탈취 안 되게 넉넉히.
const LOCK_STALE_MS = Math.max(CYCLE_MS * 3, 120_000);
export const LEASE_TTL_MS = 120_000; // 이 시간 동안 갱신 없으면 다른 기기가 리더를 가져간다 (export: 회귀 테스트용)

// 동기화 스위치 — 서비스 자격(env/페어링 파일) 또는 기기 세션(로그인=연동). 서비스 자격이 우선하되,
// 호스티드 클라이언트에선 serviceCredsAllowed()가 서비스 모드를 금지해 세션이 쓰인다(ensureClient 참조).
export const syncOn = () => (!!loadSyncCreds() || !!loadDeviceSession()) && process.env.ARGO_SYNC !== '0';

/** 회의록 파일과 충돌하는 크루 카드(agents/<slug>.md, 세척 후 slug === 'room-main' — slug.mjs) — 옛 버전 기기가 만든
    'Room Main' 크루는 이 기기에서 회의록 chats/room-main.json·회의 턴 마커를 덮는 파일 이름이 된다. 반입 문의 거절은
    **diff 불가시**(자격 회수 noSecrets와 같은 계약: push·pull·삭제 전파·브레이크 집계 전부 스킵)다. EXCLUDE로 하면 안 된다 —
    EXCLUDE는 로컬 walk에만 걸려 원격 전용 항목을 한 번 받아온 뒤(base 없음=신규) 다음 사이클에 '로컬 삭제'로 읽어 원격을
    지우고, 그 기기의 카드까지 지운다(.gw-queue 잔재 청소 경로 — 회사 데이터엔 파괴적). 범위는 실제 충돌 이름만이다 —
    영입 문의 접두(room-*) 예약을 여기 쓰면 이미 있는 정상 'room-service' 크루의 동기화가 조용히 끊긴다(분리 검수 MEDIUM-1).
    .archive/(해고본)는 살아 있는 slug가 아니라 대상 아님. */
export const isRoomCardRel = (rel) => /^agents\/[^/]+\.md$/.test(rel) && collidesWithRoom(rel.slice('agents/'.length, -'.md'.length));
const isLocalImportRel = (rel) => rel.split('/')[0] === '.local-assets';
/** 능동 비서 상태(.assistant/ — src/assistant/state.mjs): 보낸 키·보류 목록·대기열·확인 범위. 확인할 때마다 바뀌는 기기 로컬 값이라 올리지 않고(EXCLUDE —
    storage.objects 업서트가 쌓이는 2026-09-23 리스·심박 711MB와 같은 모양), 원격에 있어도 **diff 불가시**(받기·삭제 전파·브레이크 집계 전부 건너뜀)로 다룬다.
    버전 섞임(#863 분리 검수 LOW): 옛 버전으로 내린 기기는 EXCLUDE에 이 줄이 없어 상태 파일을 올린다. EXCLUDE는 로컬 walk에만 걸려, 새 기기가 그 사본을 받아
    자기 상태를 덮고 다음 사이클에 '로컬 삭제'로 원격을 지우게 된다(.local-assets와 같은 계약). 기기 사이 이어받기는 알림 글 meta로 한다(설계 7절, 3단계). */
const isAssistantStateRel = (rel) => rel.split('/')[0] === '.assistant';
/** 작업 과정 기록(.turn-traces/ — src/turn-trace.mjs): 끝난 턴의 생각·도구 입력·결과. 이 기기에만 둔다(유건 확정 2026-10-09 — 다른 기기에서는 답만 보인다).
    .assistant와 같은 계약 — 올리지 않고(EXCLUDE), 원격에 옛 사본이 있어도 diff 불가시(받기·삭제 전파·브레이크 집계 전부 건너뜀). */
export const isTurnTraceRel = (rel) => rel.split('/')[0] === '.turn-traces';

/** 개발 산출물 디렉터리(node_modules·.git·가상환경·크롬 프로필 등) — 라이브 실측(2026-09-14): companies 버킷
    25GB 중 이런 디렉터리가 약 7GB를 차지하고 매 사이클(8s) walk가 전부 읽고 해시했다. isRoomCardRel과 같은
    계약으로 **diff 불가시**(push·pull·삭제 전파·브레이크 집계 전부 스킵)로만 다룬다 — EXCLUDE(walk 전용)로
    하면 원격에만 있는 항목을 한 번 받아온 뒤(base 없음=신규) 다음 사이클에 '로컬 삭제'로 읽어 원격을 지우는
    파괴적 경로가 생긴다. walk에서는 별도로 이 디렉터리로 **내려가지 않게** 해 CPU·IO를 줄인다 — 원격 전용
    항목의 pull·삭제 전파는 diff 쪽 isDevArtifactRel 가드가 막으므로 walk 스킵이 안전하다(가드가 이미 있는
    상태에서의 순수 성능 최적화). build·dist는 사용자 폴더 이름과 겹칠 수 있어 후보로만 남기고 넣지 않는다. */
const DEV_ARTIFACT_SEGS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo',
  '.cache', '.parcel-cache', '.pytest_cache', '.mypy_cache', '.playwright-mcp', 'DerivedData',
]);
export const isDevArtifactSeg = (name) => DEV_ARTIFACT_SEGS.has(name) || name.startsWith('chrome_profile');
export const isDevArtifactRel = (rel) => {
  const parts = rel.split('/');
  if (parts.some(isDevArtifactSeg)) return true;
  // Chromium disk-cache signatures, not arbitrary documents named Default/Cache.
  // Profile directory names may be user-chosen/Unicode; the cache layout is stable.
  return /(?:^|\/)(?:Cache\/Cache_Data|GPUCache|ShaderCache|GrShaderCache)\/(?:data_\d+|index|f_[0-9a-f]+)$/.test(rel)
    || /(?:^|\/)Dictionaries\/(?:en-US-10-1|ko-3-0)\.bdic$/.test(rel);
};

export const EXCLUDE = (rel) => { // (export: 회귀 테스트용)
  if (isLocalImportRel(rel)) return true;
  // ⚠ 순서 불변식(2026-07-23 검수 CRITICAL): **구조적 제외를 반드시 먼저** 평가한다.
  // 암호화 대상 판정을 앞에 두면 ARGO_ENC_VAULT=1일 때 isEncRel이 모든 rel에 true라 조기 반환하면서
  // 아래 규칙 전부가 우회된다 → .sync-state.json(다른 기기 base가 로컬 base를 덮어써 삭제 오판)·
  // .gw-queue-*(같은 지시 이중 실행)·.tmp-*·.corrupt-*까지 동기화 대상이 되어 데이터 유실급이다.
  // 디스크 큐(.gw-queue-*/) — 잡을 적재한 기기만의 로컬 처리 상태. 디렉터리 '안의 파일'까지 제외해야
  // 한다(basename만 보면 통과) — 큐가 동기화를 타면 두 기기가 같은 지시를 이중 실행한다.
  if (rel.split('/')[0].startsWith('.gw-queue')) return true;
  // 크루 우편함(mail/) — 발신 기기 자신의 로컬 배달 큐(.claimed·attempts = 처리 상태). 각 기기의
  // 스케줄러가 자기 큐를 배달하며(클라우드 리더 게이트 미적용 — scheduler.mjs 2026-07-28), 동기화를
  // 타면 지운 파일이 원격에서 되살아나 같은 쪽지를 이중 배달한다(.gw-queue와 동일 결함 계급,
  // 분리 검수 CRITICAL-2 2026-07-27). 세션 간 소통은 배달 결과가 스레드(동기화 대상)로 남아 성립한다.
  if (rel.split('/')[0] === 'mail') return true;
  // 세션 메시지 대기 기록(sessmsg/ — session-msg.mjs) — 이 기기 프로세스가 답을 기다리는 상태. 다른 기기로 가면 그 기기의 부팅 정리가
  // 남의 살아 있는 기다림을 "재시작으로 끊김"으로 지운다. 주고받은 글은 스레드(동기화 대상)에 남는다.
  if (rel.split('/')[0] === 'sessmsg') return true;
  // 조직 문서 미러(vault/org/) — 팀 메신저 서버가 정본이고 브리지가 기기마다 내려받는 파생물(G-2). 동기화를 타면
  // 두 기기의 미러가 서로를 덮고, 오프보딩 회수(미러 삭제)가 원격에서 되살아난다.
  if (rel.startsWith('vault/org/')) return true;
  // 네이티브 엔진 전사(.sessions/native/<slug>.json) — 기기 로컬 모델 문맥(도구 출력·대화 원문). 디렉터리 단위 제외(basename만 보면
  // 통과 — 분리 검수 MEDIUM-2 실측: isSecretRel 밖이라 기기 DEK 없으면 평문 업로드 + 도구 단계마다 저장돼 업로드 증폭).
  if (rel.split('/')[0] === '.sessions') return true;
  // 팀 메신저 채널 기억의 PC 사본(.msgr-journal/ — memory.mjs relocateOrgJournals). 채널·조직 기억은 서버에만(유건 결정 2026-09-24) —
  // 개인 클라우드·다른 기기로 퍼지면 퇴장 회수가 원격에서 되살아난다(검수 #691 M2).
  if (rel.split('/')[0] === '.msgr-journal') return true;
  // 능동 비서 상태(.assistant/ — isAssistantStateRel 주석). 설정(assistant.json)은 동기화 대상이다.
  if (isAssistantStateRel(rel)) return true;
  // 작업 과정 기록(.turn-traces/ — isTurnTraceRel 주석) — 기기 로컬, 턴마다 쌓인다.
  if (isTurnTraceRel(rel)) return true;
  const base = rel.split('/').pop();
  if (
    base.startsWith('.gateway') || base.startsWith('.gw-offset') ||
    base.startsWith('.gw-queue') ||
    base === '.sync-state.json' || base === '.device-id' || base === '.sync-credentials.json' || base === '.server-presence.json' ||
    base === '.device-session.json' || base === '.DS_Store' ||
    base === '.workroots.json' || // 외부 작업 폴더 — 기기 고유 경로라 타 기기로 넘기면 무의미하거나 의도 안 한 접근 허용이 된다
    base === '.connector-secrets.json' || // 커넥터 OAuth 토큰 — 기기·회사 스코프(다른 기기는 재연결, workroots와 같은 원칙 — mcp-oauth-design §2-1)
    base === '.runner-health.json' || // 러너 검진 결과 — **그 기기의 자격에 대한 사실**이다(호스티드는 자격 미동기 — hostedCredsOff). 동기화하면 A의 실패가 B 카드에 그려지고, 리더가 바뀔 때마다 서로의 항목을 지워 재검진(과금)을 부른다(검수 MEDIUM-3)
    base.startsWith('.index.sqlite') || // 기억 인덱스 캐시(+ -wal·-shm). 기기별 산출물이고 정본에서 재구축된다
    base.endsWith('.status.json') || base.endsWith('.lock') ||
    base.startsWith('.tmp-') || base.endsWith('.corrupt') || rel.includes('.corrupt-') // 원자쓰기 임시·손상 백업
  ) return true;
  // 암호화 대상인데 키 미확보 — 이번 사이클 불가시(삭제 오인 차단). 키가 있으면 암호문으로 동기화한다.
  return isEncRel(rel) && !cryptoOn();
};

const CLIENT_OPTS = {
  auth: { persistSession: false },
  // 타임아웃 필수 — 기본 fetch는 무한 대기라 요청 하나가 걸리면 동기화 전체가 영원히 멈춘다(실측)
  // 호출부가 멈추기 신호를 넘기면(받기 미리 하기의 stop) 시간 초과와 함께 건다 — 넘기지 않는 요청은 종전과 같다.
  global: { fetch: (url, opts) => fetch(url, { ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) },
};
let sb = null, sbKey = '';

/** 호스티드 모드인가(= 세션 동기화, 목적지가 Argo 운영 클라우드) — 이 모드에서 자격 증명 3종은
    **절대** 클라우드로 가지 않는다(유건 지시 2026-08-29: "열쇠를 볼 수 있는 건 사용자 본인뿐" —
    선택권이 아니라 구조). 강제는 호출부가 아니라 syncCompany 내부에 건다 — 새 호출 경로가 생겨도
    구조적으로 우회 불가(보관 전파 경로가 opts 배선을 빠뜨렸던 분리 검수 HIGH-1 계열의 원천 차단).
    서비스 모드(셀프호스트·워커 = 사용자 자신의 인프라·자신의 열쇠)는 운영자가 곧 사용자라 원칙이
    이미 성립하므로 회사별 credSync 토글이 그대로 선택권으로 남는다. (export: 회귀 테스트용) */
export const hostedCredsOff = () => !(loadSyncCreds() && serviceCredsAllowed());

/** 서비스롤(RLS 우회) 동기화가 정당한 컨텍스트인가 — 서비스롤 클라이언트 제거 완주(2026-07-23).
    허용: 자가호스트(공개키 미빌드 = AUTH off, 사용자가 곧 테넌트) 또는 워커(ARGO_TENANT_OWNER 바인딩, 오너 전용 인스턴스).
    금지: 호스티드 클라이언트(공개키 빌드 = AUTH_ON, 워커 아님) — 오설정으로 크라운주얼이 런타임에 새어들어도
    절대 service-mode로 RLS를 우회하지 않고 세션(JWT+RLS)만 쓴다. 정상 경로(서비스롤 부재)엔 무영향. (export: 회귀 테스트용) */
export function serviceCredsAllowed(env = process.env) {
  const authOn = !!(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const isWorker = !!env.ARGO_TENANT_OWNER?.trim();
  return !authOn || isWorker;
}

// cycle 시작마다 호출 — 서비스 모드는 epoch, 세션 모드는 access token으로 캐시 키를 삼아
// 자격 회전 시에만 클라이언트를 재생성한다. false = 쓸 자격 없음(이번 사이클 스킵).
const clientFail = (globalThis.__argoSyncClientFail ??= { at: 0 });
async function ensureClient() {
  // 방금(주기 절반 안) 실패했으면 다시 시도하지 않는다 — 동기화 루프와 리스 타이머가 함께 불러도 세션 갱신 시도가 종전(주기마다 1번)보다 늘지 않게.
  if (clientFail.at && Date.now() - clientFail.at < CYCLE_MS / 2) return false;
  const ok = await ensureClientOnce();
  clientFail.at = ok ? 0 : Date.now();
  return ok;
}
async function ensureClientOnce() {
  const svc = loadSyncCreds();
  if (svc && serviceCredsAllowed()) {
    const k = `svc:${credsEpoch()}`;
    if (sbKey !== k) { sb = createClient(svc.url, svc.key, CLIENT_OPTS); sbKey = k; resetDiscoverClock(); }
    return true;
  }
  const sess = await getFreshDeviceSession();
  if (!sess) return false;
  const k = `sess:${sess.access_token.slice(-24)}`;
  if (sbKey !== k) {
    sb = createClient(sess.url, sess.anonKey, {
      ...CLIENT_OPTS,
      global: { ...CLIENT_OPTS.global, headers: { Authorization: `Bearer ${sess.access_token}` } },
    });
    sbKey = k;
    resetDiscoverClock();
  }
  return true;
}

/** 자격(세션·서비스키)이 바뀌면 목록 조회 시각을 지워 다음 사이클이 즉시 발견하게 한다.
    루프는 로그아웃을 넘어 살아 있고(ensureSync의 __argoSync 가드) 시각도 그대로라, 재로그인·계정
    전환 직후 최대 DISCOVER_MS 동안 새 계정이 자기 회사를 못 보던 구멍(검수 HIGH). 로그아웃 라우트가
    아니라 여기서 막는 이유: 세션 교체와 서비스키 회전을 한 지점에서 함께 덮는다. */
function resetDiscoverClock() { globalThis.__argoLastDiscover = 0; }
const client = () => sb; // ensureClient() 성공 뒤에만 호출된다 (cycle/ensureSync 게이트)
// 테스트 전용 — fake storage를 주입해 syncCompany를 실 Supabase 없이 실행 검증한다.
// 프로덕션 경로는 절대 호출하지 않는다(ensureClient가 실 클라이언트를 세팅). (export: 통합 테스트용)
export function _setSyncClientForTest(fake) { sb = fake; sbKey = '__test__'; companyRetry.clear(); companyIdle.clear(); missingSeen.clear(); noticeLog.clear(); slowLinks.clear(); }

// Supabase Storage는 인증 다운로드도 CDN(Cloudflare)에 캐시하고, 같은 키를 덮어쓴 직후에도 한동안 옛 사본(cf HIT)을 준다.
// 라이브 실측(2026-09-26 03:05Z): 매니페스트를 올리고 10초 뒤 GET이 HIT로 이전 판을 받아 방금 지운 항목을 되살렸고(그 회사는 그 뒤
// 매 주기 객체 없는 항목 4건에서 실패), 직전에 올린 파일을 '원격 변경'으로 읽어 자기 자신과 충돌 사본을 만들었다. 동기화가 읽는 객체는
// 전부 같은 키를 덮어쓰는 가변 객체라 요청마다 다른 cacheNonce로 원본을 읽는다 — 요청 수·바이트는 그대로고 캐시 전송량이 비캐시로 옮겨 간다.
// [규모] 10/4 하루 전 계정의 매니페스트 GET 30,553건 중 29,628건(573.6MB)이 CDN 사본이었다 → 갱신된 기기가 늘수록 이만큼이
// 원본 요청(초당 약 0.34건 추가)이 된다. 기기 수 × 회사 수 × 전체 동기화 횟수에 선형이며, 유휴 확인(60초 info)이 이 횟수를 묶는다.
const fresh = () => ({ cacheNonce: randomUUID() });
/** 원격에 없음 — 매니페스트 읽기·blob 실존 검사·파일 받기(객체 없는 항목 판정)가 같은 판정을 쓴다. 진짜 없음은 storage-api의 'Object not found' 하나뿐이다
    (이 레포 download 경로 기준. storage-js 2.110.2는 statusCode를 문자열 '404'로 주므로 숫자 비교는 쓰지 않는다).
    그 밖의 404 모양은 모두 확인 불가(보류)다 — 'Bucket not found'(만료 토큰을 Storage가 익명으로 처리, 2026-10-05 운영 storage_logs:
    role anon, NoSuchBucket), 'Not Found'(JSON 없는 404의 statusText), 'no Route matched'(게이트웨이 404), 'The resource was not found',
    ENOENT 'no such file'. 없음으로 잘못 읽으면 매니페스트가 빈 원격이 되고 blob 검사가 로컬 파일을 지운다(분리 검수 LOW-1). */
const isNotFound = (error) => /\bobject not found\b/i.test(String(error?.message || error));
/** 파일 실패 한 줄 — lastError(설정 카드)에 회사와 첫 파일 이름·사유를 싣는다. lastError는 기기 전체에 하나라 다른 회사 카드에도 보이므로
    회사 ID를 앞에 붙인다(다른 per-회사 lastError와 같은 형식). (export: 회귀 테스트용) */
export const syncFailedMessage = (wsId, r) => {
  const f = r.failures?.[0];
  return `${wsId}: 동기화 파일 ${r.failed}건 실패${f ? ` (${f.rel}: ${f.reason}${r.failed > 1 ? ` 외 ${r.failed - 1}건` : ''})` : ''} — 잠시 후 재시도`;
};
const noteOnce = (k, line) => {
  if (!line) { noticeLog.delete(k); return; }
  if (noticeLog.get(k) !== line) { noticeLog.set(k, line); console.warn(line); }
};

// 스토리지 키 — 한글·특수문자 세그먼트는 base64url로(스토리지가 %·비ASCII 키를 거부, 실측).
// 매니페스트에 논리 경로를 담고 키는 항상 이 함수로 파생하므로 역디코딩은 불필요하다.
// (export: 회귀 테스트용 — cloudexport.mjs의 역디코딩(decSeg)과 왕복 계약을 테스트가 잠근다)
export const encSeg = (s) => (/^[A-Za-z0-9._-]+$/.test(s) ? s : `u8-${Buffer.from(s).toString('base64url')}`);
const skey = (...segs) => segs.flatMap((s) => s.split('/')).map(encSeg).join('/');

/* ─── 기기 식별 — 정의는 workspace.mjs(getDeviceId). 세션 소유 판정(thread/chat)과 공유한다. ─── */

/* ─── 크로스 프로세스 단일 동기화 락 ───
   같은 데이터 루트에 두 서버가 뜨면(실수로 dev + 상주 동시 기동 등) 서로의 로컬·원격·.sync-state를
   두고 레이스하며 삭제 피드백 루프를 만든다(실측 대형 유실). 한 root당 한 프로세스만 동기화하도록
   pidfile로 막는다. .lock은 EXCLUDE라 동기화 대상 아님. */
async function holdSyncLock() {
  const f = join(WS_ROOT, '.sync-process.lock');
  try {
    const cur = JSON.parse(await readFile(f, 'utf8'));
    if (cur.pid !== process.pid && Date.now() - cur.ts < LOCK_STALE_MS) {
      try { process.kill(cur.pid, 0); return false; } catch { /* 죽은 pid → 탈취 */ }
    }
  } catch { /* 없음/손상 → 획득 */ }
  try { await mkdir(WS_ROOT, { recursive: true }); await writeFile(f, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* 쓰기 실패 시에도 진행 */ }
  return true;
}

/* ─── 클라우드 리스 (C-2 최소형) — 실행(폴러·루틴) 주체는 한 기기만 ───
   상태는 globalThis에 — Next가 라우트/instrumentation을 별도 번들로 복제해도 하나를 본다.
   리스 읽기·갱신은 파일 동기화 주기와 따로 자기 타이머(CYCLE_MS마다)로 돈다(startLeaseLoop) — 동기화 주기가 길거나(큰 파일 올리기·첫 동기화)
   요청이 걸려도 리스 판정은 제때 돈다. 주기 안에 있을 때는 앞 담당이 긴 주기 동안 넘겨받기 글을 못 읽어 80초 겹쳤고, 혼자 쓰는 기기는 긴 첫
   동기화 중 담당이 꺼졌다(D 3차 검수). 요청 수는 같다: 기기마다 CYCLE_MS에 읽기 1번(대화 전송 nudge로 주기가 빨라져도 늘지 않는다). */
// leader 기본 true = "동기화 off인 단일 기기" 전제. ownedAt = 리스를 **확인된 CAS로 획득한** 시각(0=미획득).
// 이 둘을 반드시 구분한다(검수 2026-07-23): 기본값 true는 '획득한 리더십'이 아니므로, 판정 불가 상황에서
// 기본값을 리더로 존중하면 리스를 얻은 적 없는 프로세스가 리더로 굳어 루틴 이중 실행·이중 과금·텔레그램 409가 난다.
// pending = 남의 새 리스를 가져오며 쓴 내 글({ token, ts }) — 앞 담당이 물러날 시간(HANDOVER_WAIT_MS) 동안 담당을 시작하지 않는다(renewLease '넘겨받기').
// token = 지금 내 것으로 아는 리스 글의 토큰. validUntil = 확인된 담당 기한(엄격 판정 — isCloudLeader): 내 토큰이 그대로인 살아 있는 글을 본 읽기를
//   **보낸** 시각 + LEASE_CONFIRM_VALID_MS(응답이 늦어도 늘지 않는다), 그 글의 만료(ts + TTL)보다 늦지 않게.
// peers = 계정마다 다른 기기의 리스 글을 마지막으로 본 시각·본 적 있는 일반 기기(.lease-peer.json — 기기 로컬, 동기화 대상 아님. 아래 '다른 기기를 본 적 있음 표지').
const leaseState = (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0, pending: null, token: null, validUntil: 0 });
/** 넘겨받기 대기 — 남의 새 리스를 가져오며 내 글을 쓴 뒤 담당을 시작하기까지의 최소 시간. 앞 담당은 이 시간보다 LEASE_CONFIRM_MARGIN_MS 짧은 확인 기한
    (LEASE_CONFIRM_VALID_MS) 안에 자기 글을 다시 확인하지 못하면 스스로 담당을 놓는다(엄격 판정). 그래서 앞 담당의 응답이 늦거나(30초 시간 초과)
    읽기가 계속 실패하거나 동기화 주기가 길어도, 넘겨받는 쪽이 대기를 마칠 때는 앞 담당이 이미 물러나 있다(D 3차 검수: 겹침 21초·39초·80초 → 0).
    두 주기 + 6초: 앞 담당이 확인 기한(두 주기 + 2초) 안에 리스를 두 번 읽는다 — 한 번 읽기 오류여도 담당을 놓지 않는다.
    '내 다음 주기'로 세면 안 된다: 대화 전송(nudge)으로 주기가 연달아 돌면 대기가 사라졌다(D 1차 검수). (export: 회귀 테스트용) */
export const HANDOVER_WAIT_MS = 2 * CYCLE_MS + 6_000;
/** 확인 기한의 여유 — 넘겨받는 쪽은 자기 쓰기의 **응답을 받은 시각**부터 대기를 센다(D 4차 검수 LOW-C — 글의 ts(쓰기 전 시각)부터 세면 쓰기가 늦게 닿은
    만큼 대기가 줄어 겹쳤다: 14초 늦게 닿자 6.6~6.9초). 앞 담당의 마지막 확인 읽기는 그 쓰기보다 먼저 처리됐으므로 그 읽기를 보낸 시각 < 응답 받은 시각이고,
    둘 다 자기 시계로 경과 시간만 재므로 업로드 지연·두 기기 시계 차이와 무관하다. 이 여유는 타이머 흔들림과 그 사이 벽시계가 뛰는 경우(시계 점프)를 덮는다. */
const LEASE_CONFIRM_MARGIN_MS = 4_000;
/** 확인된 담당 기한 — 엄격 판정에서 보유자는 마지막 확인 읽기를 보낸 뒤 이 시간까지만 담당이다(운영 18초 — 8초마다 읽으니 한 번 실패는 흡수). (export: 회귀 테스트용) */
export const LEASE_CONFIRM_VALID_MS = HANDOVER_WAIT_MS - LEASE_CONFIRM_MARGIN_MS;
/** 예비 기기는 일반·우선 기기를 두 대 이상 본 적 있으면 남의 리스가 만료된 뒤 두 주기를 더 기다렸다 가져온다 — 맥이 둘이면 남은 맥(일반)이 먼저 가져가게
    (D 3차 검수 LOW: 예비가 먼저 가져가 맥이 다시 되찾느라 공백·쓰기 1번). 맥 한 대뿐이면 기다리지 않는다(D 4차 검수 LOW-D: 흔한 맥 → VPS 넘어가기가 16초 늦었다). */
const STANDBY_EXPIRED_WAIT_MS = 2 * CYCLE_MS;

/** 되찾기 전 깨어 있은 시간 — 더 높은 역할의 기기(맥)는 이 프로세스가 끊김 없이 이만큼 깨어 있은 뒤에만 남의 새 리스를 가져온다(만료된 리스는 바로 가져온다).
    맥은 뚜껑을 닫아도 1~17초씩 깨어난다(DarkWake — 이 맥 10/7 오후 17번, 대개 15~17분 간격). 깬 첫 주기에 VPS의 리스를 가져가고 담당을 시작하기 전에 다시 잠들면,
    VPS는 맥의 글을 읽고 물러난 뒤 그 글이 만료되는 120초 동안 다시 맡지 못해 아무도 맡지 않았다(D 2차 검수 실측: 6초·14초 깸 → 공백 약 121초).
    그동안 VPS가 계속 맡으므로 공백이 없다. 대가는 실제로 깼을 때(또는 앱을 켰을 때) 맥이 이만큼 늦게 되찾는 것뿐이다. (export: 회귀 테스트용) */
export const AWAKE_MIN_MS = 30_000;
const AWAKE_TICK_MS = 2_000; // 깨어 있음 관찰 간격 — 동기화 주기(길면 수십 초)와 따로 둔다: 주기 간격으로 재면 긴 주기를 잠자기로 오인해 되찾기를 영영 미룬다
const PAUSE_GAP_MS = 10_000; // 관찰 사이 벽시계가 이만큼 넘게 흘렀으면 멈춰 있었다(잠자기·SIGSTOP·VM 일시 정지 — 타이머가 돌지 못했다)
const SLEEP_DRIFT_MS = 5_000; // 벽시계가 단조 시계보다 이만큼 더 갔으면 시스템이 잠들었다(맥 mach_absolute_time·리눅스 CLOCK_MONOTONIC은 잠자는 동안 멈춘다)
/** 깨어 있음 상태 — since = 끊김 없이 깨어 있기 시작한 시각(프로세스 기동 또는 마지막으로 알아챈 깸), wokeAt = 마지막으로 알아챈 깸(기동은 넣지 않는다).
    globalThis: Next 번들 사본이 하나를 보게(위 리스 상태와 같은 이유). */
const awake = (globalThis.__argoSyncAwake ??= { since: Date.now() });
function observeAwake(now = Date.now()) {
  const mono = performance.now();
  if (awake.wall != null && awake.mono != null) {
    const wallGap = now - awake.wall;
    if (wallGap > PAUSE_GAP_MS || wallGap - (mono - awake.mono) > SLEEP_DRIFT_MS) { awake.since = now; awake.wokeAt = now; }
  }
  awake.wall = now; awake.mono = mono;
  if (!awake.timer) { awake.timer = setInterval(() => observeAwake(), AWAKE_TICK_MS); awake.timer.unref?.(); } // 리스를 판정하는 프로세스에서만(처음 부를 때) 켠다
}

/** 다른 기기를 본 적 있음 표지 — 계정마다 { at: 마지막으로 다른 기기의 리스 글을 본 시각, normals: 본 적 있는 일반·우선 기기 id }. 최근 14일 안에 다른 기기를 본
    계정이면 엄격 판정을 쓴다(아래 isCloudLeader). 파일로 남기는 이유: 세션이 끊긴 채 기동한 맥은 리스를 못 읽어 다른 기기가 있는지 모른다 — 기동 기본값으로 VPS와
    겹쳤다(D 3차 검수 MEDIUM-3). 14일: 두 번째 기기를 없앤 뒤에도 표지가 영원히 남아 세션이 끊기면 아무도 실행하지 않던 것(D 4차 검수 MEDIUM-B). 계정별: 다른
    계정으로 로그인하면 그 계정은 본 적 없는 단일 기기다. 기기 로컬 파일이고(동기화 대상 아님, 크루 셸 방어 WS_DOT_FILES) 다른 기기를 볼 때마다 쓰지 않는다 —
    하루에 한 번 또는 처음 보는 일반 기기가 생길 때만. */
const PEER_FILE = () => join(WS_ROOT, '.lease-peer.json');
const PEER_FRESH_MS = 14 * 86_400_000;
const PEER_SAVE_MS = 86_400_000;
const PEER_NORMALS_MAX = 8;
if (!leaseState.peers) {
  try {
    const raw = JSON.parse(readFileSync(PEER_FILE(), 'utf8'));
    leaseState.peers = raw?.v === 2 && raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
  } catch { leaseState.peers = {}; }
  leaseState.peersSavedAt = Object.fromEntries(Object.entries(leaseState.peers).map(([k, v]) => [k, Number(v?.at) || 0]));
}
/** 이 기기가 지금 쓰는 계정 — 기기 세션의 사용자(호스티드) 또는 서비스 자격의 오너(셀프호스트). 둘 다 파일 도장 캐시라 싸다. */
const leaseAccount = () => String(loadDeviceSession()?.user?.id ?? loadSyncCreds()?.owner ?? '');
/** 이 계정이 최근 14일 안에 다른 기기의 리스 글을 봤는가 — 봤으면 그 표지(없으면 null). */
function peerSeen(now = Date.now()) {
  const e = leaseState.peers?.[leaseAccount()];
  return e && now - (Number(e.at) || 0) < PEER_FRESH_MS ? e : null;
}
function notePeer(doc, now = Date.now()) {
  const acct = leaseAccount();
  const e = (leaseState.peers[acct] ??= { at: 0, normals: [] });
  if (!Array.isArray(e.normals)) e.normals = [];
  e.at = now;
  let fresh = false;
  if (docRank(doc) >= ROLE_RANK.normal && !e.normals.includes(String(doc.deviceId))) { e.normals = [...e.normals, String(doc.deviceId)].slice(-PEER_NORMALS_MAX); fresh = true; }
  if (fresh || now - ((leaseState.peersSavedAt ??= {})[acct] || 0) >= PEER_SAVE_MS) {
    leaseState.peersSavedAt[acct] = now;
    writeJsonAtomic(PEER_FILE(), { v: 2, accounts: leaseState.peers }).catch(() => {});
  }
}
/** 엄격 판정을 쓰는가 — 예비 기기(늘 다른 기기와 함께 쓴다)이거나 이 계정이 최근 14일 안에 다른 기기를 본 기기. */
const strictLease = () => leaseRole() === 'standby' || !!peerSeen();
/** 단일 기기의 기동 대기 — 첫 리스 판정이 끝날 때까지(성공이든 실패든, 보통 1초 안) 담당이 아니다. 그 판정이 다른 기기의 리스를 보면 엄격 판정으로 넘어가
    맥 앱이 켜지는 순간 VPS와 겹치지 않는다(D 1차 검수). 세션 실패면 배포본처럼 담당이고, 읽기 오류면 담당이 아니다(leaseUnreadable — 1초 뒤 한 번 더 읽는다).
    판정이 걸려도(30초 시간 초과) 이 시간 뒤에는 담당이다(걸린 읽기가 오류로 끝나면 그때 내려놓는다). */
const SOLO_BOOT_WAIT_MS = 5_000;
const leaseBootAt = () => (globalThis.__argoSyncLeaseBootAt ??= Date.now());
leaseBootAt();

/** 러너 없는 기기의 리더 획득 양보 판정(유건 지시 2026-07-25) — 자격 있는 기기가 담당이 되도록,
    빈 리스를 그레이스 동안 잡지 않는다. 그레이스가 지나면 그래도 획득한다 — 어느 기기에도 러너가
    없을 때 리더 공백(페어링·안내 응답까지 사망)이 자격 오류 응답보다 나쁘기 때문.
    그레이스는 **시간 기반**(사후 검수 M-4: 사이클 수 기반은 ARGO_SYNC_CYCLE_MS 변경 시 불변식이 깨짐) —
    TTL + 40s: 자격 있는 기기에게 최소 한 TTL의 선점 기회를 준다.
    (export: 회귀 테스트용 — 순수 함수) */
export const YIELD_GRACE_MS = LEASE_TTL_MS + 40_000;
export const shouldYieldAcquire = (runnerUsable, yieldSince, now = Date.now()) =>
  !runnerUsable && (!yieldSince || now - yieldSince < YIELD_GRACE_MS);
/** 실행 담당인가 — 게이트웨이(슬랙·서류함)·스케줄러(루틴·검진·정리)가 본다. 두 기기가 함께 담당인 순간을 만들지 않는 것이 목적이다.
    · 엄격 판정(예비 기기·다른 기기를 본 적 있는 기기): 확인된 담당 기한(validUntil) 안일 때만 — 내 토큰이 그대로인 살아 있는 글을 마지막으로 본 읽기를 보낸 뒤
      LEASE_CONFIRM_VALID_MS(운영 18초)까지. 기동 기본값·30초 기본값은 없다. 잠들었다 깨면(기한 지남)·리스 읽기가 걸리거나 계속 실패하면·리스 판정이 멈추면 기한이
      지나 스스로 물러난다 — 넘겨받는 쪽이 대기(HANDOVER_WAIT_MS)를 마칠 때 앞 담당은 이미 아니다.
    · 단일 기기(다른 기기를 본 적 없음): 배포본처럼 표시(leader)를 따른다. 리스를 못 읽어도 표시를 바꾸지 않는다. 다만
      - 보유자는 내 리스 글이 만료되기 전(마지막 쓰기 + TTL − 여유)까지만이다 — 갱신하지 못하면(세션 끊김·네트워크) 만료 뒤 다른 기기가 가져간다. 맥 우선·서버 예비에서
        맥은 서버가 한 번 맡기 전까지 서버의 글을 본 적이 없어 단일 기기로 판정된다. 리스 판정은 동기화와 따로 30초마다 갱신하므로 긴 동기화로 꺼지지 않는다.
      - 기동 첫 리스 판정이 끝나기 전(최대 SOLO_BOOT_WAIT_MS)과, 잠들었다 깬 뒤 리스를 다시 확인하기 전은 아니다 — 그 사이 다른 기기가 처음으로 맡았을 수 있다
        (맥 앱이 켜지는 순간·깬 직후 첫 스케줄러 틱이 낡은 표시로 루틴을 다시 돌리지 않게).
    · 동기화 꺼짐(기기 세션 없음·ARGO_SYNC=0) = 단일 기기라 담당 — 예비 기기만 아니다(맥이 담당인지 알 수 없다). */
export function isCloudLeader(now = Date.now()) {
  if (!syncOn()) return leaseRole() !== 'standby';
  if (!leaseState.leader) return false;
  if (strictLease()) return now < (leaseState.validUntil || 0);
  observeAwake();
  if ((awake.wokeAt || 0) > (leaseState.checkedAt || 0)) return false;
  if (leaseState.ownedAt > 0) return now < leaseState.ownedAt + LEASE_TTL_MS - LEASE_CONFIRM_MARGIN_MS;
  return (leaseState.checkedAt || 0) > 0 || now - leaseBootAt() >= SOLO_BOOT_WAIT_MS;
}

/** 예비 기기(argo run --standby)가 지금 확인된 담당이 아닌가 — 예비 기기는 담당일 때만 팀 메신저를 받는다(gateway.mjs ensureGateway).
    메신저 브리지는 리스와 무관하게 모든 기기에서 돈다(실행권은 서버 클레임이 하나로 묶는다) — 그대로면 맥이 담당이어도 VPS가 먼저 집은 글은 VPS가 답한다.
    판정은 isCloudLeader 그대로다(예비 기기는 늘 엄격 판정, 동기화가 꺼져 있어도 담당 아님). 두 판정을 따로 두면 스케줄러·감시는 돌고 메신저만 꺼진
    어긋난 상태가 생겼다(D 1차 검수). 일반·우선 기기는 늘 거짓(종전 동작). */
export function standbyIdle(now = Date.now()) {
  if (leaseRole() !== 'standby') return false;
  return !isCloudLeader(now);
}

/** 리스 글의 비서 엔진 번호 — 능동 비서 감시기(src/assistant)가 든 본체가 리스를 쓸 때 싣는다. 옛 본체는 이 칸을 쓰지 않고 모르는 칸은 무시한다(쓰기 수 그대로).
    리더가 아닌 새 본체는 매 주기 읽는 리스 글에서 이 칸이 없거나 낮으면 "실행 기기가 옛 버전이라 비서가 꺼져 있음"을 안다.
    앱 버전 대신 번호를 쓰는 이유: 발행 전 개발 빌드(상주 :3001 등)는 package.json 버전이 직전 발행 그대로라 버전 비교가 감시기 있는 기기를 옛 버전으로 오판한다.
    번호: 1 = 1단계 엔진(#863 — 봉인을 보지 않는다), 2 = company.json 봉인이 맞는 설정만 켜는 엔진(src/assistant/config.mjs loadEffectiveAssistantConfig).
    번호 1 빌드가 실행 기기면 0.1.98 이하 기기의 에이전트가 쓴 봉인 없는 assistant.json으로도 비서가 켜질 수 있어서, 새 기기는 그 기기를 옛 버전으로 본다. */
export const LEASE_ASSISTANT_ENGINE = 2;

/** 리스 판정 값 읽기(능동 비서의 "리더 확인이 새것인가") — 비서는 여기서 확인된 보유(ownedAt > 0)와 확인 시각(checkedAt)까지 본다.
    holder = 마지막으로 읽은 원격 리스 글의 주인({ deviceId, assistant, ts }, 없으면 null). */
export function leaseCheck() {
  return { syncOn: syncOn(), leader: !!leaseState.leader, ownedAt: leaseState.ownedAt || 0, checkedAt: leaseState.checkedAt || 0, holder: leaseState.holder ?? null };
}

/** 리스 쓰기 실패(판정 불가) 시 리더십을 유지해도 되는가 — **확인된 CAS 획득자이고 TTL 내**일 때만 참.
    기본값 leader:true(미획득)는 여기서 반드시 거짓이어야 한다: 참이면 리스를 얻은 적 없는 프로세스가
    리더로 고착해 루틴 이중 실행·이중 과금·텔레그램 409가 난다(검수 2026-07-23). (export: 회귀 테스트용) */
export const holdsLeaseOnWriteFailure = (state, now = Date.now()) =>
  !!(state?.leader && state.ownedAt > 0 && now - state.ownedAt < LEASE_TTL_MS);

/** 확인 — 내 토큰이 그대로인 글을 본 읽기(sentAt = 보낸 시각)로 담당 기한을 늘린다. 그 글의 만료(ts + TTL)보다 늦지 않게: 다른 기기는 그때부터 가져간다. */
function confirmLease(sentAt, docTs) {
  leaseState.validUntil = Math.min(sentAt + LEASE_CONFIRM_VALID_MS, (Number(docTs) || 0) + LEASE_TTL_MS - LEASE_CONFIRM_MARGIN_MS);
}
/** 담당을 내려놓는다(남에게 넘김·획득 실패) — 보유 이력·확인 기한·토큰을 함께 지운다. */
function dropLease() {
  leaseState.leader = false; leaseState.ownedAt = 0; leaseState.validUntil = 0; leaseState.token = null;
}
/** 리스를 읽지 못함 — 이번 판정은 미룬다(쓰기 0). line = 읽기 오류 한 줄(5xx·fetch failed·시간 초과), 없으면 동기화 자격을 못 얻음(세션 만료·끊김).
    확인된 보유자(마지막 쓰기가 TTL 안)만 표시를 둔다 — 담당 여부는 엄격 판정이면 확인 기한, 단일 기기면 내 글 만료가 가른다. 나머지(예비 VPS·되찾는 맥·
    기동 기본값)는 담당 아님 — 넘겨받는 중(pending)이면 그대로 두고 다음 읽기에서 잇는다.
    단일 기기(다른 기기를 본 적 없음)의 세션 실패만 예외로 배포본처럼 표시를 둔다 — 동기화 자체가 안 되는 단일 기기의 루틴이 멈추지 않게. 읽기 오류는 예외가 아니다:
    처음 만나는 맥이 리스를 못 읽은 채 기동 기본값으로 VPS와 함께 담당이던 것(D 4차 검수 MEDIUM-A: GET만 실패 128.7초, 첫 읽기 500에 7.8초). */
function leaseUnreadable(line) {
  const strict = strictLease();
  const keep = (!strict && !line) || holdsLeaseOnWriteFailure(leaseState);
  if (line) noteOnce('lease-read', `[argo] ${line} — ${keep ? (strict ? '보유 리스: 확인 기한 안에서만 리더 유지(쓰기 없음)' : '보유 리스: 내 글 만료 전까지 리더 유지(쓰기 없음)') : '이번 판정 보류(담당 아님·쓰기 없음)'}`);
  if (!keep) { leaseState.leader = false; leaseState.ownedAt = 0; leaseState.validUntil = 0; }
  leaseState.checkedAt = Date.now();
}

// (export: 회귀 테스트용 — 판정식이 아닌 **배선**을 잠그기 위해. 프로덕션 호출부는 리스 타이머(leaseTick) 하나다.)
export async function renewLease(owner, { runnerUsable = true } = {}) {
  // 관찰 전용 프로세스(argo 대화 화면 — 동기화만 하고 게이트웨이·스케줄러는 안 돈다)는 담당을 맡지 않는다. 맡으면 다른 기기가 양보한 채
  // 아무도 메신저·루틴을 돌리지 않는다(2026-09-29 argo CLI). 리스를 읽지도 쓰지도 않는다 — 호출·쓰기 0.
  if (process.env.ARGO_NO_LEADER === '1') { dropLease(); leaseState.pending = null; leaseState.checkedAt = Date.now(); return; }
  observeAwake(); // 잠들었다 깼으면 여기서 알아챈다 — 아래 되찾기 판정(AWAKE_MIN_MS)보다 먼저
  const me = await getDeviceId();
  const key = skey(owner, '_device-lease.json');
  // 리스 읽기 — '없음'(storage-api 'Object not found' 하나 — isNotFound)과 '읽지 못함'(5xx·fetch failed·시간 초과·만료 토큰의 'Bucket not found'·응답 중단)을 가른다.
  // supabase-js download는 오류를 던지지 않고 { data: null, error }로 돌려준다. 예전에는 error를 보지 않아 읽기 한 번 실패가 '리스 없음'이 됐고, 비보유자가 남의 살아 있는
  // 리스를 덮어써 바로 담당이 됐다(D 2차 검수). 같은 모양의 결함을 daemonLease(lock.mjs)는 #873에서 닫았다. 깨진 글(JSON 아님)은 종전대로 없음으로 읽는다.
  // 원본을 읽는다(fresh() — cacheNonce): Storage는 인증 다운로드도 Cloudflare에 캐시해, 덮어쓴 직후에도 옛 사본을 준다(10/5 edge_logs: 리스 첫 읽기 HIT 하루 7,850회).
  let cur = null;
  let readErr = null;
  const readAt = Date.now(); // 이 읽기를 보낸 시각 — 확인 기한의 기준(confirmLease)
  leaseState.reads = (leaseState.reads || 0) + 1; // 리스 타이머의 기동 다시 읽기 판단(startLeaseLoop)
  try {
    const { data, error } = await client().storage.from(BUCKET).download(key, fresh());
    if (error) { if (!isNotFound(error)) readErr = error; }
    else if (data) {
      const text = Buffer.from(await data.arrayBuffer()).toString();
      try { cur = JSON.parse(text); } catch { /* 깨진 글 — 없음으로(종전) */ }
    }
  } catch (e) { readErr = e; } // 응답을 받다 끊김(blob 실패) 등 — 던져진 것도 읽지 못함이다
  let escaping = false;
  if (readErr) {
    const now = Date.now();
    const failSince = (leaseState.readFailSince ||= now);
    const why = String(readErr.message || readErr).slice(0, 80);
    // 자가 복구 — TTL 넘게 한 번도 읽지 못했으면 '없음'으로 보고 한 번 써 본다(읽을 수 없는 리스 객체가 모든 기기를 영영 막지 않게, 배포본이 첫 실패에 하던 덮어쓰기를 TTL 뒤로).
    // TTL에 한 번만, 쓴 뒤 재확인 읽기도 실패했으면 읽기가 돌아올 때까지 다시 쓰지 않는다 — GET만 계속 실패하는 기기가 매 주기 써서 정상 기기의 리스를
    // 덮던 것(D 3차 검수 LOW: 분당 7.2번 쓰기, 두 기기 모두 담당 아님 75초).
    if (!(now - failSince >= LEASE_TTL_MS && !leaseState.escapeBlocked && now - (leaseState.escapeAt || 0) >= LEASE_TTL_MS)) { leaseUnreadable(`리스 읽기 실패: ${why}`); return; }
    leaseState.escapeAt = now;
    escaping = true;
    noteOnce('lease-read', `[argo] 리스를 ${Math.round(LEASE_TTL_MS / 1000)}초 넘게 읽지 못함 — 없음으로 보고 한 번 써 본다: ${why}`);
  } else {
    leaseState.readFailSince = 0;
    leaseState.escapeBlocked = false;
    noteOnce('lease-read', '');
  }
  if (cur?.deviceId && cur.deviceId !== me) notePeer(cur);
  // 읽은 리스 글의 주인 — 리더가 아닌 기기가 "실행 기기가 옛 버전인가"를 판정하는 재료(leaseCheck, LEASE_ASSISTANT_ENGINE). 메모리만, 쓰기 없음.
  leaseState.holder = cur?.deviceId ? { deviceId: String(cur.deviceId), assistant: Number(cur.assistant) || 0, ts: Number(cur.ts) || 0 } : null;
  const live = cur && Date.now() - cur.ts < LEASE_TTL_MS; // 살아 있는 리스(TTL 안) — 위 fresh()(캐시 우회)와 다른 이름
  if (!readErr && !(live && cur.deviceId !== me)) leaseState.checkedAt = Date.now(); // 다른 기기가 맡고 있지 않음을 읽었다 — 단일 기기의 기동·깸 대기는 여기서 끝(쓰기·재확인 800ms를 기다리지 않는다)
  // 확인 — 내가 쓴 글(토큰)이 그대로 살아 있다. 이 읽기를 보낸 시각부터 확인 기한을 다시 센다(엄격 판정의 담당 근거).
  if (live && cur.deviceId === me && leaseState.leader && leaseState.token && cur.token === leaseState.token) confirmLease(readAt, cur.ts);
  // 역할(src/lease-role.mjs): 우선(argo run 기본 — 항상 켠 서버, 2026-09-29) > 일반(맥 앱·상주 :3001) > 예비(argo run --standby — 맥 우선·VPS 예비, 2026-10-08).
  // 다른 기기가 잡은 새 리스는 **더 높은 역할이고 러너가 있을 때만** 가져온다 — 맥이 켜지면 VPS(예비)에게서 되찾고, VPS는 맥의 새 리스에 늘 양보한다.
  // 러너 조건은 그레이스로도 우회하지 않는다: 답할 수 없는 기기가 답할 수 있는 기기의 담당을 뺏으면 안 된다(배포본은 러너 없는 우선 기기가
  // 그레이스 160초 뒤 일반 기기의 담당을 빼앗았다). 같은 역할끼리는 먼저 잡은 쪽을 존중한다(요동 금지). 옛 버전은 standby 표지를 몰라 예비 글도 일반 글로 읽는다.
  // 가져오는 쪽은 끊김 없이 AWAKE_MIN_MS(30초) 깨어 있어야 한다 — 잠깐 깼다 다시 잠드는 맥이 VPS를 물러나게만 하고 맡지 못해 2분 공백을 만들지 않게(AWAKE_MIN_MS 주석).
  const role = leaseRole();
  const awakeLong = Date.now() - awake.since >= AWAKE_MIN_MS;
  if (live && cur.deviceId !== me && ROLE_RANK[role] > docRank(cur) && runnerUsable && !awakeLong && leaseState.awaitedWake !== awake.since) {
    leaseState.awaitedWake = awake.since; // 깰 때마다 한 줄
    console.log(`[argo] 동기화: 실행 담당 되찾기 대기 — 이 기기가 ${Math.round(AWAKE_MIN_MS / 1000)}초 동안 깨어 있으면 ${cur.deviceId}에게서 넘겨받는다`);
  }
  if (live && cur.deviceId !== me && !(ROLE_RANK[role] > docRank(cur) && runnerUsable && awakeLong)) {
    if (leaseState.leader) console.log(`[argo] 동기화: 실행 리더 양보 → ${cur.deviceId}`);
    dropLease(); // 남에게 넘겼으니 보유 이력·확인 기한 소멸
    leaseState.pending = null;
    leaseState.checkedAt = Date.now();
    leaseState.yieldSince = 0; // 담당자가 있으니 양보 타이머 리셋
    return;
  }
  // 예비 기기는 일반 기기를 두 대 이상 본 적 있으면 남의 리스가 만료된 뒤 두 주기 더 기다린다 — 남은 맥이 먼저 가져가게(STANDBY_EXPIRED_WAIT_MS 주석).
  if (role === 'standby' && cur?.deviceId && cur.deviceId !== me && !live && (peerSeen()?.normals?.length ?? 0) >= 2
    && Date.now() - Number(cur.ts) < LEASE_TTL_MS + STANDBY_EXPIRED_WAIT_MS) {
    dropLease();
    leaseState.pending = null;
    leaseState.checkedAt = Date.now();
    return;
  }
  // 넘겨받기 확인 — 남의 새 리스를 가져오며 쓴 내 글이 HANDOVER_WAIT_MS 동안 그대로면, 앞 담당은 그 사이 이 글을 읽고 물러났거나 확인 기한이 지나 스스로 담당을 놓았다.
  // 이제 담당을 시작한다. 그 시간이 지나기 전에는 읽기만 하고 쓰지도 담당하지도 않는다(nudge로 주기가 빨라져도 대기가 줄지 않게 — HANDOVER_WAIT_MS 주석).
  // 내 글(토큰)이 그대로일 때만이다 — 같은 기기 id라도 다른 토큰이면(재시작 경쟁의 다른 프로세스) 넘겨받은 것으로 치지 않고 아래 획득을 다시 거친다.
  // 다시 쓰지 않는다(쓰기 합계 1 — DB 위생). 보유 시각은 그 글을 쓴 시각이다: 30초 갱신 규칙의 기준.
  if (live && cur.deviceId === me && leaseState.pending && cur.token === leaseState.pending.token) {
    if (Date.now() - leaseState.pending.ts < HANDOVER_WAIT_MS) { leaseState.checkedAt = Date.now(); return; }
    leaseState.token = leaseState.pending.token;
    leaseState.pending = null;
    leaseState.leader = true;
    leaseState.ownedAt = Number(cur.ts) || Date.now();
    confirmLease(readAt, cur.ts);
    leaseState.checkedAt = Date.now();
    leaseState.yieldSince = 0;
    console.log(`[argo] 동기화: 실행 리더 획득 (${me}, 넘겨받음)`);
    return;
  }
  const preempt = !!(live && cur.deviceId !== me); // 남의 새 리스를 가져온다(위 역할 판정 통과)
  // 신규 획득(이 프로세스가 **확인된 보유자**가 아님) + 러너 없음 → 그레이스 동안 양보(자격 있는 기기 우선).
  // ownedAt > 0 조건이 핵심(사후 검수 HIGH-1): 재시작한 프로세스는 미획득(ownedAt=0)이므로, 원격에 자기
  // 기기의 잔존 리스가 fresh해도 "갱신"이 아니라 양보 판정을 1회 거친다 — 앱 재시작·재부팅으로 러너 없는
  // 리더가 원상복구되던 우회 차단. 진짜 보유 프로세스(ownedAt>0)의 갱신은 막지 않는다(교대 요동 방지).
  const acquiring = !(live && cur?.deviceId === me && leaseState.ownedAt > 0);
  // 확인된 보유자가 TTL/4(30초) 안에 썼으면 다시 쓰지 않는다 — 읽기는 매 주기 해서 다른 기기의 탈취·경합은 그대로 바로 안다(검수 #689 M2).
  // 동기화 주기(8초)마다 업서트하던 것이 storage.objects에 죽은 행을 쌓았다(2026-09-23 DB 점검: 기기 25대 × 분당 7.5회).
  if (!acquiring && leaseState.leader && Date.now() - leaseState.ownedAt < LEASE_TTL_MS / 4) { leaseState.checkedAt = Date.now(); return; }
  if (acquiring && shouldYieldAcquire(runnerUsable, leaseState.yieldSince)) {
    if (!leaseState.yieldSince) {
      leaseState.yieldSince = Date.now();
      console.log('[argo] 동기화: 러너 미연결 — 리더 획득 양보 (자격 있는 기기 우선, 잠정 대기)');
    }
    dropLease();
    leaseState.pending = null;
    leaseState.checkedAt = Date.now();
    return;
  }
  if (runnerUsable) leaseState.yieldSince = 0;
  // 내 것이거나 만료 — 획득 시도. 스토리지엔 진짜 CAS가 없으므로 write-후-재확인으로
  // 이중 리더 창을 좁힌다: 내 토큰을 쓰고, 잠깐 뒤 다시 읽어 최종 승자가 나인지 확인.
  const token = randomUUID();
  const writeTs = Date.now();
  const { error: upErr } = await client().storage.from(BUCKET).upload(
    key, new Blob([JSON.stringify({ deviceId: me, token, ts: writeTs, ...roleMark(role), assistant: LEASE_ASSISTANT_ENGINE })]),
    { upsert: true, contentType: 'application/json' },
  );
  const upDoneAt = Date.now(); // 쓰기 응답을 받은 시각 — 넘겨받기 대기의 기준(LEASE_CONFIRM_MARGIN_MS 주석)
  // 쓰기 실패(네트워크·RLS 거부 등) = 판정 불가. **확인된 보유자이고 TTL 내일 때만** 유지하고,
  // 그 밖(미획득 기본값 포함)은 강등한다(검수 2026-07-23). 무조건 보류하면 리스를 얻은 적 없는 프로세스가
  // 리더로 고착해 이중 실행이 나고(조용한 정지보다 나쁨), 무조건 강등하면 일시 장애로 루틴·폴러가 멈춘다.
  // 이 절충은 일시 실패는 흡수하고 지속 실패는 TTL 경과로 자연 강등돼 수렴한다. 엄격 판정의 담당 여부는 그래도 확인 기한이 가른다.
  if (upErr) {
    const heldByMe = holdsLeaseOnWriteFailure(leaseState);
    console.warn(`[argo] 리스 갱신 실패 — ${heldByMe ? '보유 리스 TTL 내: 리더 유지' : '리더 강등'}: ${String(upErr.message || upErr).slice(0, 80)}`);
    if (!heldByMe) { dropLease(); leaseState.pending = null; }
    leaseState.checkedAt = Date.now();
    return;
  }
  await new Promise((r) => setTimeout(r, 800)); // 동시 기동한 다른 기기의 쓰기가 도착할 여유
  let winner = null;
  let checkFailed = false;
  const checkAt = Date.now();
  try {
    const { data, error } = await client().storage.from(BUCKET).download(`${key}?t=${Date.now()}`);
    if (error) checkFailed = true;
    else if (data) winner = JSON.parse(Buffer.from(await data.arrayBuffer()).toString());
  } catch { checkFailed = true; /* 재확인 실패 — 보수적으로 팔로워 */ }
  if (escaping && checkFailed) leaseState.escapeBlocked = true; // 자가 복구로 쓴 글도 읽지 못했다 — 읽기가 돌아올 때까지 다시 쓰지 않는다
  const iWon = winner && winner.token === token; // 내가 마지막 승자여야만 리더
  if (winner?.deviceId) leaseState.holder = { deviceId: String(winner.deviceId), assistant: Number(winner.assistant) || 0, ts: Number(winner.ts) || 0 };
  if (winner?.deviceId && winner.deviceId !== me) notePeer(winner);
  if (iWon && preempt) {
    // 남의 새 리스를 가져왔다 — 앞 담당은 다음 리스 판정(CYCLE_MS 안)에 이 글을 읽고 물러나거나, 확인 기한이 지나 스스로 물러난다. 그때까지 담당을 시작하지 않는다
    // (넘어가는 순간 양쪽 스케줄러가 같은 루틴을, 양쪽 게이트웨이가 같은 슬랙 글을 처리하지 않게). HANDOVER_WAIT_MS 뒤 이 글이 그대로면 위 '넘겨받기 확인'이 담당을 시작한다.
    if (!leaseState.pending) console.log(`[argo] 동기화: 실행 담당 넘겨받는 중 ← ${cur.deviceId} (앞 담당이 물러날 ${Math.round(HANDOVER_WAIT_MS / 1000)}초 뒤 시작)`);
    leaseState.pending = { token, ts: upDoneAt }; // 글의 ts(쓰기 전 시각)가 아니라 응답 받은 시각부터 센다 — 쓰기가 늦게 닿아도 대기가 줄지 않게
    dropLease();
    leaseState.checkedAt = Date.now();
    return;
  }
  leaseState.pending = null;
  if (iWon && !leaseState.leader) console.log(`[argo] 동기화: 실행 리더 획득 (${me})`);
  if (!iWon && leaseState.leader) console.log(`[argo] 동기화: 실행 리더 경합 양보 (${me})`);
  if (iWon) {
    leaseState.leader = true;
    leaseState.ownedAt = Date.now(); // 확인된 획득만 보유 이력으로 인정(위 upErr 분기의 근거)
    leaseState.token = token;
    confirmLease(checkAt, writeTs);
  } else dropLease();
  leaseState.checkedAt = Date.now();
}

/* ─── 텔레그램 토큰 클레임 — 토큰 단위 소유(유건 결정 2026-09-03) ───
   왜: 봇 토큰(connections.json)은 연결한 기기에만 있는데 폴러 주체는 기기 단위 리더 하나였다. 그래서
   비리더 기기에서 연결한 크루 봇은 어느 기기도 받지 않았다(리더는 토큰이 없고, 토큰 보유 기기는 폴러를 내림).
   처방: 기기 리더 리스와 별개로 **토큰마다** 클레임 파일(<owner>/.tg-claims/<토큰 지문>.json — 점 접두: 동기화 발견·
   클라우드 내보내기가 "회사 폴더"로 오인하지 않게, .tombstones와 같은 규약)을 두고,
   자기 기기에 저장된 토큰만 클레임해 폴링한다. 같은 토큰을 두 기기에 연결하면 나중 기기가 'other'로 물러나
   카드에 "다른 기기에서 수신 중"이 보인다. 토큰 원문은 어디에도 올리지 않는다(sha256 지문만). */
export const TG_CLAIM_TTL_MS = LEASE_TTL_MS;
const CLAIM_RENEW_MS = 30_000; // 갱신 주기 — 토큰마다 요청이 나가므로 리스(8s)보다 성기게(TTL 120s의 1/4)
const CLAIM_NEVER = -Infinity; // renewedAt 센티널 '한 번도 안 돌았음/즉시 실행' — 0이면 작은 now를 주는 하네스에서 레이트리밋이 조용히 옛 동작(재검수 L-C)
const claimState = (globalThis.__argoTgClaims ??= { tokens: new Set(), byHash: new Map(), renewedAt: CLAIM_NEVER, bootAt: Date.now(), removed: new Set() });
const CLAIM_DIR = '.tg-claims';
/** 클레임 상태를 기기 로컬 파일로도 남긴다 — 게이트웨이(daemonLease)와 동기화(holdSyncLock)가 다른 프로세스에 갈리면
    globalThis가 공유되지 않아 게이트웨이가 영원히 미판정(→ 90초 뒤 orphan 폴백 = 이중 폴링)이 되던 창(재검수 M-4)을 닫는다. */
const claimStateFile = () => join(WS_ROOT, '.tg-claims-state.json');
async function persistClaimState() {
  try { await writeJsonAtomic(claimStateFile(), { at: Date.now(), byHash: Object.fromEntries(claimState.byHash) }); } catch { /* 베스트에포트 */ }
}
function readClaimStateSync() {
  try { return JSON.parse(readFileSync(claimStateFile(), 'utf8')); } catch { return null; }
}
const CLAIM_ARBITRATION_GRACE_MS = 90_000; // 이 시간 동안 클레임 중재가 한 번도 안 돌았으면(자격 만료·오프라인) 단일 기기처럼 mine — 폴러 전멸 방지
export const tokenClaimHash = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
export const deviceLabel = (id) => String(id ?? '').replace(/-[0-9a-f]{8}$/i, ''); // "Geony-Mac-Pro-c40da337" → "Geony-Mac-Pro"
/** 순수 판정 — 원격 클레임 cur를 보고 이 기기(me)가 할 일: 'other'(살아 있는 남의 클레임 — 물러남) / 'acquire'(비었거나 만료·내 것 — 갱신·획득) */
export const claimDecision = (cur, me, now = Date.now(), ttl = TG_CLAIM_TTL_MS) =>
  (cur && now - cur.ts < ttl && cur.deviceId !== me) ? 'other' : 'acquire';
/** 게이트웨이가 이 기기의 텔레그램 토큰 집합을 등록한다 — cycle()이 이 집합을 갱신·클레임한다 */
export function setClaimTokens(tokens) {
  const next = new Set([...tokens].filter(Boolean));
  const nextHashes = new Set([...next].map(tokenClaimHash));
  for (const h of [...claimState.byHash.keys()]) { // 연결 해제된 토큰 — 상태를 버리고 원격 클레임도 다음 갱신에 지운다(재검수 L-3)
    if (!nextHashes.has(h)) { claimState.byHash.delete(h); claimState.removed.add(h); }
  }
  // 아직 판정 없는 토큰이 생겼으면(기동·신규 연결) 갱신 레이트리밋을 풀어 다음 cycle이 바로 클레임한다(재검수 M-2: 최대 30초 공백)
  if ([...nextHashes].some((h) => !claimState.byHash.has(h))) claimState.renewedAt = CLAIM_NEVER;
  claimState.tokens = next;
}
/** 이 기기가 이 토큰을 폴링해도 되는가 — 동기화 off(단일 기기)면 항상 mine. 클레임 전(미판정)은 mine이 아니다(이중 폴링 창 방지). */
export function tokenOwnership(token) {
  if (!syncOn()) return { mine: true, holder: null, pending: false };
  const hash = tokenClaimHash(token);
  let st = claimState.byHash.get(hash);
  if (!st && claimState.renewedAt === CLAIM_NEVER) { // 이 프로세스가 클레임을 돌린 적 없음 — 동기화 프로세스가 남긴 상태 파일(TTL 내)을 본다(M-4)
    const disk = readClaimStateSync();
    if (disk && Date.now() - disk.at < TG_CLAIM_TTL_MS) st = disk.byHash?.[hash] ?? null;
  }
  if (!st) {
    // 중재 불능 폴백 — 동기화가 켜져 있어도 클라우드에 한 번도 닿지 못했다면(자격 만료·오프라인) 종전(리더 기본값)처럼
    // 이 기기가 받는다. 이중 폴링 위험보다 "어느 기기도 안 받음"이 나쁘다(리스의 미획득 기본값과 같은 절충).
    const orphan = claimState.renewedAt === CLAIM_NEVER && Date.now() - claimState.bootAt > CLAIM_ARBITRATION_GRACE_MS;
    return { mine: orphan, holder: null, pending: !orphan };
  }
  return { mine: st.mine, holder: st.holder, pending: false };
}
export function _setTokenClaimForTest(token, state) { claimState.byHash.set(tokenClaimHash(token), state); }
export function _resetTokenClaimsForTest(bootAt = Date.now()) { claimState.tokens = new Set(); claimState.byHash.clear(); claimState.removed = new Set(); claimState.renewedAt = CLAIM_NEVER; claimState.bootAt = bootAt; try { unlinkSync(claimStateFile()); } catch { /* 없음 */ } }
export const _claimStateForTest = () => Object.fromEntries(claimState.byHash);
export const CLAIM_ARBITRATION_GRACE = CLAIM_ARBITRATION_GRACE_MS;
/** 원격 클레임 1건 읽기(캐시버스터) — 없음·손상은 null. 갱신 루프와 해제 청소가 같은 읽기를 쓴다. */
async function readRemoteClaim(key) {
  try {
    const { data } = await client().storage.from(BUCKET).download(`${key}?t=${Date.now()}`);
    return data ? JSON.parse(Buffer.from(await data.arrayBuffer()).toString()) : null;
  } catch { return null; } // 최초·미존재
}
/** 토큰별 클레임 갱신 — write-후-재확인(리스와 같은 CAS 근사). 판정 불가(쓰기 실패)면 보유 중이던 것만 TTL 내 유지. (export: 배선·행동 테스트용) */
export async function renewTokenClaims(owner, { now = Date.now(), force = false } = {}) {
  if (!force && now - claimState.renewedAt < CLAIM_RENEW_MS) return;
  if (claimState.tokens.size === 0 && claimState.removed.size === 0) return; // 등록 전(게이트웨이 sync 이전)에 레이트리밋을 소모하지 않는다(M-2)
  claimState.renewedAt = now;
  const me = await getDeviceId();
  for (const h of [...claimState.removed]) { // 해제된 토큰의 원격 클레임 정리 — 옮겨 간 기기가 TTL(120s)을 기다리지 않게(L-3)
    // 원격 클레임이 **내 것일 때만** 지운다 — 남이 보유 중인(또는 내 만료 뒤 남이 인수한) 클레임을 지우면 슬롯이 비어
    // 제3 기기가 획득 → 같은 토큰 이중 폴링(재검수 MEDIUM-A). 소유 확인·삭제 실패는 재시도하지 않는다: 상대는 TTL(120s)을
    // 기다리면 되고, 이 경로는 토큰 해제라는 드문 사건이다(L-B).
    const key = skey(owner, CLAIM_DIR, `${h}.json`);
    const cur = await readRemoteClaim(key);
    if (cur?.deviceId === me) await client().storage.from(BUCKET).remove([key]).catch(() => {});
    claimState.removed.delete(h);
  }
  for (const token of claimState.tokens) {
    const hash = tokenClaimHash(token);
    const key = skey(owner, CLAIM_DIR, `${hash}.json`);
    const prev = claimState.byHash.get(hash);
    const cur = await readRemoteClaim(key);
    if (claimDecision(cur, me, now) === 'other') {
      if (prev?.mine) console.log(`[argo] 텔레그램 토큰 클레임 양보 → ${deviceLabel(cur.deviceId)} (${hash.slice(0, 6)})`);
      claimState.byHash.set(hash, { mine: false, holder: cur.deviceId, ts: now });
      continue;
    }
    const nonce = randomUUID();
    const { error: upErr } = await client().storage.from(BUCKET).upload(
      key, new Blob([JSON.stringify({ deviceId: me, nonce, ts: now })]), { upsert: true, contentType: 'application/json' },
    );
    if (upErr) { // 판정 불가 — 이미 확인된 보유자이고 TTL 내면 유지, 아니면 미보유
      const keep = !!(prev?.mine && prev.ownedAt > 0 && now - prev.ownedAt < TG_CLAIM_TTL_MS);
      claimState.byHash.set(hash, { mine: keep, holder: keep ? me : null, ts: now, ownedAt: keep ? prev.ownedAt : 0 });
      continue;
    }
    // 내가 이미 확인된 보유자였고 원격도 내 것이면 재확인 생략(갱신) — 신규 획득만 800ms 뒤 승자 확인.
    // ownedAt은 갱신 시각으로 새로 찍는다(재검수 M-1: 최초 획득 시각에 고정하면 120초 뒤 일시 쓰기 실패 1회에 강등됐다)
    if (prev?.mine && cur?.deviceId === me) { claimState.byHash.set(hash, { mine: true, holder: me, ts: now, ownedAt: now }); continue; }
    await new Promise((r) => setTimeout(r, 800));
    let winner = null;
    try {
      const { data } = await client().storage.from(BUCKET).download(`${key}?t=${now + 1}`);
      if (data) winner = JSON.parse(Buffer.from(await data.arrayBuffer()).toString());
    } catch { /* 재확인 실패 — 보수적으로 미보유 */ }
    const iWon = !!winner && winner.nonce === nonce;
    if (iWon && !prev?.mine) console.log(`[argo] 텔레그램 토큰 클레임 획득 (${hash.slice(0, 6)})`);
    claimState.byHash.set(hash, { mine: iWon, holder: iWon ? me : (winner?.deviceId ?? null), ts: now, ownedAt: iWon ? now : 0 });
  }
  await persistClaimState();
}

/* ─── 로컬 스캔 (내용 해시 포함 — 변경 판별의 진실) ─── */
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
async function walk(dir, base = dir, out = {}, failed = null, ctx = null) {
  const top = !ctx;
  if (top) {
    const now = Date.now();
    if (now < walkCache.lastNow) walkCache.roots.clear(); // 시계가 되돌아갔다 — 캐시의 시각 판정을 믿지 않는다(걷기 캐시 주석)
    walkCache.lastNow = now;
    ctx = { now, prev: walkCache.roots.get(base), next: new Map(), cached: new Set() };
    walkFromCache.set(out, ctx.cached);
  }
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch {
    // 이 디렉터리를 못 읽음(EMFILE·EIO·권한·레이스 등) — 하위 파일들의 '부재'는 삭제가 아니라 unknown.
    // subtree prefix를 기록해 삭제 전파·브레이크 집계에서 제외한다(walk 실패발 대량/피드백 유실 차단).
    if (failed) failed.add(dir === base ? '' : dir.slice(base.length + 1).split(sep).join('/'));
    return out; // (루트를 못 읽었으면 캐시는 그대로 둔다)
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length + 1).split(sep).join('/');
    if (isLocalImportRel(rel)) continue; // source paths/consents/staging are private to this device
    if (isTurnTraceRel(rel)) continue; // 작업 과정 기록 — 기기 로컬(EXCLUDE·diff 불가시). 턴마다 쌓이는 폴더라 8초 사이클이 내려가지도 않게
    if (e.isDirectory()) {
      // 개발 산출물 디렉터리는 내려가지 않는다(isDevArtifactRel 주석) — diff 쪽 불가시 가드가 원격 전용
      // 항목의 pull·삭제 전파를 이미 막아주므로, 여기서 스킵해도 안전하고 CPU·IO만 줄어든다.
      if (isDevArtifactSeg(e.name)) continue;
      await walk(full, base, out, failed, ctx);
    }
    else if (!EXCLUDE(rel) && !isDevArtifactRel(rel)) {
      try { out[rel] = await fileMeta(full, rel, ctx); } catch { /* 읽는 중 사라진 파일 — 스킵 */ }
    }
  }
  if (top) walkCache.roots.set(base, ctx.next); // 이번에 본 파일만 남긴다(지운 파일의 항목은 여기서 빠진다)
  return out;
}
/** 파일 하나의 { m, s, h } — 걷기 캐시(위 주석)가 맞으면 읽지 않는다. 동기화하지 않을 크기(tooBigToSync)는 읽지도 해시하지도 않는다(h 없음 —
    diff에서 불가시라 해시를 쓰는 곳이 없다. 162MB 파일을 8초마다 메모리로 읽던 비용도 없앤다). */
async function fileMeta(full, rel, ctx) {
  const st = await stat(full);
  const m = Math.round(st.mtimeMs);
  if (tooBigToSync(st.size)) return { m, s: st.size };
  const key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.dev}`;
  const prev = ctx.prev?.get(rel);
  if (prev && prev.key === key && ctx.now >= prev.at && ctx.now - prev.at < WALK_REHASH_MS) {
    ctx.next.set(rel, prev); ctx.cached.add(rel);
    return { m, s: st.size, h: prev.h };
  }
  const buf = await readFile(full);
  const h = hashBuf(buf);
  // 걷기를 시작하기 WALK_RACY_MS 전보다 나중에 바뀐 파일(그리고 미래 시각 파일)은 캐시하지 않는다 — 다음 걷기가 다시 읽는다
  if (Math.max(st.mtimeMs, st.ctimeMs) < ctx.now - WALK_RACY_MS) ctx.next.set(rel, { key, h, at: ctx.now });
  return { m, s: buf.length, h };
}

// 파일 종류 — 충돌 처리 전략이 갈린다. (export: 회귀 테스트용 순수 함수)
export const isLedger = (rel) => rel.endsWith('.jsonl'); // usage.jsonl, events.jsonl — append-only 원장(행 병합)
export const isText = (rel) => rel.endsWith('.md');       // 노트·일지 — 충돌 시 양쪽 보존
export const isThread = (rel) => /^chats\/[^/]+\.json$/.test(rel); // 진행 중 턴과 레이스 → 스레드 락
/** 코어 모듈이 `<file>.lockd` 프로세스 간 잠금 안에서 읽고-고쳐-쓰는 파일(스레드 제외 — 스레드는 isThread). 동기화가 이 파일들을 쓸 때도 같은 잠금을 잡는다. (export: 회귀 테스트용) */
export const isFileLockedRel = (rel) => /^(company|approvals|corrections|routines|connections|assistant)\.json$/.test(rel) || /^agents\/[^/]+\.md$/.test(rel); // assistant.json — 비서 설정·알리지 않기 목록(설정 API가 같은 잠금 안에서 고친다)
// 아카이브(.archive)·휴지통(.trash)은 content 삭제가 아니라 이동(비파괴) — 대량삭제 브레이크 집계에서 제외한다.
// 세션 여러 개 삭제(=.archive→.trash 이동)가 브레이크를 걸어 소규모 회사 동기화를 영구 정지시키던 문제 방지(리뷰 M2). 동기화 push/pull 자체는 정상 진행.
export const isArchival = (rel) => /(^|\/)\.(archive|trash)\//.test(rel);
/** walk가 readdir 실패로 못 읽은 subtree 안의 경로인가 — 이 경로의 로컬 '부재'는 삭제가 아니라 unknown이므로
    삭제 전파·브레이크 집계에서 제외한다. failed는 walk가 채운 실패 prefix 집합('' = 루트 전체). (export: 회귀 테스트용) */
export const isUnderFailed = (rel, failed) => {
  if (!failed || failed.size === 0) return false;
  for (const d of failed) if (d === '' || rel === d || rel.startsWith(`${d}/`)) return true;
  return false;
};
/** 이번 사이클에 새로 나타난 아카이브/휴지통 파일의 basename 집합(base에 없던 것) — .archive→.trash 이동의 '목적지'.
    이동의 삭제 쪽만 브레이크에서 제외하고, 짝 없는 순수 소멸(walk 실패·디스크 결함)은 삭제로 집계하기 위한 판별. (export: 회귀 테스트용) */
export const archivalCreateNames = (local, state) => {
  const s = new Set();
  for (const rel of Object.keys(local)) if (isArchival(rel) && !state[rel]) s.add(rel.split('/').pop());
  return s;
};
/** 대량 삭제 브레이크 — 삭제 예정 수가 위험하면 true(중단). 회사 파일을 통째로 지우거나(전부 삭제)
   큰 배치(8개↑ 또는 절반↑)면 중단. 삭제는 비가역이라 "안 지우고 보류"가 항상 옳다. (export: 회귀 테스트용) */
export const massDeleteBrake = (deletes, baseCount) =>
  baseCount >= 2 && (deletes >= baseCount || deletes >= Math.max(8, Math.ceil(baseCount * 0.5)));
/** 안전한 상대 경로인가 — 원격 매니페스트 키를 FS에 join하기 전 검증(경로 탈출 차단, P1-7).
   원격 키는 신뢰할 수 없다(변조된 __manifest__.json이 `../../etc/x` 같은 키로 워크스페이스 밖 파일을
   쓰거나 지우게 할 수 있다). 절대경로·빈/`.`/`..` 세그먼트·NUL을 거부한다. (export: 회귀 테스트용) */
export const safeRel = (rel) =>
  typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.includes('\0')
  && !rel.includes('\\') && !/^[a-zA-Z]:/.test(rel) // Windows: 백슬래시·드라이브문자(C:) 거부(데스크톱/Electron 대비)
  && !rel.split('/').some((s) => s === '' || s === '.' || s === '..');
const threadLockKey = (wsId, rel) => `thread:${wsId}:${rel.slice(6).replace(/\.json$/, '').replace(/[^a-z0-9-]/g, '')}`;

/** 원장 병합 — 원격+로컬 행의 합집합(동일 행 dedup). 순서: 원격 먼저 후 로컬 신규. blob LWW의 행 유실 방지. */
export function mergeLedger(localBuf, remoteBuf) {
  const seen = new Set();
  const out = [];
  for (const buf of [remoteBuf, localBuf]) {
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim() || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return Buffer.from(out.length ? out.join('\n') + '\n' : '');
}

/** 스레드 blob 충돌 병합 — 메시지 배열 합집합(ts|who|text로 dedup), ts 오름차순. 웹↔앱 동시 편집의 turn 유실 방지.
    prefer('remote'|'local') = title·sessionId 등 스칼라 필드를 취할 쪽(더 최근 mtime). 파싱 불가한 쪽은 반대쪽 채택. (export: 회귀 테스트용) */
export function mergeThread(localBuf, remoteBuf, prefer = 'remote') {
  const parse = (b) => { try { const o = JSON.parse(b.toString('utf8')); return o && Array.isArray(o.messages) ? o : null; } catch { return null; } };
  const L = parse(localBuf), R = parse(remoteBuf);
  if (!L && !R) return prefer === 'local' ? localBuf : remoteBuf; // 둘 다 파싱 불가 — blob 그대로(LWW 폴백)
  if (!L) return remoteBuf;
  if (!R) return localBuf;
  // 리셋 tombstone — "새 대화"로 비운 사실은 union 병합으로 표현할 수 없다(합집합은 삭제를 모른다).
  // 양쪽 resetAt 중 최신값보다 **오래된** 메시지는 제외한다: 그래야 비움이 보존되고, 리셋 이후
  // 다른 기기에서 온 새 메시지는 살아남는다(실사용 제보 2026-09-01 — 새 대화가 8초 만에 851건으로 복귀).
  const resetAt = Math.max(Number(L.resetAt) || 0, Number(R.resetAt) || 0);
  // 되살림(이어가기)은 리셋을 취소하는 사건이다 — 더 최신이면 tombstone을 적용하지 않는다.
  // 로컬에서 resetAt을 지우는 것만으론 원격이 든 tombstone을 이기지 못한다(실측).
  const resumedAt = Math.max(Number(L.resumedAt) || 0, Number(R.resumedAt) || 0);
  // 자르는 지점은 순서값(resetAt)이 아니라 cutTs — resetAt은 단조 때문에 되살림의 벽시계를 물려받아
  // 미래로 부풀 수 있고, 그걸로 자르면 시계 앞선 기기가 남의 새 메시지를 지운다(분리 검수 3R
  // MEDIUM-1 재현: 되살림 +1h → 비움 → 상대 기기 신규 메시지 삭제). cutTs는 실존 메시지 ts에만
  // 앵커되므로 max를 취해도 "어느 한쪽이 실제로 봤던 것"까지만 자른다. 구버전 blob(cutTs 부재)은
  // resetAt 폴백 — 옛 동작 그대로라 하위 호환.
  const cutTs = Math.max(Number(L.cutTs) || 0, Number(R.cutTs) || 0);
  // 되살림이 최신(회의 전환·이어가기)이면 **되살린 쪽의 메시지는 통째로 지키고, 상대 쪽만 cutTs로 자른다.**
  // 전환은 "현재 회의를 보관하고 다른 회의를 복원"이라 방 파일의 정체가 바뀌는데, 상대 기기가 아직 든 전환 직전
  // 방 사본(= 방금 보관한 회의)이 union으로 되살아나 새 회의에 섞였다(#395 분리 검수 HIGH-1 재현: 2건 → 4건,
  // 다음 마치기에 두 회의가 한 회의록으로). 되살린 회의는 보관한 회의보다 오래된 게 정상이라 양쪽을 한 값으로
  // 자를 수 없고, 되살린 쪽 면제가 답이다. cutTs를 안 실은 되살림(크루 이어가기 — thread.mjs resumeSession은
  // cutTs를 지운다)은 종전과 같은 union(회귀 0). 리셋이 최신이면 종전대로 양쪽을 자른다.
  const resumed = resumedAt > 0 && resumedAt >= resetAt;
  const resumer = !resumed ? null : (Number(L.resumedAt) || 0) >= (Number(R.resumedAt) || 0) ? L : R;
  const cutAt = resumed ? 0 : (cutTs || resetAt); // 리셋이 최신 — 양쪽
  const otherCut = resumed ? cutTs : 0;            // 되살림이 최신 — 되살린 쪽의 상대만
  const seen = new Set();
  const msgs = [];
  for (const [side, list] of [[R, R.messages], [L, L.messages]]) {
    for (const m of list) {
      const ts = Number(m?.ts) || 0;
      if (cutAt && ts < cutAt) continue; // 리셋 이전 대화는 .archive에 남아 있다
      if (otherCut && side !== resumer && ts < otherCut) continue; // 보관한 회의의 사본 — 그 회의는 .archive에 진행 중으로 남아 있다
      const k = `${m?.ts ?? ''}|${m?.who ?? ''}|${typeof m?.text === 'string' ? m.text : JSON.stringify(m?.text ?? '')}`;
      if (seen.has(k)) continue;
      seen.add(k); msgs.push(m);
    }
  }
  msgs.sort((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0));
  const primary = prefer === 'local' ? L : R, other = prefer === 'local' ? R : L;
  const merged = { ...other, ...primary, messages: msgs };
  // tombstone은 최신값으로 보존 — 한쪽만 갖고 있어도 다음 사이클에서 잃지 않는다(안 그러면 다음
  // 병합에서 옛 메시지가 다시 union에 들어와 부활이 재발한다).
  if (resetAt) merged.resetAt = resetAt; else delete merged.resetAt;
  if (resumedAt) merged.resumedAt = resumedAt; else delete merged.resumedAt; // 두 마커 모두 최신값 보존
  if (cutTs) merged.cutTs = cutTs; else delete merged.cutTs; // 자르는 지점도 — 잃으면 다음 사이클이 resetAt 폴백(부풀 수 있는 값)으로 자른다
  merged.sessionId = primary.sessionId ?? other.sessionId ?? null; // 이어가기 세션은 최근 편집 쪽으로 수렴
  // sessionDevice는 sessionId를 제공한 쪽과 짝으로 — 어긋나면 남의 기기 세션을 내 것으로 오판한다
  merged.sessionDevice = (primary.sessionId != null ? primary.sessionDevice : other.sessionDevice) ?? null;
  // 그 세션이 본 주인 혼자 1:1 줄(thread.mjs soloSeen)도 세션 id와 짝 — 고른 sessionId의 기록만 남기고, 양쪽이 같은 세션이면 합친다(세션은 본 것을 잊지 않는다).
  // 어긋난 기록을 남기면 다른 세션이 본 줄을 이 세션이 본 것으로 읽어 건네지 않는다(1:1 대화를 모른다). 기록이 없으면 못 본 줄을 다시 건넬 뿐이다.
  const soloSeenOf = (x) => (merged.sessionId && x?.soloSeen?.session === merged.sessionId && Array.isArray(x.soloSeen.keys) ? x.soloSeen.keys : null);
  const seenKeys = [soloSeenOf(primary), soloSeenOf(other)].filter(Boolean);
  if (seenKeys.length) merged.soloSeen = { session: merged.sessionId, keys: [...new Set(seenKeys.flat())] }; else delete merged.soloSeen;
  if (L.scopedSessions || R.scopedSessions) merged.scopedSessions = { ...other.scopedSessions, ...primary.scopedSessions }; // 메신저 채널 세션은 채널 단위로 합친다(세션·기기 짝은 항목 안에 함께 있다)
  // 누적 요약(thread-context.mjs {text, upto}) — 통째로 한쪽 것을 쓰면 다른 기기의 더 최신 요약·그 기기에만 있는 채널 요약이 사라져 같은 몫을 다시 요약한다(재검수 LOW).
  // 키마다 upto(요약이 덮는 마지막 메시지 ts)가 큰 쪽, 같으면 최근 편집 쪽. 회수된 채널의 요약은 아래 applyDeparted가 지운다.
  const newerSum = (p, o) => (!p ? o : !o ? p : (Number(o.upto) || 0) > (Number(p.upto) || 0) ? o : p);
  // 회수 각인은 먼저 합친다 — 회수가 거둔 요약(옛 버전 사본이 되돌린 것)은 고르기 전에 뺀다. 안 빼면 기준점이 같거나 큰 옛 요약이 회수 뒤 새 요약을 이기고 아래에서 둘 다 사라진다.
  const departed = mergeDeparted(L.departed, R.departed);
  const live = (s) => (s && !unscopedSummaryGone(departed, s) ? s : null); // 표지를 잃은 옛 버전 요약(withSolo 없음)도 — 회수 각인이 있으면 고르지 않는다(departed.mjs)
  const sum = newerSum(live(primary.summary), live(other.summary)); if (sum) merged.summary = sum; else delete merged.summary;
  if (L.scopedSummaries || R.scopedSummaries) merged.scopedSummaries = Object.fromEntries([...new Set([...Object.keys(other.scopedSummaries ?? {}), ...Object.keys(primary.scopedSummaries ?? {})])].map((k) => [k, newerSum(primary.scopedSummaries?.[k], other.scopedSummaries?.[k])]));
  // 채널 기억 회수 각인(departed.mjs) — 채널마다 늦은 시각으로 합치고(위) 병합 결과에 다시 적용한다. 다른 기기가 아직 든 옛 채널 줄·세션이 합집합으로 되살아나지 않게.
  if (departed) { merged.departed = departed; applyDeparted(merged); } else delete merged.departed;
  return Buffer.from(JSON.stringify(merged, null, 2));
}

const stateFile = (wsId) => join(paths(wsId).root, '.sync-state.json');

/** free 스킵 판정의 원천 — state(base) 존재 = 복원 완결. 손상·부재는 미완(재pull, self-heal 방향).
    (export: 회귀 테스트용 — cycle은 export가 안 돼 이 술어가 스킵 배선의 테스트 가능한 반쪽이다) */
export async function syncStateExists(wsId) {
  try { return !!(await readJsonLenient(stateFile(wsId), null)); } catch { return false; }
}
const loadState = (wsId) => readJsonLenient(stateFile(wsId), { files: {} });

async function download(key, signal) {
  const { data, error } = await client().storage.from(BUCKET).download(key, fresh(), signal ? { signal } : undefined);
  if (error) throw Object.assign(new Error(error.message), { notFound: isNotFound(error) });
  return Buffer.from(await data.arrayBuffer());
}

async function upload(key, buf) {
  const { error } = await client().storage.from(BUCKET).upload(
    key, new Blob([buf]), { upsert: true, contentType: 'application/octet-stream' },
  );
  if (error) {
    // **쓰기 시도에서 났다**는 사실만 태그한다(원인 문구는 보지 않는다). 두 가지를 동시에 만족하려는 표시다:
    // ① 판정 근거를 서버 문구에 걸지 않는다 — free 거부는 "violates row-level security"로 오지만
    //    storage-api 버전·경로에 따라 문구가 달라질 수 있어(라이브 미검증) 문구 매칭은 조용히 무효화된다.
    //    "이 플랜은 애초에 못 쓴다"가 관용의 근거이므로 원인 구분은 free에서 실익이 없다(아래 catch 참조).
    // ② 그러나 **pull(download) 실패는 절대 이 태그를 못 받는다** — 재판정을 catch에서 하면 못 받은 파일이
    //    base에 들어가 이후 사이클이 '내가 지웠음'으로 오판해 원격 삭제를 전파한다(유실). 태그를 이
    //    호출 지점에만 붙이는 것이 그 경계다.
    const e = new Error(error.message);
    e.uploadFailed = true;
    throw e;
  }
}

/* ─── 회사 1개 동기화 — base(마지막 동기화 상태) 대비 3-way 병합.
   "누가 바꿨나"를 해시로 판별해, 한쪽만 바뀌면 그쪽을 반영하고, 양쪽이 바뀌면 파일 종류별로
   충돌을 해소한다(원장=행 병합, 텍스트=양쪽 보존, 스레드=락). blind LWW로 조용히 파기하지 않는다.

   opts.freePlan = 이 회사가 확정 free다 → 클라우드 쓰기 거부가 이 계정의 **정상 결과**이므로 실패와
   분리 집계(denied)하고, 사이클을 완결(state 기록)까지 보낸다. 미지정(pro·미확인)은 종전대로 전부 failed.

   opts.noSecrets = 이 회사가 자격 동기화를 껐다(company.json credSync:false — 서비스 모드의 선택권).
   호스티드 모드는 opts와 무관하게 **항상** 강제된다(hostedCredsOff — 함수 내부 게이트라 호출 경로
   무관). 자격 3종(isSecretRel)은 push/pull/삭제 전파 전부에서 불가시가 되고("키 미확보" 사이클과
   같은 안전 패턴), 클라우드에 이미 있는 자격 암호문은 마커(CRED_WITHDRAWN)로 **덮어써** 회수한다 —
   remove가 아닌 이유는 secretbox.mjs 마커 주석 참조(구버전·미반영 기기의 로컬 자격 오삭제 차단). */
export async function syncCompany(wsId, owner, isRestore = false, opts = {}) {
  const key = `${client().storage.url ?? 'test'}/${owner}/${wsId}`;
  const prior = companyRetry.get(key);
  if (prior && Date.now() < prior.until) return { skipped: 'retry-backoff', retryAt: prior.until, ...(prior.lastFailures ? { failures: prior.lastFailures } : {}) };
  const deferFailure = (lastFailures) => {
    companyIdle.delete(key);
    const failures = Math.min((prior?.failures ?? 0) + 1, 6);
    companyRetry.set(key, { failures, until: Date.now() + Math.min(600_000, 30_000 * 2 ** (failures - 1)), lastFailures });
  };
  const fingerprint = async () => {
    const failed = new Set();
    const files = await walk(paths(wsId).root, paths(wsId).root, {}, failed);
    return failed.size ? null : JSON.stringify([!!dek(), cryptoOn(), !!opts.noSecrets, files]);
  };
  const canIdle = !isRestore && !opts.reseal && !opts.freePlan;
  const idle = companyIdle.get(key);
  const beforeFingerprint = canIdle ? await fingerprint() : null;
  // 유휴 확인으로 건너뛴 사이클도 마지막 전체 사이클의 크기 초과 목록을 그대로 싣는다 — 안 실으면 설정 화면의 '동기화 제외' 줄이 다음 사이클에 사라진다
  if (canIdle && idle && Date.now() - idle.at < IDLE_PROBE_MS && beforeFingerprint === idle.fingerprint) {
    return { skipped: 'idle-probe', retryAt: idle.at + IDLE_PROBE_MS, pulled: 0, pushed: 0, deletedL: 0, deletedR: 0, failed: 0, ...idle.excluded };
  }
  try {
    let revision = null;
    const bucket = client().storage.from(BUCKET);
    if (canIdle && typeof bucket.info === 'function') {
      // Capture revision BEFORE the GET: a concurrent writer can only cause an extra
      // fetch next time, never bless old content with a newer revision.
      const { data, error } = await bucket.info(skey(owner, wsId, '__manifest__.json'));
      if (error && ![404, 400, 501].includes(Number(error.status ?? error.statusCode))) throw new Error(`매니페스트 메타데이터 읽기 실패: ${String(error.message).slice(0, 80)}`);
      if (data?.version || data?.etag) revision = JSON.stringify([data.version, data.etag, data.lastModified, data.size]);
      if (revision && idle?.revision === revision && beforeFingerprint === idle.fingerprint) {
        companyIdle.set(key, { ...idle, at: Date.now() });
        return { skipped: 'idle-probe', pulled: 0, pushed: 0, deletedL: 0, deletedR: 0, failed: 0, ...idle.excluded };
      }
    }
    const result = await syncCompanyOnce(wsId, owner, isRestore, opts);
    // 실패 파일·빈 항목은 이름까지 로그에 남긴다(~/Library/Logs/argo.err.log) — 목록이 바뀔 때만 한 줄
    noteOnce(`${key}:fail`, result.failed ? `[argo] 동기화(${wsId}): 파일 ${result.failed}건 실패 — ${(result.failures ?? []).map((f) => `${f.rel}: ${f.reason}`).join(' | ')}` : '');
    noteOnce(`${key}:missing`, result.missing ? `[argo] 동기화(${wsId}): 매니페스트에만 있고 객체가 없는 항목 ${result.missing}개 — 건너뜀(항목 보존): ${result.missingRels.join(', ')}` : '');
    noteOnce(`${key}:oversize`, result.oversize ? `[argo] 동기화(${wsId}): ${Math.floor(SYNC_MAX_OBJECT_BYTES / 2 ** 20)}MB를 넘는 파일 ${result.oversize}개는 동기화하지 않습니다(이 기기에만 둠): ${result.oversizeRels.join(', ')}` : '');
    if (result.failed > 0) { deferFailure(result.failures); return result; }
    companyRetry.delete(key);
    if (canIdle && !result.failed && !result.held && !result.deferred) {
      const stamp = await fingerprint();
      if (stamp !== null && stamp === beforeFingerprint) companyIdle.set(key, { at: Date.now(), fingerprint: stamp, revision, excluded: result.oversize ? { oversize: result.oversize, oversizeRels: result.oversizeRels, oversizeLimit: result.oversizeLimit } : undefined });
      else companyIdle.delete(key);
    } else companyIdle.delete(key);
    return result;
  } catch (e) {
    // 30s → 60s → ... → 10min per company/device; nudge does not reset the cooldown.
    deferFailure();
    throw e;
  }
}

async function syncCompanyOnce(wsId, owner, isRestore = false, opts = {}) {
  const root = paths(wsId).root;
  const noSecrets = !!opts.noSecrets || hostedCredsOff();
  const me = await getDeviceId();
  const manifestKey = skey(owner, wsId, '__manifest__.json');
  // 매니페스트 읽기 — "없음(최초 푸시)"과 "읽기 실패(네트워크·타임아웃·5xx)"를 반드시 구분한다.
  // 실패를 빈 원격으로 오인하면 base의 전 파일을 '원격에서 삭제됨'으로 판정해 로컬을 통째로 지운다(대형 유실 원인).
  let remote = { files: {} };
  let manifestExists = false;
  let manifestNeedsSeal = false;
  {
    const { data, error } = await client().storage.from(BUCKET).download(manifestKey, fresh());
    if (error) {
      const msg = String(error.message || error);
      if (!isNotFound(error)) throw new Error(`매니페스트 읽기 실패 — 삭제 보류(다음 사이클 재시도): ${msg.slice(0, 80)}`);
      // notFound = 원격 진짜 없음(최초 푸시). 이때 base(.sync-state)도 비어 삭제 분기가 안 타므로 안전.
    } else {
      manifestExists = true;
      // 관용 개봉 — 매니페스트가 봉투일 수도(다른 기기가 스위치 on), 평문일 수도 있다. 둘 다 수용.
      try {
        const bytes = Buffer.from(await data.arrayBuffer());
        const target = dek() ? 'argosecret.v3:' : cryptoOn() ? 'argosecret.v2:' : null;
        manifestNeedsSeal = !!target && !bytes.subarray(0, target.length).equals(Buffer.from(target));
        remote = JSON.parse(openSecretCompat(bytes).toString());
      }
      catch (e) { throw new Error(`매니페스트 파싱 실패 — 삭제 보류: ${String(e.message).slice(0, 80)}`); }
    }
  }
  const originalFiles = JSON.stringify(remote.files);
  // 원격 매니페스트 키 위생(P1-7) — 변조된 키(경로 탈출 `../..`)를 FS 반영 전에 걸러낸다. 걸러진 키는 이 사이클 무시.
  if (remote.files && typeof remote.files === 'object') {
    let dropped = 0;
    for (const k of Object.keys(remote.files)) if (!safeRel(k)) { delete remote.files[k]; dropped++; }
    if (dropped) console.warn(`[sync] 안전하지 않은 원격 매니페스트 키 ${dropped}개 무시(경로 탈출 차단) — ws=${wsId}`);
  }
  // 새 기기 복원(원격에서만 발견) — 회사 폴더가 아직 없으면 먼저 만든다. 부재를 walk 실패('' = 루트)로 기록하면
  // 원격 전 파일이 "로컬 unknown"으로 보류돼 첫 사이클이 0개를 받고, 다음 발견 주기(5분)까지 회사가 없는 것처럼 보였다
  // (실측 2026-09-30 argo CLI 첫 로그인). 복원이 아닌 회사의 walk 실패 보류는 그대로다(대량 유실 방어).
  if (isRestore) await mkdir(root, { recursive: true });
  const failedDirs = new Set();
  const local = await walk(root, root, {}, failedDirs); // 자격 3종은 diff 루프의 불가시 가드가 단일 게이트(walk 중복 게이트 금지 — 등가 변이 실증)
  const state = (await loadState(wsId)).files ?? {};
  // 신규 복원 가드 — 이 회사가 원격에서만 발견됐고(isRestore: 로컬에 company.json조차 없음) 로컬이
  // 통째로 비었는데 base(.sync-state)만 남아 있으면, 삭제 의도가 아니라 복원이다(재설치·루트 리셋·과거
  // 쓰기 실패 잔재). base를 비워 전체를 새로 pull한다 — 원격은 온전하니 유실 위험 없음.
  // isRestore로 좁히는 게 핵심: 로컬에 회사가 있고 일부만 지운 '진짜 삭제'는 이 분기를 타지 않는다.
  // walk 실패(failedDirs)가 있으면 '비어 보임'을 못 믿으므로 리셋하지 않는다(유실 방어 유지).
  // (실측: v0.1.1 Windows 경계 버그가 pull 쓰기를 막고 state만 남겨 → 대량삭제 브레이크 오탐 → 동기화 영구 보류)
  if (isRestore && Object.keys(local).length === 0 && Object.keys(state).length > 0 && failedDirs.size === 0) {
    console.warn(`[argo] 동기화(${wsId}): 원격에서 발견된 빈 회사 — 신규 복원으로 간주, base 리셋`);
    for (const k of Object.keys(state)) delete state[k];
  }
  let pulled = 0, pushed = 0, deletedL = 0, deletedR = 0, merged = 0, conflicts = 0, failed = 0, healed = 0, denied = 0, withdrawn = 0, deferred = 0;
  let uploadDenied = 0; // 쓰기 시도에서 난 실패 수(플랜 무관) — cycle이 전부 거절이면 회사 단위 백오프
  let held = 0; // 계정 키 미확보로 이번 사이클 불가시 보류된 암호화 대상 파일 수
  let missing = 0; const missingRels = []; // 매니페스트에만 있고 객체가 없는 항목(받을 내용 없음) — 실패가 아니라 건너뜀
  const failures = []; // 실패한 파일 이름·사유(앞 5개) — 상태·lastError·로그용
  const deletedRels = new Set(); // 이번 사이클에 내가 원격 삭제한 rel — 매니페스트 병합에서 재추가 금지
  // blob 실존 검사 — 매니페스트 항목 부재가 "삭제"인지 "동시 쓰기로 항목만 유실"인지 가르는 판별자.
  // 404만 "없음"이다. 타임아웃·5xx 등 확인 불가는 throw → per-file catch가 이번 사이클 보류(failed++).
  // "확인 불가 = 없음"으로 떨어뜨리면 네트워크 열화 시 이 방어가 역으로 오삭제를 만든다(검수 CRITICAL).
  // 판정 규칙은 위 매니페스트 읽기와 같은 isNotFound를 쓴다(단일 출처).
  const blobExists = async (key) => {
    const { error } = await client().storage.from(BUCKET).download(key, fresh()); // CDN 사본의 200은 이미 지운 blob을 '있음'으로 만든다
    if (!error) return true;
    if (isNotFound(error)) return false;
    throw new Error(`blob 확인 실패 — 삭제 보류(다음 사이클 재시도): ${String(error.message || error).slice(0, 80)}`);
  };

  const relFull = (rel) => {
    if (!safeRel(rel)) throw new Error(`안전하지 않은 동기화 키 차단(경로 탈출): ${String(rel).slice(0, 80)}`);
    return join(root, ...rel.split('/'));
  };
  const remoteKey = (rel) => skey(owner, wsId, rel);
  // 시크릿 봉투 — 밀 때 암호화, 받을 때 복호화. 스토리지엔 평문 크레덴셜이 절대 놓이지 않는다.
  // (복호화 실패 = 위변조/키 불일치 → throw → per-file catch가 failed로 집계, 다음 사이클 재시도)
  // mcp.json만 겸용 개봉(봉투 도입 전 평문 레거시 수용) — connections/.secrets는 처음부터 봉투라
  // 엄격 openSecret 유지(무결성 검증 유지, 검수 LOW-5). rel별로 개봉기를 가른다.
  // 읽기는 스위치와 무관하게 항상 봉투 개봉 가능 — 2단계 롤아웃의 핵심(다른 기기가 먼저 sealing을 켜도 안전).
  // 태생부터 봉투인 크레덴셜 2종만 엄격(깨진 평문 수용 금지), 그 외는 관용 개봉(기존 평문 그대로 통과 → 전환 무중단).
  /** 최근 객체 없음으로 확인한 항목(같은 원격 메타) — 다시 받으러 가지 않는다(GET 0). 진행 로그도 이 판정으로 '실제로 받으러 갈 파일'을 센다. */
  const missingFresh = (rel) => {
    const r0 = remote.files[rel], seen = missingSeen.get(`${owner}/${wsId}/${rel}`);
    return seen?.sig === (r0?.h ?? `${r0?.m}:${r0?.s}`) && Date.now() < seen.until;
  };
  /** 받기(네트워크)만 — 봉투 그대로 돌려준다. 받기 미리 하기는 이것만 앞당기고, 여는 것(openPulled)은 루프가 그 파일의 차례에 한다. */
  const pullRaw = async (rel, signal) => {
    // 최근 객체 없음으로 확인한 항목(같은 원격 메타)은 다시 받으러 가지 않는다 — 메타가 바뀌면(누가 다시 올림) 바로 다시 받는다.
    // 객체 없음은 어느 분기에서도 쓰기로 이어지지 않으므로(아래 catch가 missing으로 건너뜀) 기억이 낡아도 늦어질 뿐 덮어쓰지 않는다.
    const seenKey = `${owner}/${wsId}/${rel}`, r0 = remote.files[rel], sig = r0?.h ?? `${r0?.m}:${r0?.s}`;
    if (missingFresh(rel)) throw Object.assign(new Error('Object not found(최근 확인)'), { notFound: true });
    const b = await download(remoteKey(rel), signal).catch((e) => {
      if (e.notFound) missingSeen.set(seenKey, { sig, until: Date.now() + MISSING_RECHECK_MS });
      throw e;
    });
    missingSeen.delete(seenKey); // 받았으면 더는 빈 항목이 아니다
    return b;
  };
  /** 받은 봉투 열기 — 그 파일의 차례에 한다(미리 받은 파일도). 사이클 도중 열쇠(DEK)가 도착하면 종전처럼 그 뒤 차례의 파일부터 바로 열린다(분리 검수 26번). */
  const openPulled = (rel, b) => {
    // 회수 마커 — 다른 기기가 credSync를 껐다. throw → per-file catch가 failed로 보류하고, 이 기기도
    // 곧 company.json 동기화로 토글을 받아 불가시가 된다(로컬 자격은 그동안 그대로).
    // 안전성 자체는 마커 형식(무효 봉투 — openSecret이 어차피 throw)이 담보하므로 이 가드는 현재
    // 등가 변이다(분리 검수 LOW-B). 남기는 실익은 진단성 하나 — "형식 아님"이 아니라 원인을 말한다.
    if (isSecretRel(rel) && isCredWithdrawn(b)) throw new Error('자격 동기화 꺼짐(다른 기기에서 회수) — pull 보류');
    return (rel === 'connections.json' || rel === '.secrets.json') ? openSecret(b) : openSecretCompat(b);
  };
  const pullBuf = async (rel) => openPulled(rel, await pullRaw(rel));
  /** 업로드 직전 봉투 — 모든 업로드 경로가 이걸 거쳐야 평문이 새지 않는다(병합 분기 포함). */
  // E2EE 활성(이 기기가 DEK 보유) = 동기 대상 **전량**을 v3로 봉인 — 별도 스위치가 없다:
  // DEK 보유가 곧 스위치(디스크 사실에서 파생 원칙). 미보유 기기는 v2/평문 기존 동작 그대로(단계 0 불변).
  const sealFor = (rel, buf) => (dek() ? sealSecretV3(buf) : isEncRel(rel) ? sealSecret(buf) : buf);
  const pushBuf = async (rel) => sealFor(rel, await readFile(relFull(rel)));
  // A remote download can outlive a local import. Recheck the snapshot under the same
  // lock used by market/import writers before replacing or deleting the MCP file.
  const withMcpSnapshot = (rel, fn) => withDirLock(`${relFull(rel)}.lock`, async () => {
    let current = null;
    try { current = hashBuf(await readFile(relFull(rel))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (current !== (local[rel]?.h ?? null)) throw new Error('MCP changed during sync');
    return fn();
  });
  // 로컬 쓰기 — 스레드 파일이면 진행 중 턴과 직렬화(레이스 방지). 원자쓰기(tmp→fsync→rename)로
  // 크래시 시 파일이 잘려 '손상→삭제 오전파'로 번지는 것을 차단(.tmp-는 EXCLUDE라 원격에 안 샌다).
  // basedOn — 이 쓰기가 근거로 삼은 **로컬 파일의 해시**(없었다면 null, 확인을 끄려면 생략). 앱과 같은 폴더를 쓰는 argo CLI가 사이클 도중 같은 파일을
  // 고칠 수 있다(M-b ①) — 판정(매니페스트)은 낡았는데 원격본으로 덮으면 그 변경이 사라진다. 잠금 안에서 해시를 다시 비교해 달라졌으면 deferred로
  // 던진다(실패가 아니라 미룸: 다음 사이클이 양쪽 변경으로 보고 병합). 같은 폴더의 모듈 쓰기와 같은 `<file>.lockd`로 직렬화한다.
  const recheck = async (rel, basedOn) => {
    if (basedOn === undefined) return;
    let cur = null;
    try { cur = hashBuf(await readFile(relFull(rel))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (cur !== basedOn) throw Object.assign(new Error(`로컬 파일이 사이클 도중 바뀌었다 — 이번엔 건너뜀(다음 사이클 병합): ${rel}`), { deferred: true });
  };
  const cachedRels = walkFromCache.get(local) ?? new Set(); // 이번 걷기에서 해시를 캐시로 가져온 파일(내용을 이번에 읽지 않았다)
  const guarded = (rel, basedOn, fn) => {
    const run = async () => { await recheck(rel, basedOn); return fn(); };
    if (isThread(rel)) return withLock(threadLockKey(wsId, rel), run, { file: relFull(rel), mkParent: false });
    if (isFileLockedRel(rel)) return withFileLock(relFull(rel), run, { mkParent: false });
    // 판단 근거가 걷기 캐시의 해시면 덮거나 지우기 직전에 실제 내용으로 확인한다(잠금 없이 — 다르면 미룸, 걷기 캐시 주석). 캐시 없이 읽은 파일은 종전대로.
    if (basedOn != null && cachedRels.has(rel)) return run();
    return fn(); // 그 밖의 파일(원장 .jsonl·노트 등)은 종전대로 — **basedOn을 넘겨도 무시한다**(잠금·재확인은 스레드와 isFileLockedRel 파일뿐, 독립 검수 #800 LOW-7)
  };
  const writeLocal = async (rel, buf, mtime, basedOn) => {
    const doWrite = async () => {
      const full = relFull(rel);
      // 복호화된 시크릿(.secrets.json·connections)이 신규 기기 복원 시 0644로 생기지 않게 0600 강제(P1-8).
      await writeFileAtomic(full, buf, (isSecretRel(rel) || isSecretNameRel(rel)) ? { mode: 0o600 } : undefined); // 자격 파일명(.env·credentials.json…)도 0600
      if (mtime) {
        await utimes(full, new Date(mtime), new Date(mtime));
        // 원격 mtime을 심는 쓰기 — 기억 인덱스 캐시의 변경 판정 키가 mtime+size라, 심은 mtime과
        // 크기가 이전 행과 우연히 일치하면 캐시가 이 변경을 영영 못 본다(writeKeepingMtime과 같은
        // 계열, 검수 MEDIUM). 인덱스가 실제로 훑는 세 폴더로만 한정한다 — vault/ 전체로 걸면
        // 행도 없는 파일(_index.md·files/ 등)까지 건마다 DB 왕복 비용(실측 0.86ms/건)을 낸다.
        if (/^vault\/(journal|conversations|notes)\/[^/]+\.md$/.test(rel)) await invalidatePath(full);
      }
    };
    if (rel === 'mcp.json') await withMcpSnapshot(rel, doWrite);
    else await guarded(rel, basedOn, doWrite);
  };
  const rmLocal = async (rel, basedOn) => {
    if (rel === 'mcp.json') await withMcpSnapshot(rel, () => rm(relFull(rel), { force: true }));
    else await guarded(rel, basedOn, () => rm(relFull(rel), { force: true }));
  };
  // 로컬 파일이 사라졌지만 같은 자리에 .corrupt- 백업이 있으면 — 사용자 삭제가 아니라 로컬 손상(readJson이 치워둠).
  // 삭제 전파 대신 원격 정상본으로 self-heal 하고, 소비한 백업은 정리한다(잔존 시 이후 정당한 삭제를 손상으로 오인 — 재검수 지적).
  const corruptBackups = async (rel) => {
    try {
      const full = relFull(rel);
      const bn = basename(full);
      const dir = dirname(full);
      return (await readdir(dir)).filter((n) => n.startsWith(`${bn}.corrupt-`)).map((n) => join(dir, n));
    } catch { return []; }
  };
  const changed = (a, b) => !a || !b || (a.h ?? `${a.m}:${a.s}`) !== (b.h ?? `${b.m}:${b.s}`);

  // 로컬 삭제 직전 매니페스트 재확인 — 매니페스트를 정상으로 읽은 사이클에서도 blob 확인의 '없음'이 잘못 분류됐을 수 있다.
  // 삭제 후보가 처음 나올 때 한 번만(사이클당 GET 1건, 후보가 없으면 0건) 매니페스트 키를 다시 읽어 성공할 때만 '없음'을 믿는다.
  // 오류든 '없음'이든 읽지 못하면 사이클 전체를 보류한다(holdCycle — 파일 단위 실패로 두면 그 항목이 state에서 빠진다). (분리 검수 F2-2)
  let manifestRecheck = null;
  const confirmManifest = () => (manifestRecheck ??= (async () => {
    const { error } = await client().storage.from(BUCKET).download(manifestKey, fresh()); // CDN 사본의 200은 지워진 매니페스트를 '있음'으로 만든다
    if (error) throw Object.assign(new Error(`로컬 삭제 전 매니페스트 재확인 실패 — 동기화 보류: ${String(error.message || error).slice(0, 80)}`), { holdCycle: true });
  })());

  // credSync off 회수 — 클라우드에 남은 자격 암호문의 **활성 사본**을 마커로 덮고(플랫폼 백업·스냅샷의
  // 과거 사본 보존까지는 보장 못 함 — docs/privacy-sync.md에 같은 한계를 고지) 매니페스트에서
  // 내린다. **remove 금지**: blob 부재는 토글 미반영 기기(구버전 포함)의 `l && !r` 분기에서 "다른 기기가
  // 지움 → 로컬도 삭제"로 이어져 그 기기의 로컬 자격을 지운다. blob(마커)이 실존하면 그 기기들은
  // blobExists → heal(항목 복원)을 타 로컬을 보존한다(위 lost-update 방어와 같은 경로 — PIN2가 잠근다).
  // 마커 upsert 실패 시 항목을 남겨 다음 사이클 재시도 — 그동안 diff는 아래 불가시 가드가 스킵한다.
  if (noSecrets) {
    for (const rel of Object.keys(remote.files)) {
      if (!isSecretRel(rel)) continue;
      try {
        await upload(remoteKey(rel), CRED_WITHDRAWN);
        delete remote.files[rel]; deletedRels.add(rel); withdrawn++; // deletedRels: 재읽기 병합의 재추가 금지
      } catch { /* 실패 — 항목 유지(다음 사이클 재시도) */ }
    }
  }

  // 회의록 충돌 카드·기기 로컬 상태(.local-assets·.assistant)는 집합에서 빼 불가시 — 아래 브레이크 집계·전파 루프가 같은 집합을 돌므로 한 곳이면 된다(isRoomCardRel 주석).
  const allRels = new Set([...Object.keys(local), ...Object.keys(remote.files), ...Object.keys(state)].filter((rel) => !isRoomCardRel(rel) && !isLocalImportRel(rel) && !isAssistantStateRel(rel) && !isTurnTraceRel(rel)));
  // 크기 제한을 넘는 파일(SYNC_MAX_OBJECT_BYTES 주석) — 개발 산출물과 같은 diff 불가시: 올리기·받기·삭제 전파·브레이크 집계·사전 확인 전부 건너뛰고 실패로 세지 않는다.
  // 로컬이든 원격 항목이든 한쪽이 크면 그렇다 — 원격에 예전 작은 판이 있던 파일이 커져도 원격을 덮거나 지우지 않고(다른 기기는 작은 판 그대로),
  // 로컬의 큰 파일도 원격 변경·삭제로 덮거나 지우지 않는다. base(state)는 아래 nextFiles 규칙대로 종전 값이 남는다. 단일 출처 — 아래 모든 자리가 이 집합을 본다.
  const oversize = new Set([...allRels].filter((rel) => !(noSecrets && isSecretRel(rel)) && !isDevArtifactRel(rel) && [local[rel], remote.files[rel]].some((x) => x && tooBigToSync(x.s))));

  const archMoves = archivalCreateNames(local, state); // .archive→.trash 이동의 목적지 basename
  // 로컬 손상(readJson이 .corrupt-로 치워둠)으로 '부재'가 된 삭제 후보 — 삭제가 아니라 self-heal 대상.
  // 브레이크 집계와 전파가 동일하게 이 판정을 참조하도록 한 번만 계산(불일치 시 대량 동시손상이 sync를 멈춰 복구까지 막던 지적 반영).
  const corruptHeal = new Set(); // 로컬 손상으로 부재가 된 삭제 후보 rel — self-heal 대상(브레이크·전파 공통 참조)
  for (const rel of allRels) {
    const l = local[rel], r = remote.files[rel], base = state[rel];
    if (!l && r && base && !changed(base, r) && !isUnderFailed(rel, failedDirs) && (await corruptBackups(rel)).length) {
      corruptHeal.add(rel);
    }
  }
  // 삭제 판별 단일 출처 — 브레이크 집계와 실제 전파가 같은 규칙을 쓴다(불일치가 M2 회귀의 원인이었다).
  // side 'L'=로컬 삭제 예정, 'R'=원격 삭제 예정. walk 실패 subtree·로컬 손상·아카이브 '이동'(짝 있음)은 삭제가 아니다.
  const isRealDelete = (rel, l, r, base, side) => {
    if (isEncRel(rel) && !cryptoOn()) return false;
    if (isDevArtifactRel(rel)) return false; // 개발 산출물 — diff 불가시(isDevArtifactRel 주석), 브레이크 집계 제외
    if (oversize.has(rel)) return false; // 크기 제한 초과 — diff 불가시(oversize 주석), 브레이크 집계 제외

    // credSync off — 자격은 diff 루프가 스킵하므로 삭제가 실행되지 않는다. 집계도 같은 규칙(단일 출처):
    // 마커 upsert 실패로 항목이 남은 사이클에 브레이크가 "삭제 예정"으로 오집계해 보류되는 것 방지.
    // (심층 방어 — 테스트 미커버(분리 검수 LOW-1): 브레이크 발화엔 base가 3 이하여야 해 실회사에서
    //  사실상 도달 불가지만, 집계·전파 동일 규칙 불변식을 지키기 위해 유지한다.)
    if (noSecrets && isSecretRel(rel)) return false;
    // 디스크 큐 잔재(.gw-queue-*/) — EXCLUDE 전환(픽스 전엔 잡 파일이 동기화됐다)의 원격 청소는
    // 회사 데이터 삭제가 아니다. 브레이크 '집계'에서만 제외해, 잔재가 많던 회사의 동기화가
    // 대량삭제 오탐으로 영구 보류되는 것을 막는다(전파 루프는 그대로 원격 잔재를 정리한다 —
    // 집계·전파 동일 규칙 원칙의 의도된 예외, 검수 MEDIUM).
    if (rel.split('/')[0].startsWith('.gw-queue')) return false;
    if (isUnderFailed(rel, failedDirs)) return false;                        // walk가 못 읽음 → 부재는 unknown
    if (corruptHeal.has(rel)) return false;                                   // 로컬 손상 → self-heal 대상(삭제 아님)
    if (isArchival(rel) && archMoves.has(rel.split('/').pop())) return false; // 진짜 이동(목적지 생성 있음)
    return side === 'L' ? !!(l && !r && base && !changed(base, l))
                        : !!(!l && r && base && !changed(base, r));
  };

  // 대량 삭제 브레이크 — 한 사이클이 회사 파일 대부분을 지우려 하면 중단(원격 오판·레이스·walk 실패 방어).
  // 삭제는 비가역이라 "보류"가 항상 안전. 의도된 대량 삭제만 env로 명시 허용.
  {
    const baseCount = Object.keys(state).length;
    let delL = 0, delR = 0;
    for (const rel of allRels) {
      const l = local[rel], r = remote.files[rel], base = state[rel];
      if (isRealDelete(rel, l, r, base, 'L')) delL++;
      if (isRealDelete(rel, l, r, base, 'R')) delR++;
    }
    if (process.env.ARGO_SYNC_ALLOW_MASS_DELETE !== '1' && (massDeleteBrake(delL, baseCount) || massDeleteBrake(delR, baseCount))) {
      throw new Error(`대량 삭제 감지(로컬 ${delL}·원격 ${delR} / base ${baseCount}) — 동기화 보류. 의도면 ARGO_SYNC_ALLOW_MASS_DELETE=1`);
    }
  }

  // 매니페스트가 없는 사이클의 '다른 기기가 지웠다' 후보(기록 있음·무변경·원격 항목 없음) — 매니페스트가 없으면 그 추론이 성립하지 않는다
  // (정리된 원격·끊긴 첫 동기화). blob이 있으면 아래 루프가 main처럼 항목을 되살린다(치유). blob까지 없으면 지우지도 다시 밀지도 않고
  // 사이클 전체를 보류한다 — 다시 밀면 옛 사본 기기가 먼저 들어와 최신 기기의 편집·파일을 덮거나 지운다(최종 검수 HIGH, 기기 2대 재현).
  // 보류 판정은 어떤 업로드보다 먼저다. 확인 결과는 루프가 다시 쓴다(blob GET은 main처럼 후보당 최대 1건). 확인 오류는 main처럼 그 파일만 실패.
  const blobProbe = new Map();
  if (!manifestExists) {
    for (const rel of allRels) {
      if ((noSecrets && isSecretRel(rel)) || isDevArtifactRel(rel) || oversize.has(rel) || (isEncRel(rel) && !cryptoOn())) continue; // 아래 루프와 같은 불가시
      const l = local[rel], base = state[rel];
      if (!(l && !remote.files[rel] && base && !changed(base, l))) continue;
      const probe = blobExists(remoteKey(rel));
      blobProbe.set(rel, probe);
      if ((await probe.catch(() => true)) === false) {
        throw new Error('클라우드 사본이 비어 있어 이 회사 동기화를 멈췄습니다 — 이 기기 파일은 지우지도 다시 올리지도 않습니다');
      }
    }
  }

  // 받기 미리 하기(PULL_CONCURRENCY 주석) — 판정이 '원격 신규 → 받기'(로컬·기록 없음, walk 실패 subtree 아님)·'원격만 변경 → 받기'(양쪽 있음, 원격만 기록과 다름)인
  // 파일의 pullBuf(같은 개봉·같은 오류)를 아래 루프 순서대로 상한 있는 동시 실행으로 앞당긴다. 대상 조건은 루프의 불가시 가드·분기 조건 그대로다.
  // 쓰기·판정·카운터·충돌 처리는 루프가 종전 순서대로 하고, 쓰기 직전 재확인(recheck·withMcpSnapshot)도 쓰는 그 순간에 한다 — 미리 받은 뒤 로컬이 바뀌면 종전처럼 미루거나 실패.
  // 받기 실패는 그 파일의 차례에 같은 오류 객체로 던져져 아래 catch가 종전처럼 나눈다(객체 없음 = missing, 만료 토큰·5xx = failed, 업로드 태그 없음).
  // 브레이크·사전 확인(위)이 사이클을 멈출 수 있는 판정을 모두 끝낸 뒤에 시작한다 — 멈출 사이클의 받기를 미리 하지 않는다.
  const pullRels = [];
  for (const rel of allRels) {
    if ((noSecrets && isSecretRel(rel)) || isDevArtifactRel(rel) || oversize.has(rel) || (isEncRel(rel) && !cryptoOn())) continue; // 아래 루프와 같은 불가시
    const l = local[rel], r = remote.files[rel], base = state[rel];
    if (!r) continue;
    if (l ? (changed(base, r) && !changed(base, l)) : (!base && !isUnderFailed(rel, failedDirs))) pullRels.push(rel);
  }
  const linkKey = `${owner}/${wsId}`;
  const slowLink = (slowLinks.get(linkKey) ?? 0) > Date.now(); // 최근 이 회사에서 동시 받기가 시간 초과를 냈다 — 하나씩 받는다
  const ahead = createPrefetch(pullRels, pullRaw, { // 받기만 앞당긴다 — 여는 것은 그 파일의 차례에(openPulled)
    concurrency: slowLink ? 1 : PULL_CONCURRENCY, maxAhead: PULL_AHEAD_MAX, maxBytes: PULL_AHEAD_BYTES,
    maxInflightBytes: PULL_INFLIGHT_BYTES, soloBytes: PULL_SOLO_BYTES, isSlow: isTimeoutError,
    sizeOf: (rel) => { const s = Number(remote.files[rel]?.s); return Number.isFinite(s) && s >= 0 ? s : PULL_AHEAD_BYTES; }, // 크기 모름 = 혼자 받는다
  });
  // 진행 로그 — 받을 것이 많은 사이클(첫 동기화)은 끝날 때까지 다른 로그가 없어 멈춘 것처럼 보인다. 시작·몇십 초마다·끝에 한 줄.
  // 수는 '실제로 받으러 갈 파일'(최근 객체 없음으로 확인한 항목 제외 — GET이 안 나간다)만 세고, 받음·실패·없음을 따로 센다(분리 검수 MEDIUM-1).
  const getting = new Set(pullRels.filter((rel) => !missingFresh(rel)));
  const showProgress = getting.size >= PULL_PROGRESS_MIN;
  const tally = { got: 0, failed: 0, gone: 0 };
  let progressAt = 0;
  const progressLine = () => `받음 ${tally.got} · 실패 ${tally.failed} · 없음 ${tally.gone}`;
  const noteProgress = () => { progressAt = Date.now(); console.log(`[argo] 동기화(${wsId}): 파일 ${getting.size}개 받는 중 (${tally.got + tally.failed + tally.gone}/${getting.size} — ${progressLine()})`); };
  if (showProgress) noteProgress();
  const pullAhead = async (rel) => {
    let outcome = 'failed';
    try { const b = openPulled(rel, await ahead.take(rel)); outcome = 'got'; return b; } // 열기까지 돼야 '받음' — 못 열면 루프 catch와 같이 실패
    catch (e) { outcome = e?.notFound ? 'gone' : 'failed'; throw e; }
    finally {
      if (getting.has(rel)) { tally[outcome]++; if (showProgress && Date.now() - progressAt >= PULL_PROGRESS_MS) noteProgress(); }
    }
  };

  for (const rel of allRels) {
    // credSync off — 자격 3종은 push/pull/삭제 전파 전부 불가시. 회수(마커 upsert)는 위 단계가 전담하고,
    // 여기서 real-delete로 흐르면 blob remove가 나가 미반영 기기의 로컬 자격 오삭제로 이어진다(가드 필수).
    // held 집계보다 앞에 둔다 — 어차피 안 올라가는 자격이 키 미확보 사이클에 "보류 1개"로 거짓 표시되던 것(#436 2차 검수 LOW-B).
    if (noSecrets && isSecretRel(rel)) continue;
    if (isDevArtifactRel(rel)) continue; // 개발 산출물 — diff 불가시(isDevArtifactRel 주석): push·pull·삭제 전파 전부 스킵, held 미집계(키 미확보와 다른 성격)
    if (oversize.has(rel)) continue; // 크기 제한 초과 — diff 불가시(oversize 주석): 실패로 세지 않는다(같은 거절을 매 사이클 다시 시도하지 않는다). 결과의 oversize로 알린다
    if (isEncRel(rel) && !cryptoOn()) { held++; continue; } // 키 미확보 사이클 — 암호화 대상은 diff 자체에서 불가시(삭제 오인 차단). held로 표면화(#436 HIGH-2)
    const l = local[rel], r = remote.files[rel], base = state[rel];
    if (!l && !r) continue; // state에만 남은 항목(EXCLUDE 전환·타기기 선정리) — 사이클 말미 state 갱신이 정리한다
    const localChg = changed(base, l);   // base 대비 로컬 변경(생성/수정/삭제)
    const remoteChg = changed(base, r);   // base 대비 원격 변경
    try {
      // ── 삭제 전파 ──
      if (!l && r) { // 로컬에 없음
        if (isUnderFailed(rel, failedDirs)) continue; // walk가 subtree를 못 읽음 — 부재는 unknown(삭제 아님), 보류
        let revived = false;
        if (base && !remoteChg) { // 삭제로 보임 — 단 로컬 손상(.corrupt-)이면 삭제가 아니라 복구
          if (corruptHeal.has(rel)) { // 로컬 손상 → 원격 정상본을 받아 self-heal
            await writeLocal(rel, await pullBuf(rel), r.m, null); local[rel] = r; pulled++; conflicts++; revived = true;
          } else { // 진짜 삭제 → 원격도 삭제. remove 실패면 항목을 유지하고 보류 — 항목만 지우고 blob이
            // 살아남으면 blob 실존 검사가 이 삭제를 '매니페스트 유실'로 오판해 부활시킨다(검수 HIGH).
            const { error: rmErr } = await client().storage.from(BUCKET).remove([remoteKey(rel)]);
            if (rmErr) throw new Error(`원격 blob 삭제 실패 — 보류: ${String(rmErr.message || rmErr).slice(0, 80)}`);
            delete remote.files[rel]; deletedR++; deletedRels.add(rel); // 매니페스트 병합에서 재추가 금지
          }
        } else if (!base) { // 원격 신규 → 받기(미리 받아 둔 것)
          await writeLocal(rel, await pullAhead(rel), r.m, null); local[rel] = r; pulled++; revived = true;
        } else { // 내가 지웠지만 원격도 바뀜 = 충돌 → 원격 부활본을 받아 유실 방지
          await writeLocal(rel, await pullBuf(rel), r.m, null); local[rel] = r; pulled++; conflicts++; revived = true;
        }
        // 원격에서 로컬을 복원한 경우 — 이 자리에 남아있던 손상 백업은 잉여. 어느 복원 경로(self-heal·신규·충돌복구)든
        // 청소해, 잔존 백업이 이후 정당한 삭제/리셋을 손상으로 오인해 되살리는 것을 막는다(재검수 잔여 지적).
        if (revived) for (const b of await corruptBackups(rel)) await rm(b, { force: true }).catch(() => {});
        continue;
      }
      if (l && !r) { // 원격에 없음
        if (base && !localChg) {
          // 매니페스트 lost-update 방어 — 진짜 삭제(다른 기기의 삭제 전파)는 blob도 함께 지워져 있다.
          // blob이 살아 있으면 동시 동기화 중인 기기가 매니페스트를 통째로 덮어써 항목만 유실된 것
          // (실측: 영입 직후 크루 카드가 8초 안에 오삭제) → 지우지 말고 항목을 복원한다(자기치유).
          // 매니페스트 없는 사이클의 blob 없음은 위 사전 확인이 이미 보류했다. 지우기 직전 매니페스트를 한 번 더 읽어 확인한다(confirmManifest —
          // 매니페스트가 없으면 여기서도 보류). 실측 2026-10-05: 만료 토큰 읽기가 없음으로 분류되자 이 분기가 로컬 파일을 지웠다(재현 테스트).
          if (await (blobProbe.get(rel) ?? blobExists(remoteKey(rel)))) { remote.files[rel] = base; healed++; }
          else { await confirmManifest(); await rmLocal(rel, l.h); delete local[rel]; deletedL++; } // 다른 기기가 지움 → 로컬도(매니페스트 재확인 뒤)
        }
        else { await upload(remoteKey(rel), await pushBuf(rel)); remote.files[rel] = l; pushed++; } // 신규/수정 → 밀기
        continue;
      }
      // ── 양쪽 존재 ──
      if (!localChg && !remoteChg) {
        // E2EE 재봉인 — 켠 직후 1회, 무변경 파일도 원격 blob을 v3로 되덮는다(메타·base 불변이라
        // 다른 기기의 diff 판정에 영향 없음 — blob 세대만 교체. 이게 없으면 옛 평문/v2 사본이
        // 클라우드에 영구 잔존해 "본인만 연다"가 신규 파일에만 성립한다).
        if (opts.reseal) { await upload(remoteKey(rel), await pushBuf(rel)); pushed++; }
        continue;
      }
      if (remoteChg && !localChg) { // 원격만 변경 → 받기(미리 받아 둔 것)
        await writeLocal(rel, await pullAhead(rel), r.m, l.h); local[rel] = r; pulled++; continue;
      }
      if (localChg && !remoteChg) { // 로컬만 변경 → 밀기
        await upload(remoteKey(rel), await pushBuf(rel)); remote.files[rel] = l; pushed++; continue;
      }
      // ── 양쪽 변경 = 충돌 ──
      if ((l.h ?? '') === (r.h ?? '')) { // 내용이 우연히 같아짐 → 상태만 정렬
        remote.files[rel] = l; continue;
      }
      const localBuf = await readFile(relFull(rel));
      const remoteBuf = await pullBuf(rel); // 객체 없음이면 catch가 missing으로 건너뛴다 — 편집본은 로컬에 그대로(아래 catch 주석)
      if (isLedger(rel)) { // 원장 — 행 합집합 병합 후 양쪽 수렴
        const mBuf = mergeLedger(localBuf, remoteBuf);
        await writeLocal(rel, mBuf, undefined, hashBuf(localBuf)); // 원장은 재확인 대상이 아니라 이 인자는 무시된다(guarded 주석) — 형식을 맞춰 둘 뿐
        await upload(remoteKey(rel), sealFor(rel, mBuf));
        local[rel] = { m: Date.now(), s: mBuf.length, h: hashBuf(mBuf) };
        remote.files[rel] = local[rel]; merged++;
      } else if (isThread(rel)) { // 스레드 blob — 메시지 배열 union 병합(양쪽 turn 보존), 스칼라는 최근 편집 쪽
        const mBuf = mergeThread(localBuf, remoteBuf, (r.m ?? 0) >= (l.m ?? 0) ? 'remote' : 'local');
        await writeLocal(rel, mBuf, undefined, hashBuf(localBuf));
        await upload(remoteKey(rel), sealFor(rel, mBuf));
        local[rel] = { m: Date.now(), s: mBuf.length, h: hashBuf(mBuf) };
        remote.files[rel] = local[rel]; merged++;
      } else if (isText(rel)) { // 텍스트 — 원격을 정본으로 받고, 로컬본은 .conflict로 보존(양쪽 유실 없음)
        // ⚠ 순서 불변식(2026-07-30): **로컬 정합을 먼저 끝내고, 사본 '발행'(업로드)을 맨 뒤에** 둔다.
        // 업로드가 먼저면 그게 실패할 때 디스크는 로컬본인데 base(=remote.files[rel], 원격본)는 "원격본을
        // 받았다"고 주장하는 거짓 base가 남는다. 그러면 다음 사이클이 '로컬만 변경'으로 읽어 로컬본을
        // 원격에 밀어 **다른 기기의 편집이 어디에도 남지 않는다**(격리 재현: free 사이클 뒤 Pro 승격 1회에
        // 원격본 소멸). 로컬본은 바로 위 writeLocal(cRel)로 이미 디스크에 있으니, 업로드를 뒤로 미뤄도
        // 잃는 것이 없다 — 실패 시 사본은 base에 없는 로컬 전용 파일로 남아 다음 기회에 신규로 push된다.
        const cRel = rel.replace(/\.md$/, `.conflict-${me}-${Date.now()}.md`);
        await writeLocal(cRel, localBuf);
        await writeLocal(rel, remoteBuf, r.m, hashBuf(localBuf));
        local[rel] = r; local[cRel] = { m: Date.now(), s: localBuf.length, h: hashBuf(localBuf) };
        pulled++; conflicts++;
        await upload(remoteKey(cRel), sealFor(cRel, localBuf));
        remote.files[cRel] = local[cRel];
      } else { // 기타(json 등) — 최근 mtime 승(LWW), 단 카운트해 관측 가능하게
        if ((r.m ?? 0) >= (l.m ?? 0)) { await writeLocal(rel, remoteBuf, r.m, hashBuf(localBuf)); local[rel] = r; pulled++; }
        else { await upload(remoteKey(rel), sealFor(rel, localBuf)); remote.files[rel] = l; pushed++; }
        conflicts++;
      }
    } catch (e) {
      if (e?.holdCycle) { await ahead.stop(); throw e; } // 삭제 근거를 확인 못 함 — 이 사이클 전체 보류(매니페스트·state 쓰기 없음). 미리 받던 요청은 멈추고(abort) 끝나기를 기다린다
      if (e?.deferred) { deferred++; continue; } // 로컬이 사이클 도중 바뀜 — 실패가 아니라 미룸(base 그대로라 다음 사이클이 양쪽 변경으로 병합·재판정)
      // 매니페스트에는 있는데 객체가 없다(받을 내용이 없음) — 실패가 아니다. 항목은 지우지 않는다: 그 파일을 가진 기기는 항목이 빠지는 순간
      // '다른 기기가 지웠다'로 읽어 로컬 사본을 지운다(2026-09-15 Storage 정리가 객체만 지우고 매니페스트를 남긴 이유). 건너뛰고 상태에만 남긴다.
      // 충돌(양쪽 변경)이어도 내 편집본을 밀지 않는다 — 항목이 내 base보다 새롭다는 건 더 새 판을 가진 기기가 있을 수 있다는 뜻이고, 밀면 그 기기가
      // 내 판을 받아 자기 최신본을 조용히 잃는다(분리 검수 2차 HIGH-1). 편집본은 로컬에 남고, 누가 그 파일을 다시 올리면 종전 충돌 처리로 수렴한다.
      // 항목이 내 base 그대로인 파일을 고친 경우는 위 '로컬만 변경 → 밀기'가 객체를 되살린다(기록된 새 판이 없으니 안전).
      if (e?.notFound) { missing++; if (missingRels.length < 5) missingRels.push(rel); continue; }
      // free의 **쓰기 실패는 실패가 아니라 이 플랜의 정상 결과**다(클라우드 쓰기 자체가 금지) — 분리 집계한다.
      // 뭉뚱그리면(전부 failed) 한 번도 성공 동기화한 적 없는 free 회사(체험 만료 후 첫 동기화·state
      // 유실·손상)가 영구 미완에 고착한다: 로컬 전용 파일 하나만 있어도 failed>0 → 아래 매니페스트
      // 관용(failed===0) 불충족 → throw → state 영구 미기록 → 매 사이클(8s) 재시도. 그 대가로
      // ① isText 분기가 .conflict-*.md를 로컬에 써서 8초마다 증식하고
      // ② lastError가 RLS 원문으로 고정돼 설정 카드의 업그레이드 버튼이 가려졌다
      // (#189 분리 검수 MEDIUM-I — main 선재 결함). 관용해 state를 쓰면 다음 사이클부터
      // 회사 스킵(syncStateExists)이 걸려 파일 루프 자체가 안 돈다.
      // 유실 없음: 못 민 파일은 remote.files에 안 들어가므로 base에도 없다 → Pro 승격 사이클에
      // '신규'로 정상 push된다(#189 검수 D 논리).
      // 관용 범위는 아래 매니페스트 분기와 **같은 규칙**이다(원인 무관·free 한정) — 원인으로 좁히면
      // free의 간헐 5xx 하나가 다시 state 미기록 고착을 만들어 위 증식 결함이 그 창으로 되돌아온다.
      // 실패 가시성은 게이트가 지킨다: opts.freePlan이 없으면(pro·미확인) 쓰기 실패도 전부 failed이고,
      // pull(download) 실패는 uploadFailed 태그를 못 받으므로 어느 플랜에서도 관용되지 않는다.
      if (e?.uploadFailed) uploadDenied++;
      if (e?.uploadFailed && opts.freePlan) denied++; else failed++; // 파일 하나 실패는 다음 사이클이 재시도
      // 실패로 센 것만 이름·사유를 남긴다. 회사 폴더 경로와 원자 쓰기 임시 파일의 pid·시각·순번 꼬리(jsonstore writeFileAtomic)는 뗀다 —
      // 꼬리가 남으면 같은 실패도 주기마다 사유가 달라져 '바뀔 때만 한 줄'인 로그가 재시도마다 새 줄을 쓴다(격리 서버 실측 10/5).
      if (!(e?.uploadFailed && opts.freePlan) && failures.length < 5) failures.push({ rel, reason: String(e?.message ?? e).split(root + sep).join('').replace(/(\.tmp-[^'"]*)-\d+-[0-9a-z]+-\d+(?=['"])/g, '$1').slice(0, 120) });
    }
  }
  await ahead.stop(); // 보통은 모두 꺼내 가서 할 일이 없다 — 꺼내 가지 않은 결과가 남았으면 버린다(요청이 사이클 밖으로 새지 않게)
  if (ahead.degraded) { slowLinks.set(linkKey, Date.now() + SLOW_LINK_MS); console.warn(`[argo] 동기화(${wsId}): 여러 파일을 함께 받다 시간 초과 — 이 회사는 ${SLOW_LINK_MS / 60_000}분 동안 하나씩 받습니다`); }
  if (showProgress) console.log(`[argo] 동기화(${wsId}): 파일 ${getting.size}개 받기 끝 — ${progressLine()}`);

  // 매니페스트 재읽기 병합 — 매니페스트는 whole-file 덮어쓰기(LWW)라, diff를 도는 동안 다른 기기가
  // 올린 신규 항목을 병합 없이 덮으면 그 항목이 유실되고, 그 기기의 base에는 남아 다음 사이클에
  // '원격에서 삭제됨'으로 오판돼 파일이 지워진다(실측: 영입 직후 크루 카드 오삭제). 재읽기로 경합
  // 창을 ms 단위로 줄이고, 남는 창은 위 blob 실존 검사가 최종 방어한다.
  // 주의: 병합 항목은 업로드 매니페스트에만 넣고 내 base(state)에는 넣지 않는다 — base에 넣으면
  // "로컬에 없는데 base에 있음 = 내가 지움"으로 오판해 다음 사이클에 원격 삭제를 전파해 버린다.
  // base에 없으니 다음 사이클에 '원격 신규 → 받기'로 정상 pull된다.
  let manifestDenied = false;
  // Unchanged remote probe: one full GET, zero PUTs. The outer 60s idle gate bounds
  // steady-state to 1,440 manifests/day/device/company; 100 × 420KB ≈ 60.5GB/day.
  // This is a bound, not a scalable replacement for a revision/conditional index.
  // No write means no lost-update window requiring a second GET. Resealing must write.
  // 복원(isRestore)도 예외가 아니다 — 받기만 한 복원은 원격 목록을 바꾸지 않는다. 복원이면 무조건 쓰던 때, 파일 없는 빈 원격 회사(company.json이 없어
  // 로컬 회사가 되지 못하고 발견 주기마다 다시 복원된다)가 기기마다 5분에 한 번 매니페스트를 다시 썼다(2026-10-05 lean-company-kqav 실측: 시간당 GET 24·POST 12).
  // 그리고 매니페스트가 없는 원격을 받을 것 없이 복원한 기기(쓸 항목 0)는 빈 매니페스트를 쓰지 않는다 — 빈 {files:{}}가 생기면 다른 기기가
  // '매니페스트 있음 + 항목 없음 + blob 없음'을 '다른 기기가 지웠다'로 읽어 못 민 파일을 지운다(3차 검수 2번 재현). 올린 파일이 있으면 main처럼 쓴다.
  if (!(isRestore && !manifestExists && Object.keys(remote.files).length === 0) && (!manifestExists || manifestNeedsSeal || opts.freePlan || opts.reseal || failed || originalFiles !== JSON.stringify(remote.files))) {
  const uploadFiles = { ...remote.files };
  {
    // 재읽기는 두 단계로 갈라 관용의 범위를 정확히 한다(분리 검수 HIGH-1):
    // ① 네트워크 실패 = 기존 관용(병합 없이 진행). ② **받았는데 열 수 없는 봉투 세대** = 관용 금지 —
    // 사이클 시작 후 다른 기기가 세대를 올린 것(E2EE 켬 등)이고, 이대로 아래에서 내(구세대) 매니페스트를
    // 쓰면 게이트가 평문으로 되돌아간다(실증: 열쇠 없는 기기의 정상 사이클 하나가 v3 매니페스트를
    // 평문으로 다운그레이드). 이번 사이클 전체를 보류해 세대를 지킨다 — 다음 사이클 초기 읽기가
    // 같은 세대를 만나 정식 잠김(보류) 경로로 수렴한다.
    let freshBuf = null;
    try {
      const { data } = await client().storage.from(BUCKET).download(manifestKey, fresh());
      if (data) freshBuf = Buffer.from(await data.arrayBuffer());
    } catch { /* 재읽기 네트워크 실패 — 병합 없이 진행(남는 경합은 blob 검사가 방어, 다음 사이클 self-heal) */ }
    if (freshBuf) {
      let fresh = null;
      try { fresh = JSON.parse(openSecretCompat(freshBuf).toString()); }
      catch (e) {
        if (isEnvelopeGeneration(freshBuf)) {
          throw new Error(`매니페스트 세대 상승 감지(다른 기기가 암호화를 켬) — 이번 사이클 보류: ${String(e.message).slice(0, 60)}`);
        }
        /* 평문 손상 등 — 기존 관용: 병합 없이 진행 */
      }
      for (const [rel, meta] of Object.entries(fresh?.files ?? {})) {
        if (!(rel in uploadFiles) && !deletedRels.has(rel) && safeRel(rel)) {
          // 다른 기기가 "삭제 진행 중"(blob은 지웠고 매니페스트 drop 전)인 항목을 되살리면 그 삭제가
          // 미전파되고 죽은 항목이 남는다(검수 MEDIUM) — blob이 실존할 때만 병합, 확인 불가면 생략
          // (그 기기의 다음 매니페스트 업로드가 자체 반영하므로 유실 없음).
          try { if (await blobExists(remoteKey(rel))) uploadFiles[rel] = meta; } catch { /* 생략 */ }
        }
      }
    }
  }
  // 매니페스트도 봉투 대상(E-b) — 경로(노트 제목)만으로 맥락이 새므로. 읽기 두 지점이 관용 개봉이라
  // 스위치 off 기기도 안전하게 읽는다. off면 평문 그대로(동작 불변).
  const manifestBuf = Buffer.from(JSON.stringify({ ...remote, files: uploadFiles }));
  // cryptoOn() 동반 확인(보안 검수 2026-07-23) — 파일 경로의 가드(`isEncRel && !cryptoOn()` continue)와 동일 규약.
  // 키 미확보 사이클에 sealSecret이 throw해 동기화가 멈추던 비대칭 제거(데이터 위험은 없었으나 가용성 문제).
  try {
    // E2EE 활성이면 매니페스트도 v3 — 이것이 곧 **열쇠 없는 기기의 안전 게이트**다: DEK 미보유 기기는
    // 매니페스트 개봉이 보류 오류로 떨어져 회사 동기화가 통째로 멈춘다(파일 단위 오염·오삭제 원천 불가,
    // 기존 "매니페스트 읽기 실패 — 삭제 보류" 경로 재사용). 구버전(전방 게이트 없는 ≤0.1.51)도 매니페스트
    // JSON 파싱 실패로 같은 보류에 떨어진다 — 켜기 전 전 기기 업데이트 안내는 라우트·UI가 담당.
    // 매니페스트(메타데이터)는 계정 키만 있으면 옵트아웃(ARGO_ENC_VAULT=0) 기기도 v2로 쓴다 — 평문으로 되돌리면 ≤v0.1.23 클라이언트가
    // "평문 매니페스트 + v2 파일" 혼합을 만나 v2 노트를 암호문 그대로 로컬에 기록한다(#436 검수 MEDIUM-4 실코드 재현). v2 매니페스트면 그 버전은 파싱 실패로 보류(fail-closed).
    await upload(manifestKey, dek() ? sealSecretV3(manifestBuf) : cryptoOn() ? sealSecret(manifestBuf) : manifestBuf);
  } catch (e) {
    // free 복원의 완결 처리(재검수 HIGH-E) — pull은 전부 끝났는데 매니페스트 업로드만 RLS에 거부되면,
    // 여기서 throw할 경우 state가 영영 안 써져 복원이 영구 restoring이 된다(지운 노트가 8초마다 부활,
    // lastError가 RLS 원문으로 고정돼 업그레이드 버튼 은폐). pull 실패가 없을 때만 관용 — state를 쓰면
    // 다음 사이클부터 회사 스킵(syncStateExists)이 걸려 파일 루프 자체가 안 돈다(#6 원천 차단).
    // 원인을 가리지 않는다(위 파일 루프와 같은 규칙) — free는 어차피 클라우드에 못 쓰므로 관용의
    // 부작용이 없고, free 한정이 안전 조건이다. pull 실패(failed>0)만이 관용을 막는 조건이다.
    if (!(opts.freePlan && failed === 0)) throw e;
    manifestDenied = true;
  }
  }
  // base는 **디스크가 실제로 가진 것만** 주장한다(분리 검수 #436 CRITICAL-1 실측: 키 미확보·pull 실패로 손대지 않은 원격 항목을 그대로
  // 흡수하면 다음 사이클이 그것을 "로컬에서 지웠음"으로 읽어 원격·원본 기기 로컬까지 삭제 — 어디에도 안 남음). 이번 사이클에 로컬과
  // 일치한 항목은 원격 메타로, 못 받은 항목은 종전 base(있으면)로, 한 번도 안 받은 항목은 base 밖(다음 사이클 pull 대상)으로.
  const nextFiles = {};
  for (const [rel, m] of Object.entries(remote.files)) {
    if (local[rel] && !changed(local[rel], m)) nextFiles[rel] = m;
    else if (state[rel]) nextFiles[rel] = state[rel];
  }
  // 크기 초과 목록은 state에도 남긴다 — 상주와 다른 프로세스인 `argo status`가 읽는다(옛 버전은 files만 읽으므로 무해, .sync-state.json은 모든 버전에서 동기화 제외).
  const oversizeRels = [...oversize].slice(0, 5);
  await writeJsonAtomic(stateFile(wsId), { files: nextFiles, ts: Date.now(), ...(oversize.size ? { oversize: { n: oversize.size, rels: oversizeRels, limit: SYNC_MAX_OBJECT_BYTES } } : {}) });
  return { pulled, pushed, deletedL, deletedR, merged, conflicts, failed, healed, denied, uploadDenied, ...(deferred ? { deferred } : {}), ...(held ? { held } : {}), ...(withdrawn ? { withdrawn } : {}), ...(manifestDenied ? { manifestDenied: true } : {}), ...(failures.length ? { failures } : {}), ...(missing ? { missing, missingRels } : {}), ...(oversize.size ? { oversize: oversize.size, oversizeRels, oversizeLimit: SYNC_MAX_OBJECT_BYTES } : {}) };
}

// 이 인스턴스가 책임지는 오너(들) — 테넌트 격리의 핵심.
// ARGO_SYNC_OWNER(설치 시 지정한 소유자 id) 또는 페어링 자격의 owner 있으면 그것만. 없으면 로컬에 이미
// 있는 오너만 (버킷 전체를 무차별 순회해 남의 테넌트를 로컬로 빨아들이지 않는다 — 감사 지적).

/** 동기화 색인 — 세션 모드에서 회사·tombstone 목록을 RPC(argo_sync_index, 마이그레이션 20260910120000) 한 번으로 받는다.
    storage.list는 RLS 아래 storage.search가 버킷 전체를 훑어(오너 id가 사전순 뒤일수록 18~29초) 클라이언트 30초
    타임아웃에 걸리고, discoverRemote의 catch가 빈 목록으로 삼켜 **새 기기가 자기 회사를 영영 못 찾던** 실사고
    (2026-09-10 제보 "깃허브 계정으로 기기 동기화가 안 된다"). RPC는 오너 접두사 인덱스 범위 조회라 밀리초.
    null = 색인 없음(서비스 모드·RPC 미배포 셀프호스트·일시 실패) → 호출부는 기존 list 경로로 폴백한다(동작 ≥ 종전).
    서비스 모드는 auth.uid()가 없어 RPC가 null을 주므로 처음부터 안 부른다. 색인은 **세션 uid의 것**이라 owner를 실어
    돌려주고(RPC의 owner ≠ 세션 uid면 null — 다른 사용자 문맥으로 실행된 색인은 쓰지 않는다), 소비자는 이 owner로만
    라벨·비교한다 — ARGO_SYNC_OWNER·잔존 .sync-credentials.json의 다른 오너가 색인에 붙어 남의 prefix로 복원을 시도하던
    회귀 차단(분리 검수 MEDIUM-1). 형태는 문자열 배열만 통과시키고, wsId 규칙(WS_ID_RE)은 소비자가 거른다.
    비용은 그 오너의 객체 수에 선형(인덱스 범위 조회) — 사고의 버킷 전수 스캔과 달리 자기 몫만 본다. (export: 테스트용 _syncIndexForTest) */
let indexWarned = false;
async function loadSyncIndex() {
  if (!hostedCredsOff()) return null;
  const owner = loadDeviceSession()?.user?.id ?? null;
  if (!owner) return null;
  try {
    const { data, error } = await client().rpc('argo_sync_index');
    if (error) throw new Error(error.message);
    const strs = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
    if (!data || data.owner !== owner || !strs(data.companies) || !strs(data.tombstones)) return null;
    indexWarned = false;
    return { owner, companies: data.companies, tombstones: data.tombstones };
  } catch (e) {
    if (!indexWarned) { indexWarned = true; console.warn('[argo] 동기화 색인 RPC 불가 — 목록 조회로 폴백:', String(e?.message ?? e).slice(0, 80)); }
    return null;
  }
}

/* ─── 원격 회사 발견 — 내가 책임지는 오너의 회사만. 새 기기가 자기 회사를 복원하는 경로. ─── */
async function discoverRemote(localOwners, index = null) {
  const fixed = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || loadDeviceSession()?.user?.id || null;
  const allow = fixed ? new Set([fixed]) : new Set(localOwners);
  if (allow.size === 0) return []; // 지정 오너도, 로컬 회사도 없으면 발견 안 함(무차별 복제 차단)
  // 색인이 있고 그 오너가 이 사이클의 오너와 같을 때만 list(storage.search)를 건너뛴다 — 다르면(ARGO_SYNC_OWNER 오설정 등) 종전 경로.
  if (index && fixed === index.owner) return index.companies.filter((c) => !c.startsWith('.') && WS_ID_RE.test(c)).map((wsId) => ({ owner: fixed, wsId }));
  const out = []; // [{ owner, wsId }]
  for (const owner of allow) {
    if (!ownerPrefixOk(owner)) { console.warn(`[argo] 동기화 발견: 소유자 접두사가 비어 목록 조회를 건너뜀(${String(owner).slice(0, 20)})`); continue; } // 루트 나열 차단
    const { data: companies } = await client().storage.from(BUCKET).list(owner, { limit: 200 }).catch(() => ({ data: [] }));
    for (const c of companies ?? []) {
      // 점 접두 폴더(.tombstones 등)는 회사가 아니다 — wsId 규칙(WS_ID_RE)도 점 접두를 거부한다
      if (!c.id && !String(c.name).startsWith('.')) out.push({ owner, wsId: c.name }); // 오너 id·회사 slug는 ASCII
    }
  }
  return out;
}

/* ─── 회사 tombstone 동기화 — 보관을 기기 간 전파하고 복원 루프를 차단한다 ───
   문제(실측): archiveCompany는 로컬 이동일 뿐이라 discoverRemote가 클라우드 사본을
   "새 기기 복원"으로 판단, 8초 뒤 회사를 되살렸다(같은 회사 4회 보관 → 4회 부활).
   설계: 로컬 .tombstones/{wsId}.json(오프라인에서도 즉시 기록)이 신호의 정본,
   여기서 원격 {owner}/.tombstones/{wsId}.json과 양방향 동기화한다.
   반환: 보관된 wsId Set — cycle이 발견(discover) 결과에서 제외한다. */
async function syncTombstones(fixedOwner, { remote: doRemote = true, index = null } = {}) {
  // 1) 로컬 tombstone 로드
  const local = new Map(); // wsId → { ownerId, at }
  try {
    for (const f of await readdir(TOMBSTONE_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(await readFile(join(TOMBSTONE_DIR, f), 'utf8'));
        if (t?.wsId) local.set(t.wsId, { ownerId: t.ownerId ?? null, at: t.at ?? 0 });
      } catch { /* 손상 marker 무시 — 회사를 지우는 신호이므로 보수적으로 */ }
    }
  } catch { /* 디렉토리 없음 = tombstone 없음 */ }

  // 1.5) 로컬 tombstone인데 회사가 아직 로컬에 있는 경우(보관 실패 잔재·픽스 전 부활 좀비·수정 경합).
  //      판정 기준은 company.json 수정 시각(한계: 콘텐츠 편집은 company.json을 안 올림 — 시계 오차와
  //      함께 감수, 오차는 비파괴 방향으로): tombstone 이후 수정이면 철회, 아니면 보관 재적용.
  //      오너 불일치(wsId 재순환으로 다른 오너가 같은 slug를 받은 경우)면 이 회사의 tombstone이 아니다.
  for (const [wsId, t] of [...local]) {
    let mt = 0, owner0 = null;
    try { mt = (await stat(paths(wsId).company)).mtimeMs; } catch { continue; /* 회사 없음 — 정상 */ }
    try { owner0 = JSON.parse(await readFile(paths(wsId).company, 'utf8'))?.ownerId ?? null; } catch { /* 손상 */ }
    const at = Number(t.at) || 0;
    const sameOwner = owner0 === (t.ownerId ?? null);
    if (!sameOwner || (at && mt >= at)) {
      await rm(join(TOMBSTONE_DIR, `${wsId}.json`), { force: true }).catch(() => {});
      // 원격 철회는 같은 오너의 수정 경합일 때만 — 오너가 다르면 남의(또는 옛) 신호라 로컬 마커만 걷는다
      if (sameOwner && t.ownerId) await client().storage.from(BUCKET).remove([skey(t.ownerId, '.tombstones', `${wsId}.json`)]).catch(() => {});
      local.delete(wsId);
      console.log(`[argo] 동기화: tombstone 철회 (${wsId}${sameOwner ? ' — 보관 이후 수정' : ' — 오너 불일치'})`);
    } else {
      try { await archiveCompany(wsId); console.log(`[argo] 동기화: 잔여 사본 보관 재적용 (${wsId})`); }
      catch { /* rename 실패 — 다음 사이클 재시도 */ }
    }
  }

  // ── 여기까지가 로컬 단계. 목록 조회(list)가 없어 매 사이클 돌아도 이번 사고의 핫패스를 타지 않는다.
  // ⚠ 완전 무료는 아니다: 1.5단계의 tombstone 철회 분기에 원격 remove()가 하나 있다(희귀 — 마커가
  // 있는데 회사 폴더도 살아 있을 때만 진입). storage.search가 아니라 남겼다(검수 확인).
  // 아래 2~4단계는 전부 원격 호출(list·download·upload)이라 DISCOVER_MS 주기에만 돈다(위 상수 주석).
  // 로컬 tombstone 집합은 그대로 반환하므로, 건너뛰어도 보관된 회사가 복원되는 일은 없다
  // (cycle이 이 Set으로 발견 결과를 거른다 — 안전 방향).
  if (!doRemote) return new Set(local.keys());

  // 2) 원격 tombstone 목록 — 내가 책임지는 오너만(discoverRemote와 같은 테넌트 격리 원칙).
  //    기기 세션이 없는 셀프호스트에서 로컬 tombstone의 ownerId도 오너로 인정한다.
  //    세션(JWT) 모드는 cycle의 로컬 수집과 같은 소유자 게이트 — 다른 계정 소유 tombstone으로
  //    남의 prefix에 list/upload를 매 사이클 반복하지 않는다(사후 검수 2026-07-25). 서비스 모드는 무게이트.
  const gateUid = (loadSyncCreds() && serviceCredsAllowed()) ? null : (loadDeviceSession()?.user?.id ?? null);
  const allowOwner = (o) => !gateUid || o === gateUid;
  const owners = new Set(fixedOwner && allowOwner(fixedOwner) ? [fixedOwner] : []);
  for (const t of local.values()) if (t.ownerId && allowOwner(t.ownerId)) owners.add(t.ownerId);
  const remote = new Map(); // wsId → owner
  for (const owner of owners) {
    // 색인(argo_sync_index)이 있고 그 오너가 세션 오너면 list를 건너뛴다 — 색인의 tombstones는 uid/.tombstones/<wsId>.json 직계뿐.
    if (index && owner === index.owner) { for (const wsId of index.tombstones) if (WS_ID_RE.test(wsId)) remote.set(wsId, owner); continue; }
    const { data } = ownerPrefixOk(owner) ? await client().storage.from(BUCKET).list(skey(owner, '.tombstones'), { limit: 500 }).catch(() => ({ data: [] })) : { data: [] }; // 루트 나열 차단
    for (const e of data ?? []) {
      if (e.id && String(e.name).endsWith('.json')) remote.set(String(e.name).slice(0, -5), owner);
    }
  }

  // 3) 원격에만 있는 tombstone → 이 기기에 적용. 단 회사가 tombstone 이후에 수정됐으면
  //    (다른 기기의 삭제 vs 이 기기의 편집 경합) 조용히 파기하지 않고 tombstone을 철회한다
  //    — syncCompany의 "blind LWW 금지" 원칙과 동일. 시계 오차 한계는 감수(비파괴 방향 오차).
  for (const [wsId, owner] of remote) {
    if (local.has(wsId)) continue;
    let t;
    try { t = JSON.parse((await download(skey(owner, '.tombstones', `${wsId}.json`))).toString()); }
    catch { continue; /* 읽기 실패 — 다음 사이클 재시도 */ }
    const at = Number(t?.at) || 0;
    let companyMtime = 0, owner0 = null, credOff = false;
    try { companyMtime = (await stat(paths(wsId).company)).mtimeMs; } catch { /* 로컬에 회사 없음 */ }
    if (companyMtime) {
      try {
        const meta0 = JSON.parse(await readFile(paths(wsId).company, 'utf8'));
        owner0 = meta0?.ownerId ?? null;
        credOff = meta0?.credSync === false; // 아래 마지막 push도 옵트아웃을 지켜야 한다(분리 검수 HIGH-1)
      } catch { /* 손상 */ }
      if (at && companyMtime >= at) {
        await client().storage.from(BUCKET).remove([skey(owner, '.tombstones', `${wsId}.json`)]).catch(() => {});
        console.log(`[argo] 동기화: 보관 이후 수정된 회사 — tombstone 철회 (${wsId})`);
        continue;
      }
      // 테넌트 격리 — tombstone 오너와 로컬 회사 오너가 일치할 때만 보관 전파. wsId 생성 규칙이
      // 타임스탬프 하위 4자라 재순환 충돌이 가능(멀티오너 셀프호스트에서 실질 위험, 검수 지적 H).
      if (owner0 !== owner) continue;
      // 미push 편집 고립 방지 — 보관 직전 마지막 push. 실패해도 사본은 .archive에 남아 복구 가능.
      // noSecrets 동반(분리 검수 HIGH-1): cycle 호출부에만 배선하면 이 경로가 회수 완료 상태의 자격을
      // 신규 push로 되올리고, 직후 archiveCompany가 회사를 치워 재회수 기회가 영영 없다(영구 잔류).
      try { await syncCompany(wsId, owner, false, { noSecrets: credOff }); } catch { /* 오프라인 등 — 보관은 계속 */ }
      try { await archiveCompany(wsId); console.log(`[argo] 동기화: 다른 기기의 회사 보관 전파 (${wsId})`); }
      catch (e) { console.warn(`[argo] 동기화: 보관 전파 실패(${wsId}): ${e.message}`); continue; }
    }
    await writeTombstone(wsId, owner, at || Date.now()).catch(() => {});
    local.set(wsId, { ownerId: owner, at });
  }

  // 4) 로컬에만 있는 tombstone → 원격 push. ownerId 없는 회사(클라우드 미동기)는 원본이
  //    원격에 없어 복원될 일도 없으므로 로컬 마커만으로 충분하다.
  for (const [wsId, t] of local) {
    if (!t.ownerId || !allowOwner(t.ownerId) || remote.has(wsId)) continue;
    await upload(skey(t.ownerId, '.tombstones', `${wsId}.json`), Buffer.from(JSON.stringify({ wsId, at: t.at })))
      .catch(() => { /* push 실패 — 로컬 마커가 남아 다음 사이클 재시도 */ });
  }

  return new Set(local.keys());
}
// 테스트 전용 — cycle 없이 tombstone 로직만 fake storage로 실행 검증한다.
export const _tombstonesForTest = { syncTombstones, discoverRemote };
// 테스트 전용 — 색인 RPC 로더·경고 1회 상태 리셋.
export const _syncIndexForTest = { loadSyncIndex, reset: () => { indexWarned = false; } };

/** 이번 사이클에 원격 목록 조회를 할 차례인가(순수) — last가 없으면(첫 사이클) 반드시 한다.
    첫 사이클을 건너뛰면 새 기기가 자기 회사를 못 찾아 최대 DISCOVER_MS 동안 빈 화면을 본다.
    (export: 회귀 테스트용 — cycle 전체는 실 env가 필요해 단위로 못 태운다) */
export const isDiscoverDue = (now, last, intervalMs) => !last || now - last >= intervalMs;

/* ─── E2EE 재봉인 마커 — WS_ROOT 레벨(회사 밖 = walk·동기화 비대상) { [wsId]: true } ───
   enable 라우트가 markResealAll()로 표시하면, cycle이 회사별 1회 reseal 동기화(무변경 파일 포함
   전량 v3 되덮기)를 돌리고 성공 시 지운다. 실패 시 마커가 남아 다음 사이클 재시도. */
const RESEAL_FILE = () => join(WS_ROOT, '.e2ee-reseal.json');
export async function markResealAll() {
  const targets = {};
  let entries = [];
  try { entries = await readdir(WS_ROOT, { withFileTypes: true }); } catch { /* 루트 없음 */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = JSON.parse(await readFile(join(WS_ROOT, e.name, 'company.json'), 'utf8'));
      if (meta.ownerId) targets[meta.id] = true;
    } catch { /* 회사 아님 */ }
  }
  await writeJsonAtomic(RESEAL_FILE(), targets);
  return Object.keys(targets);
}
const loadReseal = () => readJsonLenient(RESEAL_FILE(), {});
async function clearReseal(wsId) {
  const cur = await loadReseal();
  if (!cur[wsId]) return;
  delete cur[wsId];
  await writeJsonAtomic(RESEAL_FILE(), cur);
}

/* ─── 상주 루프 ─── */
const status = (globalThis.__argoSyncStatus ??= { lastTs: null, lastError: '', paywalled: false, plan: null, companies: {} });
const lockState = (globalThis.__argoSyncLockState ??= { elsewhere: false }); // 화면용 상태(status)와 따로 — syncStatus 응답 모양을 바꾸지 않는다
export function syncStatus() {
  // plan은 status(globalThis)로 나른다 — 모듈 변수는 Next의 라우트/instrumentation
  // 별도 번들에서 사본이 갈라져 항상 null이 되는 함정(위 lease 주석과 동일 클래스).
  // 주인 없는 회사(no-owner)는 화면에 싣지 않는다 — 동기화한 적도 클라우드 사본도 없다(설정 화면은 companies[ws] 존재를 '동기화한 적 있음'으로 읽는다).
  const companies = Object.fromEntries(Object.entries(status.companies).filter(([, c]) => c?.skipped !== 'no-owner'));
  return { ...status, on: syncOn(), leader: isCloudLeader(), companies };
}
/** 한 회사 화면용 상태 — 회사 가드(guardCompany)는 그 회사만 보므로, 같은 기기의 게스트·다른 계정이 자기 회사 화면을 열어도
    다른 회사의 실패·빈 항목 파일 경로가 보이지 않게 companies는 그 회사 것만 싣는다. lastError는 기기 전체 오류(자격 만료·다른 프로세스
    동기화 중 등 — 회사 접두 없음)가 있으면 그것, 아니면 이 회사 오류(companies[ws].error)다. 회사 접두(`<회사 ID>: `)가 붙은 lastError는
    마지막으로 실패한 회사 하나 몫이라 공통으로 보이지 않는다. (분리 검수 LOW-1·2차 MEDIUM-1·보안 검토) */
export function syncStatusFor(ws) {
  const s = syncStatus();
  const mine = s.companies[ws];
  const companyScoped = Object.keys(s.companies).some((id) => s.lastError?.startsWith(`${id}: `));
  return { ...s, lastError: (!companyScoped && s.lastError) || mine?.error || '', companies: mine ? { [ws]: mine } : {} };
}
/** 이 회사의 로컬 사본이 `since`(ms) 이후 원격과 한 번 맞춰졌는가 — 낡은 사본으로 판정·기록하면 안 되는 일의 관문(지금은 놓친 루틴 회차 기록, scheduler.mjs).
    동기화가 꺼져 있으면 참(이 기기가 정본). 켜져 있으면 since 뒤에 끝난 그 회사의 사이클 결과(status.companies — 이 프로세스가 돌린 사이클만 있다)가 있어야 한다:
    정상 완료·유휴 확인(idle-probe — 매니페스트 판이 그대로)·동기화 대상 아님(free-plan 단일 기기·foreign-owner 남의 회사·no-owner 주인 없는
    게스트 회사 — 클라우드에 자리가 없어 이 기기가 정본)은 참, 오류·재시도 대기(retry-backoff)·업로드 거절 대기(upload-denied)·결과 없음은 거짓 — 다음 사이클을 기다린다.
    거짓 쪽이 안전하다: 이 프로세스가 동기화를 돌리지 않거나(다른 프로세스가 동기화 잠금을 쥠 — syncRunsElsewhere) 자격이 만료돼 사이클이 회사까지 못 가면
    판정을 미룰 뿐이다. 다른 프로세스의 완료 신호로 회사별 .sync-state.json의 ts를 쓰지 않는 이유: 파일 받기가 일부 실패한 사이클도 이 파일을 쓰고(못 받은
    항목은 옛 base를 유지한 채 ts만 새로), 유휴 확인 사이클은 쓰지 않는다 — 이 관문이 막는 '낡은 routines.json' 경우를 통과시키면서 정상 경우는 막는다. */
const SYNCED_SKIPS = new Set(['idle-probe', 'free-plan', 'foreign-owner', 'no-owner']);
export function companySyncedSince(wsId, since) {
  if (!syncOn()) return true;
  const c = status.companies[wsId];
  if (!c || !(Number(c.ts) >= since) || c.error) return false;
  return !c.skipped || SYNCED_SKIPS.has(c.skipped);
}
/** 같은 데이터 루트를 다른 살아 있는 프로세스가 동기화하고 있어 이 프로세스는 파일 동기화를 대기 중인가(마지막 사이클 기준) — 이 프로세스에는 회사별
    사이클 결과가 쌓이지 않아 companySyncedSince가 거짓으로 남는다. 판정을 미루는 쪽(스케줄러)이 그 사실을 로그로 알리는 데 쓴다. */
export const syncRunsElsewhere = () => syncOn() && lockState.elsewhere;
/** 회사 몫 오류는 반드시 이 함수로 — lastError(기기 전체 하나)와 그 회사 결과(error)에 같이 두고 회사를 등록한다. 등록이 빠지면
    syncStatusFor가 `<회사 ID>: ` 접두를 회사 몫으로 못 알아봐 다른 회사·게스트 화면에 보인다(분리 검수 2·3차 LOW). */
const setCompanyError = (wsId, msg) => { status.lastError = msg; (status.companies[wsId] ??= { ts: Date.now() }).error = msg; };

/** 세션(JWT) 모드면 세션 사용자 id, 서비스 모드(셀프호스트·워커)면 null — 회사 소유자 게이트와 요금제 캐시 키가 같이 쓴다. */
const currentSessionUid = () => ((loadSyncCreds() && serviceCredsAllowed()) ? null : (loadDeviceSession()?.user?.id ?? null));

/** 로컬 회사 수집 (ownerId 있는 것만 — 소유자가 있어야 클라우드에 자리가 있다)
    세션(JWT) 모드는 현재 계정 소유가 아닌 회사를 제외한다 — 다른 계정 소유의 로컬 사본(계정 전환·
    기기 공유 흔적)을 매 사이클 남의 폴더로 밀다 스토리지 격리(RLS)에 막혀 "row-level security"
    에러를 무한 반복하던 실사고(2026-07-25, lean-ax-zl5j). 격리 정책이 맞고, 남의 회사를 밀지 않는
    것이 동기화의 몫이다. 서비스 모드(셀프호스트·워커)는 다중 오너가 정당하므로 게이트 없음. */
async function collectLocalTargets(sessionUid) {
  const targets = new Map(); // wsId → owner
  const noSecretsWs = new Set(); // credSync:false 회사 — 자격 3종 불가시 + 클라우드 사본 회수(syncCompany opts)
  let entries = [];
  try { entries = await readdir(WS_ROOT, { withFileTypes: true }); } catch { /* 루트 없음 */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const meta = JSON.parse(await readFile(join(WS_ROOT, e.name, 'company.json'), 'utf8'));
      // 주인 없는 회사(게스트 시절 만들고 로그인 뒤 귀속하지 않음)는 클라우드에 자리가 없다 — 동기화 대상이 아님을 결과로 남긴다(이 기기가 정본).
      // 남기지 않으면 결과 없음 = '아직 안 맞춰짐'으로 읽혀 companySyncedSince가 영영 거짓이다(놓친 루틴 회차 판정이 무기한 보류, 3차 검수 LOW). 화면에는 싣지 않는다(syncStatus).
      if (!meta.ownerId) { if (meta.id) status.companies[meta.id] = { ts: Date.now(), skipped: 'no-owner' }; continue; }
      if (sessionUid && meta.ownerId !== sessionUid) {
        if (status.companies[meta.id]?.skipped !== 'foreign-owner') {
          console.log(`[argo] 동기화: 다른 계정 소유 회사 제외 (${meta.id})`);
        }
        status.companies[meta.id] = { ts: Date.now(), skipped: 'foreign-owner' };
        continue;
      }
      targets.set(meta.id, meta.ownerId);
      // 부재/true = 현행 유지(동기화 포함) — false만 옵트아웃. company.json 자체가 동기화 대상이라
      // 이 토글은 기기 간에 자동 전파된다(원격 발견으로 복원된 회사는 company.json 도착 다음 사이클부터 적용).
      if (meta.credSync === false) noSecretsWs.add(meta.id);
    } catch { /* 회사 아님 */ }
  }
  return { targets, noSecretsWs };
}

/** 리더 양보 판단 — 이 기기에 쓸 러너가 있는가(60s 캐시 — resolveRunner는 파일·호스트 프로브라 매 8s는 과함).
    전 회사 OR(사후 검수 M-2: 첫 회사만 보면 자격 있는 다른 회사가 있어도 오판) + 5s 상한(M-3: CLI 프로브가
    행 걸리면 사이클 전체 정지 — 리스 갱신·파일 동기화까지 조용히 죽는다). 실패·초과는 양보하지 않는 쪽(true).
    첫 판정만 기다리고, 그 뒤 60초마다 하는 다시 판정은 기다리지 않는다(결과는 다음 리스 판정부터) — 리스 판정이 프로브(최대 5초)에 밀려
    확인 읽기가 늦으면 확인 기한(LEASE_CONFIRM_VALID_MS)을 넘겨 담당이 잠깐 꺼졌다. */
async function probeRunnerUsable(targets) {
  const probe = (globalThis.__argoRunnerProbe ??= { ts: 0, ok: true });
  if (targets.size && !probe.inflight && Date.now() - probe.ts > 60_000) {
    const first = !probe.ts;
    probe.inflight = (async () => {
      try {
        probe.ok = await Promise.race([
          (async () => {
            for (const ws of targets.keys()) {
              if ((await resolveRunner(ws, null).catch(() => ({ available: false }))).available) return true;
            }
            return false;
          })(),
          new Promise((r) => setTimeout(r, 5_000, true)),
        ]);
      } finally { probe.ts = Date.now(); probe.inflight = null; }
    })();
    if (first) await probe.inflight;
  }
  return probe.ok;
}

/** 실행 담당(클라우드 리더) 판정 한 번 — 리스 타이머(startLeaseLoop)가 CYCLE_MS마다 부른다. **실행 리스(daemonLease: 게이트웨이·스케줄러)를 쥔 프로세스만** 참여한다.
    왜(검수 M2 → 반대 검토 M-d → #791 독립 검수 HIGH-1, 2026-10-01):
    - 실제 실행 조건은 procLeader && isCloudLeader()다(gateway.mjs ensureGateway, scheduler.mjs ensureScheduler). procLeader는
      daemonLease(.gateway.lock·.scheduler.lock)이고, 동기화 락(.sync-process.lock) 주인과 다른 프로세스로 갈릴 수 있다.
    - 리스는 기기 단위다 — deviceId는 데이터 루트의 .device-id 하나라(workspace.mjs getDeviceId) 같은 루트의 프로세스들은 리스에서
      같은 기기로 보인다. 그래서 같은 루트에서 여럿이 renewLease를 돌리면 원격 리스가 "내 것"이라 둘 다 리더가 되고, 아무도 안 돌리면
      그 기기는 실행 담당을 잃는다. 참여자는 "그 기기에서 실제로 실행할 프로세스"여야 한다.
    - 동기화 락 기준(1차 수정)은 락 주인과 게이트웨이 리스 주인이 갈리면 아무도 실행하지 않았다(재시작 경쟁 재현: B proc:true cloud:false,
      A' proc:false cloud:true). 수정 전(원래 결함)은 락을 못 얻으면 기본값 리더(true)로 남아 이중 실행이었다.
    - 대화 화면(argo)은 게이트웨이·스케줄러를 켜지 않으니 자연히 빠진다(따로 표시가 필요 없다).
    - 게이트웨이와 스케줄러 리스가 다른 프로세스로 갈리면(재시작 경쟁) 둘 다 참여해 둘 다 리더가 된다. 각자 자기 데몬만 실행하므로
      이중 실행은 아니고, 리스 쓰기만 그동안 두 배(보유자당 30초에 1회)가 된다. 한쪽만 참여시키면 다른 쪽 데몬이 영영 멈춘다.
    텔레그램 토큰 클레임도 같은 기준이다 — 폴러는 게이트웨이 리스 주인에서만 돈다(gateway.mjs의 procLeader 게이트).
    파일 동기화와 따로 도는 이유는 위 클라우드 리스 머리말(D 3차 검수). 동기화 락과는 무관하다 — 같은 데이터 루트를 다른 프로세스가 동기화 중이어도 판정한다. */
async function leaseTick() {
  await daemonLeasesSettled(['gateway', 'scheduler']); // 기동 직후 첫 판정 전이면 기다린다(첫 주기 강등 → 8초 공백 방지)
  if (!holdsDaemonLease('gateway', 'scheduler')) {
    leaseState.leader = false;
    leaseState.ownedAt = 0;
    leaseState.validUntil = 0;
    leaseState.checkedAt = Date.now();
    return;
  }
  if (!(await ensureClient())) { leaseUnreadable(null); return; } // 세션 만료 등 — 리스를 볼 수 없다(엄격 판정이면 담당 아님, 단일 기기는 배포본 그대로)
  const { targets } = await collectLocalTargets(currentSessionUid());
  const owner = [...new Set(targets.values())][0];
  if (!owner) { leaseState.checkedAt = Date.now(); return; } // 로컬 회사 0개 — 이 기기에서 돌릴 루틴·폴러 자체가 없다(아래 cycle 주석). 판정은 끝난 것으로
  await renewLease(owner, { runnerUsable: await probeRunnerUsable(targets) });
  if (holdsDaemonLease('gateway')) await renewTokenClaims(owner).catch((e) => console.warn('[argo] 텔레그램 토큰 클레임 갱신 실패:', String(e.message).slice(0, 80))); // 토큰 단위 소유 — 리더와 별개
}
/** 리스 타이머 — 동기화 루프와 따로 CYCLE_MS마다 leaseTick을 돈다(한 번에 하나: 앞 판정이 걸리면 끝난 뒤 바로 다음). 요청은 종전 동기화 주기마다 한 번과 같다.
    기동 뒤 첫 리스 읽기가 오류였으면 BOOT_RETRY_MS 뒤에 한 번만 다시 읽는다 — 읽기 오류면 단일 기기도 담당이 아니므로(leaseUnreadable) 일시 오류 하나로 첫 담당이
    한 주기(8초) 늦어지지 않게(D 4차 검수: 약 9.5초). 요청은 기동 때 한 번만 1건 늘어난다. */
const BOOT_RETRY_MS = 1_000;
function startLeaseLoop() {
  if (globalThis.__argoLeaseLoop) return;
  globalThis.__argoLeaseLoop = true;
  (async () => {
    let firstRead = true;
    for (;;) {
      const t0 = Date.now();
      const readsBefore = leaseState.reads || 0;
      try { await leaseTick(); } catch (e) { console.warn('[argo] 실행 담당 판정 실패:', String(e?.message || e).slice(0, 120)); }
      let wait = Math.max(0, CYCLE_MS - (Date.now() - t0));
      if (firstRead && (leaseState.reads || 0) > readsBefore) { // 이 판정에서 처음 리스를 읽었다
        firstRead = false;
        if ((leaseState.readFailSince || 0) > 0) wait = Math.min(wait, BOOT_RETRY_MS);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  })();
}

async function cycle() {
  if (!(await ensureClient())) { status.lastError = '동기화 자격 없음/만료 — 재로그인 필요'; return; }
  // 크로스 프로세스 락 — 같은 root를 다른 살아있는 프로세스가 동기화 중이면 파일 동기화는 대기(이중 동기화=대형 유실 차단)
  lockState.elsewhere = !(await holdSyncLock());
  if (lockState.elsewhere) {
    status.lastError = '같은 데이터 루트를 다른 프로세스가 동기화 중 — 이 인스턴스는 대기';
    // 파일 동기화는 대기한다. 실행 담당 판정은 리스 타이머(startLeaseLoop)가 이 프로세스가 실행 리스 주인이면 따로 한다(leaseTick 주석).
    // 로컬 회사 수집은 그대로 한다 — 주인 없는·다른 계정 회사의 결과(no-owner·foreign-owner)를 이 프로세스에도 남겨야 놓친 루틴 회차 판정(companySyncedSince)이
    // 그 회사를 보류하지 않는다(B25 — 종전에는 리스 중재가 이 수집을 대신 불렀다).
    await collectLocalTargets(currentSessionUid());
    return;
  }
  // 계정 키 확보 — 크레덴셜 봉투(v2)의 열쇠. 실패해도 사이클은 계속(크레덴셜만 이번 사이클 제외).
  const keyOwner = process.env.ARGO_SYNC_OWNER || loadSyncCreds()?.owner || loadDeviceSession()?.user?.id || null;
  await ensureAccountKey(client(), keyOwner);
  // E2EE 단계 0 — 기기 공개키 등록부 구축(내부 1회 가드·실패 무해). 켜기 전까지 다른 동작 없음.
  const myDeviceId = await getDeviceId();
  ensureDeviceKeyRegistered(client(), keyOwner, myDeviceId).catch(() => {});
  // E2EE P1 — DEK 미보유면 자기 랩 회수 시도(승인·복구가 서버에 넣어준 랩, 60초 간격 own-RLS 1행).
  // 성공 순간부터 sealFor가 v3로 전환되고, 이 기기의 "잠김"이 풀린다.
  if (!dek()) await tryClaimDek(client(), myDeviceId).catch(() => {});
  const resealSet = dek() ? await loadReseal() : {};
  // 로컬 회사 수집 — 소유자 게이트 규칙은 collectLocalTargets 주석
  const sessionUid = currentSessionUid();
  const { targets, noSecretsWs } = await collectLocalTargets(sessionUid);
  const localOwners = [...new Set(targets.values())];
  // 리스 중재는 요금제 게이트보다 **먼저** 한다(architect 권고 2026-07-23). 리더 선출은 과금 대상이 아니라
  // 이중 실행 방지용 조정이고, 무료 계정도 단일 기기에서 루틴·메신저가 돌아야 한다(PRODUCT-SPEC: Free=로컬
  // 전부 무제한·단일 기기). 페이월 뒤에 두면 무료 계정이 중재를 아예 못 해 미획득 기본값 leader:true가
  // 두 기기에 남거나(이중 실행), 강등해 버리면 정상 무료 사용자의 루틴이 멈춘다 — 둘 다 제품 약속과 어긋난다.
  // 리스 키는 Storage RLS의 Pro 게이트에서 예외 처리돼 있다(마이그레이션 20260723001629, 오너 경계는 유지).
  // (2026-07-27 순서 이동 후에도 이 제약은 유지된다: renewLease는 아래 요금제 게이트 return보다 앞이다.
  //  리스 오너는 localOwners[0] — 세션 모드에선 foreign-owner 게이트로 targets 전부가 세션 소유라
  //  기존 owners[0]과 동일하고, 새 기기 첫 사이클(로컬 0개)만 다음 사이클로 미뤄진다. 이게 무해한 이유는
  //  "미획득 기본 leader:true"가 아니라(그 기본값은 획득한 리더십이 아니다 — 위 lease 설계 노트와 충돌)
  //  **로컬 회사가 0개면 이 기기에서 돌릴 루틴·폴러 자체가 없어서**다(분리 검수 2026-07-27 지적 반영).)
  // 리셋은 renewLease보다 **앞**에 둔다 — 뒤에 두면 renewLease가 throw할 때 직전 사이클의 paywalled가
  // stale로 남아 UI가 잘못된 페이월을 표시한다(architect 지적 2026-07-23).
  status.paywalled = false; // 매 사이클 리셋 — 모드 전환(세션→서비스) 시 stale true 잔존 차단
  // 실행 담당 판정(클라우드 리스·토큰 클레임)은 이 주기 안에서 하지 않는다 — 리스 타이머(startLeaseLoop)가 CYCLE_MS마다 따로 한다(D 3차 검수: 주기가 길면
  // 판정이 밀려 앞 담당이 넘겨받기 글을 못 읽었다). 위 순서 설명(요금제 게이트보다 먼저·로컬 0개)은 leaseTick에 그대로 적용된다.
  // 요금제 게이트(M-2d 스캐폴드) — 세션 모드에만. 서비스 모드(셀프호스트·워커)는 자기 인프라라 통과.
  // 강제는 ARGO_ENFORCE_PLAN=1일 때만(기본 off). 차단 = 조기 return — diff가 안 돌아 부작용 없음.
  // 판정은 ensureClient()의 실효 모드와 동일 조건(자격 존재 && serviceCredsAllowed) — 자격만 보면
  // 호스티드 오설정(자격 유출로 존재하지만 세션으로 강등)에서 세션 모드인데 게이트가 스킵된다(검수 2026-07-23).
  //
  // **위치(2026-07-27, DB 응답 불능 사후)**: 이 게이트는 반드시 아래 원격 목록 조회(tombstone·discover)
  // **앞**에 있어야 한다. 이전엔 목록 조회 뒤에 있어 차단될 계정도 매 주기 storage.search(회당 수 초,
  // DB CPU 98.9%)를 먼저 태웠다. 또 하나 — 강제(enforce) 여부와 무관하게 **free 플랜이면 원격 목록을
  // 건너뛴다**: Free = 단일 기기 약속이라 발견·원격 tombstone이 제품상 무의미하고, 서버 RLS가
  // 어차피 거부하는 호출이 비용만 태운다. 판정은 `=== 'free'`뿐 — fetchPlan의 실패·미확인 경로는 전부
  // null이라(entitlement.mjs) trial·미확인이 free로 오분류되지 않는다(fail-safe 방향, 분리 검수 확인).
  // **예외(데이터 소유권 — 분리 검수 MEDIUM 반영)**: 로컬 회사 0개인 free 기기는 목록을 허용한다.
  // RLS가 free에도 select/delete를 의도적으로 열어둔 것(마이그레이션 20260723001629 꼬리: 다운그레이드
  // 계정도 기존 클라우드 데이터를 pull·삭제할 수 있어야 한다 — 데이터 소유권)과 정합하며, 재설치한
  // free 사용자의 유일한 복구 경로다. 회사가 복원되는 즉시(targets>0) 다시 스킵돼 비용은 상한적.
  // 조회 실패는 가용성 우선 통과(fail-open) — 최종 집행은 서버 RLS. (fetchPlan이 예외 대부분을 null로
  // 삼키므로 이 catch는 심층 방어다.)
  let freePlan = false;
  if (!(loadSyncCreds() && serviceCredsAllowed())) {
    try {
      // 계정별 10분 캐시(src/plan-cache.mjs) — 매 주기 /auth/v1/user + rpc/my_plan 2건이던 것(프로세스당 분당 15건)을 10분에 2건으로.
      // 키에 세션 사용자를 넣어 계정이 바뀌면 바로 빗나가고, 업로드 거절(아래)·결제 화면 조회(me/billing)가 캐시를 지운다.
      const planOwner = keyOwner || localOwners[0] || null;
      const planKey = `${sessionUid ?? ''}|${planOwner ?? ''}`;
      let ent = cachedPlan(planKey);
      if (!ent) { ent = await syncEntitled(client(), planOwner); rememberPlan(planKey, ent); }
      status.plan = ent.plan; // 차단/통과 무관 — 조회했으면 기록 (globalThis 경유로 라우트 번들에서도 보임)
      if (!ent.ok) { status.lastError = '멀티기기 동기화는 Pro 플랜입니다'; status.paywalled = true; return; }
      freePlan = ent.plan === 'free';
    } catch (e) {
      status.plan = null; // stale 잔존 차단 — 직전 사이클 plan이 설정 배지에 남지 않게(분리 검수 LOW)
      console.warn('[argo] 요금제 조회 실패(가용성 우선 통과):', e.message);
    }
  }
  // free 목록 스킵의 실제 판정 — 복구 예외(로컬 0개) 포함. 아래 discoverDue **하나에만** AND된다.
  const freeListSkip = freePlan && targets.size > 0;
  // 회사 tombstone 동기화 — 이번 사이클에 원격 목록 조회(발견·tombstone)를 할 차례인가.
  // 실패해도 시각을 갱신한다: 실패마다 재시도하면 장애 중 목록 호출이 오히려 CYCLE_MS 주기로 폭주한다.
  // ⚠ 불변식 — **discoverRemote와 원격 tombstone은 반드시 이 게이트 하나를 공유한다.** 둘을 갈라
  // 각자 주기를 주면 "발견은 도는데 원격 tombstone은 안 도는" 사이클이 생기고, 그 사이클에 다른
  // 기기가 보관한 회사가 로컬로 복원돼 **부활**한다(보관 전파가 tombs로 걸러지는 구조라서다).
  // 절감이 더 필요하면 주기를 늘려라 — 나누지 마라. (검수 지적 2026-07-26, 회귀 가드: 아래 테스트)
  // freeListSkip은 두 소비자가 공유하는 discoverDue 하나에 AND된다 — 불변식(단일 게이트)이 그대로 지켜진다.
  const discoverDue = !freeListSkip && isDiscoverDue(Date.now(), globalThis.__argoLastDiscover, DISCOVER_MS);
  if (discoverDue) globalThis.__argoLastDiscover = Date.now();
  // 색인 RPC 한 번으로 tombstone·발견 두 소비자를 먹인다(두 호출이 같은 게이트를 타는 불변식은 그대로) — 색인이 없으면 둘 다 종전 list 경로.
  const fetchedIndex = discoverDue ? await loadSyncIndex() : null;
  // 페일세이프(분리 검수 HIGH-1): 색인이 "회사 0개"인데 로컬도 0개면 종전 list도 한 번 탄다 — "진짜 빈 계정"과 "함수가 행을 못 봄"을
  // 클라이언트가 구분할 수 없어서다. 비용은 비어 보이는 계정(= 새 기기 복원 구간)으로 상한.
  const syncIndex = fetchedIndex && fetchedIndex.companies.length === 0 && targets.size === 0 ? null : fetchedIndex;
  const tombs = await syncTombstones(keyOwner, { remote: discoverDue, index: syncIndex }).catch((e) => { console.warn('[argo] tombstone 동기화 실패:', e.message); return new Set(); });
  // 로컬 스캔이 tombstone 처리보다 먼저가 됐으므로(게이트 이동), 이번 사이클에 보관(재적용 포함)된
  // 회사를 push/pull 대상에서 명시적으로 뺀다 — 이전에는 "tombstone 먼저" 순서가 은닉하던 불변식이다.
  // tombs에는 철회된 마커가 없다(syncTombstones 1.5가 철회 시 local.delete) — 살아있는 회사를 지우지 않는다.
  for (const wsId of tombs) targets.delete(wsId);
  // 원격에만 있는 내 회사 발견 → 로컬 복제 대상에 추가 (새 기기가 자기 회사 복원). 남의 테넌트는 안 봄.
  // restoreSet: 로컬에 회사(company.json)가 없어 원격에서 처음 발견된 것 — 신규 복원 가드의 신호.
  const restoreSet = new Set();
  for (const { owner, wsId } of discoverDue ? await discoverRemote(localOwners, syncIndex) : []) {
    if (tombs.has(wsId)) continue; // 보관된 회사 — 클라우드 사본이 남아 있어도 복원하지 않는다
    if (!targets.has(wsId)) { targets.set(wsId, owner); restoreSet.add(wsId); }
  }
  const owners = [...new Set(targets.values())];
  // ARGO_SYNC_OWNER/페어링/세션 어디에도 오너가 없던 서비스 셀프호스트 — 로컬 회사에서 찾은 오너로 한 번 더 시도
  if (!keyOwner && owners[0]) await ensureAccountKey(client(), owners[0]);
  let companyFailed = 0;
  for (const [wsId, owner] of targets) {
    // 확정 free는 파일 왕복을 걸지 않는다(복원 예외) — 업로드는 RLS(is_pro)가 거부하는데 파일 삭제
    // 전파는 소유권 정책(20260723 꼬리: free도 select/delete 허용)상 성공해, 클라우드 사본이 삭제만
    // 반영하며 단조 감소한다(전수리뷰 2026-07-30 #6). 미확인(null)은 기존 결정대로 낙관 통과
    // (검수 MEDIUM 2026-07-24 — 유료 오차단 방지).
    // 복원 미완 판정은 **디스크에서 파생**(state 부재 = 미완, 재검수 HIGH-E·F) — 인메모리 pending은
    // ① free 매니페스트 거부가 매 사이클 재무장시켜 영구 restoring(지운 노트 8초 부활 + lastError 고정)
    // ② plan 왕복(free→pro→free)을 넘는 stale로 #6 재개 ③ 재시작에 증발(원결함 복귀)의 3중 결함이었다.
    // state는 재시작에 견디고, pro 구간의 정상 동기화가 쓰는 순간 자동 해제되며, free 복원은
    // syncCompany가 pull 완결 시 쓰기 거부(파일·매니페스트)를 관용하고 state를 써서(opts.freePlan)
    // 다음 사이클부터 정상 스킵된다 — 스킵되면 파일 루프 자체가 안 돌아 삭제 전파가 원천 불가다.
    // ⚠ "state 부재 = 복원 미완"이 성립하려면 **모든 free 인구가 state 기록에 도달**해야 한다.
    // 한 번도 성공 동기화한 적 없는 회사(체험 만료 후 첫 동기화·state 유실)는 로컬 전용 파일 때문에
    // 거부가 발생하는데, 그 거부를 실패로 세면 완결에 영영 못 닿아 이 술어가 항상 true로 굳는다
    // (8초마다 재시도·.conflict 증식·lastError 고정). 그래서 거부/실패 분리가 이 술어의 전제다.
    const restoring = restoreSet.has(wsId) || (freePlan && !(await syncStateExists(wsId)));
    if (freePlan && !restoring) {
      // foreign-owner 분기와 같은 표기(검수 LOW) — 카운터가 옛 값인 채 "방금 동기화"로 보이지 않게
      status.companies[wsId] = { ts: Date.now(), skipped: 'free-plan' };
      continue;
    }
    if ((uploadBackoff.get(wsId) ?? 0) > Date.now()) { status.companies[wsId] = { ts: Date.now(), skipped: 'upload-denied' }; continue; } // 전부 거절된 회사는 쉰다
    try {
      const reseal = !!resealSet[wsId];
      const r = await syncCompany(wsId, owner, restoring, { freePlan, noSecrets: noSecretsWs.has(wsId), reseal });
      if (r.skipped === 'retry-backoff') { // 대기 중에도 이 회사 오류(회사 화면용, syncStatusFor)는 유지한다
        const error = status.companies[wsId]?.error;
        status.companies[wsId] = { ts: Date.now(), ...r, ...(error ? { error } : {}) }; companyFailed++; continue;
      }
      // 업로드 거절 = 요금제가 바뀌었을 수 있다(pro 만료 등) — 캐시한 판정을 버리고 다음 주기에 다시 묻는다(확정 free는 위에서 스킵돼 여기 안 온다)
      if (!freePlan && (r.uploadDenied ?? 0) > 0) invalidatePlanCache();
      if (!freePlan && (r.uploadDenied ?? 0) > 0 && (r.pushed ?? 0) === 0) { // 확정 free는 이미 스킵 경로 — 여기는 미확인·무자격이 거절당하는 경우
        uploadBackoff.set(wsId, Date.now() + UPLOAD_BACKOFF_MS);
        console.warn(`[argo] 동기화(${wsId}): 업로드 ${r.uploadDenied}건 전부 거절 — ${UPLOAD_BACKOFF_MS / 60_000}분 보류(플랜 미확인·무자격 재시도 폭풍 차단)`);
      }
      // 재봉인 완결은 **파일 실패 0**일 때만 — throw만 안 하면 지우던 이전 배선은 개별 push 실패
      // (r.failed>0) 파일을 영구 구세대로 남겼다(분리 검수 MEDIUM). 실패가 있으면 마커를 남겨
      // 다음 사이클이 회사째 재시도한다(무변경 재푸시 비용 < 영구 평문 잔존).
      if (reseal && (r.failed ?? 0) === 0) await clearReseal(wsId).catch(() => {});
      status.companies[wsId] = { ts: Date.now(), ...r };
      // 회사 오류는 lastError(기기 전체 하나 — 여러 회사가 실패하면 마지막 것만 남는다)와 회사 결과(error) 양쪽에 둔다 — 회사 화면은 자기 것을 본다(분리 검수 2차 MEDIUM-1)
      if (r.failed > 0) { setCompanyError(wsId, syncFailedMessage(wsId, r)); companyFailed++; }
      // 키 미확보 보류는 "성공"이 아니다 — 무증상이면 셀프호스트의 account_keys 미적용 같은 영구 무동작이 정상으로 보인다(#436 검수 HIGH-2)
      if (r.held) { setCompanyError(wsId, `${wsId}: 계정 키 미확보 — 파일 ${r.held}개 동기화 보류(재시도 중)${accountKeyError() ? ` — ${accountKeyError()}` : ''}`); companyFailed++; }
    } catch (e) {
      // 매니페스트 업로드 거절은 여기로 온다(pro·미확인 경로는 관용 없이 throw) — 파일 거절과 같이 요금제 캐시를 버린다
      if (!freePlan && e?.uploadFailed) invalidatePlanCache();
      // 이번 시도의 결과가 없으니 새 항목으로 — 이전 주기의 failures·↑↓를 이어받으면 지금 오류와 무관한 옛 파일 이름이 같이 보인다(3차 LOW-1)
      status.companies[wsId] = { ts: Date.now() };
      setCompanyError(wsId, `${wsId}: ${String(e.message).slice(0, 120)}`); // 첫 주기에 throw해도 회사로 등록된다(2차 LOW-1)
      console.error(`[argo] 동기화 실패(${wsId}):`, e.message);
      companyFailed++;
    }
  }
  // 모든 회사 동기화 성공 시 스테일 에러 제거 — 회복되면 오래된 에러가 남지 않도록
  if (companyFailed === 0) {
    status.lastError = '';
  }
  status.lastTs = Date.now();
}

/** 즉시 동기화 요청 — 로컬 변경(메시지 전송 등) 직후 호출하면 다음 대기를 건너뛰고 바로 push/pull.
    Next는 라우트·instrumentation 번들이 갈려 모듈 변수가 공유 안 되므로 globalThis로 신호한다(status와 동일 패턴). */
export function nudgeSync() {
  globalThis.__argoSyncPending = true;
  const wake = globalThis.__argoSyncWake;
  if (wake) { globalThis.__argoSyncWake = null; wake(); }
}

export function ensureSync() {
  if (!syncOn()) return;
  if (globalThis.__argoSync) return;
  globalThis.__argoSync = true;
  (async () => {
    if (loadSyncCreds()) {
      try { await ensureClient(); await client().storage.createBucket(BUCKET, { public: false }); } catch { /* 이미 있음 */ }
    }
    console.log(`[argo] 기기 간 동기화 시작 (${Math.round(CYCLE_MS / 1000)}s 주기 · 로컬 변경 시 즉시)`);
    startLeaseLoop(); // 실행 담당 판정은 파일 동기화와 따로(leaseTick)
    for (;;) {
      globalThis.__argoSyncPending = false;
      try { await cycle(); } catch (e) { status.lastError = String(e.message).slice(0, 120); }
      if (globalThis.__argoSyncPending) continue; // 사이클 도중 nudge 도착 → 대기 없이 즉시 재실행
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(t); globalThis.__argoSyncWake = null; resolve(); };
        const t = setTimeout(finish, CYCLE_MS);
        globalThis.__argoSyncWake = finish;
      });
    }
  })();
}
