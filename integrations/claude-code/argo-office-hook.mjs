#!/usr/bin/env node
// Claude Code 훅(Stop·UserPromptSubmit·PostToolUse에 같은 파일을 등록) — 이 세션을 아르고 오피스 '업무 현황'에 알린다(설계 2026-10-08).
// 입력(stdin): 세 이벤트 모두 { session_id, transcript_path, cwd, hook_event_name, … } — 이 훅은 앞의 셋만 쓴다(prompt·tool_input·tool_response는 보지 않는다).
// 이름을 붙인 세션만 보고한다: 대화 기록의 마지막 세션 제목(custom-title)이 없으면 부르지 않는다(총괄 결정 10/8 — 헤드리스 자동 실행 세션이 하루 200개 넘게 생긴다).
// 올리는 것: 세션 id·제목·프로젝트 폴더 이름·맡은 할 일 id(argo office report --task로 정한 것). 대화 내용·프롬프트는 올리지 않는다.
// 프로젝트 폴더 이름은 그 세션을 처음 본 이벤트의 cwd로 고정한다 — 세션이 cd로 폴더를 오갈 때마다 값이 바뀌어 4분 판정을 건너뛰지 않게(재검증 10/8: 한 세션 cwd 8~14개).
// 서버가 할 일을 붙이지 않았다고 답하면(task=false — 그사이 남에게 다시 맡겨짐) 들고 있던 할 일 id를 지운다 — 낡은 id를 계속 보내지 않게.
// 판정은 로컬에서 먼저 한다: 마지막으로 보낸 값과 같고 4분 안이면 호출 0(상태 파일 ~/.argo/office-hook/sessions.json). 그래서 이벤트를 셋으로 늘려도
// 서버 호출 수는 그대로다(세션당 4분에 1번 또는 값이 바뀔 때) — 긴 턴 중에도 연결 표시가 끊기지 않게 하려고 셋에 건다.
// 실패 뒤 쉬기: 네트워크·로그인 실패는 1분, 영구 거절(권한·입력)은 보낼 값(조직 포함)이 바뀌거나 6시간이 지날 때까지.
// 인증은 훅 전용 폴더(~/.argo/office-hook)의 기기 세션 — 앱·상주·CLI와 refresh 토큰을 나눠 쓰지 않는다. 조직 id는 같은 폴더의 config.json { org }.
// 항상 종료 코드 0이고 아무것도 출력하지 않는다(대화를 막지 않는다 — UserPromptSubmit의 출력은 대화에 들어가므로 특히). 서버 호출은 3초 제한 — 단 토큰 회전 중에는 끊지 않는다
// (회전 응답을 받기 전에 끊으면 서버만 새 토큰을 갖고 이쪽은 옛 토큰이 남아 세션이 폐기된다, src/devicesession.mjs). 회전은 1시간에 한 번이다.
// '부르지 않음' 경로는 node 내장 모듈과 src/office-cli.mjs(내장만 불러온다)만 싣는다 — 기기 세션·supabase-js는 부를 때만 불러온다.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hookRoot, readOfficeConfig, readState, updateState, shouldReport, scanTitle, oneLine, reportSession, sentKey, NAME_MAX, REPORT_EVERY_MS, PERMANENT_DENY } from '../../src/office-cli.mjs';

const NET_MS = 3000;
const LOCK_MS = 2000; // 상태 파일 잠금을 기다리는 한도 — 못 잡으면 이번 이벤트는 건너뛴다
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readStdin(ms = 2000) {
  const chunks = [];
  const done = new Promise((resolve) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });
  await Promise.race([done, new Promise((r) => setTimeout(r, ms).unref())]);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

async function main() {
  const input = await readStdin();
  const id = String(input?.session_id ?? '');
  if (!UUID.test(id)) return;
  const root = hookRoot();
  if (!existsSync(join(root, '.device-session.json'))) return; // 로그인 안 함 — 설치 전이거나 꺼 둔 것. 호출 0
  const { org } = await readOfficeConfig(root);
  if (!org) return;

  const now = Date.now();
  const prev = (await readState(root))[id] ?? {};
  // 제목 — 지난번에 읽은 곳부터만 읽는다(기록 파일이 바뀌었으면 처음부터)
  const file = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const scan = file && existsSync(file)
    ? await scanTitle(file, prev.file === file ? { from: prev.offset ?? 0, title: prev.title ?? null } : {})
    : { title: null, offset: 0 };
  const folder = typeof input.cwd === 'string' && input.cwd ? oneLine(basename(input.cwd), NAME_MAX) : '';
  // 잠금 안에서 다시 읽은 이 세션 항목만 고친다 — 그사이 argo office report --task가 정한 task를 지우지 않는다
  const project = prev.project !== undefined ? prev.project : folder || null; // 처음 본 cwd로 고정
  const look = { file, offset: scan.offset, title: scan.title, seen: now, project };
  const lookChanged = prev.file !== file || prev.offset !== scan.offset || prev.title !== scan.title || prev.project !== project || !(now - (Number(prev.seen) || 0) < REPORT_EVERY_MS);
  const put = (patch) => updateState(root, (s) => { s[id] = { ...s[id], ...look, ...patch }; }, { now, timeoutMs: LOCK_MS });

  const name = scan.title ? oneLine(scan.title, NAME_MAX) : '';
  const next = { org, name, project, task: prev.task ?? null };
  if (!name || !shouldReport(prev, next, now)) { // 이름 없는 세션이거나 보낼 때가 아니다 — 읽은 위치만 남긴다(바뀌었을 때만 쓴다)
    if (lookChanged) await put({});
    return;
  }
  // 부르기 전에 '실패'로 먼저 적는다 — 시간 제한으로 끊겨도 다음 이벤트부터 1분은 다시 부르지 않는다. 성공하면 바로 지운다.
  await put({ failAt: now });

  const { getFreshDeviceSession } = await import('../../src/devicesession.mjs');
  const fresh = async (o) => {
    const s = await getFreshDeviceSession(o);
    setTimeout(() => process.exit(0), NET_MS + 500).unref(); // 세션을 얻은 뒤(회전이 끝난 뒤)부터 — 서버 호출이 제한을 넘기면 끝낸다
    return s;
  };
  const r = await reportSession({ root, ...next, id, timeoutMs: NET_MS, _fresh: fresh });
  if (r.ok) {
    const sent = r.task ? next : { ...next, task: null };
    await put({ sent, at: Date.now(), failAt: 0, denyAt: 0, denyKey: null, ...(r.task ? {} : { task: null }) });
    return;
  }
  // 영구 거절은 같은 값을 6시간 동안 다시 보내지 않는다. 로그인 없음·네트워크는 failAt이 남아 1분 쉰다.
  if (r.error && PERMANENT_DENY.test(r.error)) await put({ failAt: 0, denyAt: Date.now(), denyKey: sentKey(next) });
}

try { await main(); } catch { /* 훅은 대화를 막지 않는다 */ }
process.exit(0);
