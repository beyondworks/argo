// codex app-server 엔진 — 엔진 하네스 전환 P1 (스파이크 실증 2026-08-28, 정본 설계는 루트
// ENGINE-HARNESS-DESIGN.md — 커밋 금지 문서라 여기엔 계약 요지만 남긴다).
//
// 방어 목표(정직 표기 — canUseTool "동형"이 아니다. 분리 검수 HIGH-2 라이브 반증 2026-08-28):
// codex를 read-only 샌드박스 + 전량 승인(approvalPolicy: untrusted)으로 돌려, 셸 실행·파일 패치
// 승인 요청마다 permission-gate 판정을 태운다. 이건 **셸 1차 방어**다 — 세션을 여는 첫 명령은
// 게이트를 지나지만, 승인된 대화형 세션에 write_stdin으로 흘러드는 후속 명령은 승인 훅이 없어
// (벤더 ServerRequest 스키마에 write_stdin 승인 없음) 판정 밖이다. 즉 게이트로 셸 읽기 유출을
// **완전 차단하지는 못한다**. 자격 파일(.secrets.json 계열) 유출의 실질 방어는 at-rest 암호화(P1
// 후속)이고, 이 게이트는 현행 danger-full-access(게이트 전무) 대비 순증이다(회귀 아님).
// 마찬가지로 MCP 도구 호출·view_image는 codex 샌드박스 밖 경로라 이 게이트를 지나지 않는다(HIGH-3).
//
// 계약 근거(전부 2026-08-28 실측 — 재검증은 scripts/runner-contract-probe.mjs):
//  · JSONL 프레이밍(개행 구분 JSON-RPC), initialize→initialized→thread/start→turn/start
//  · 승인 요청: item/commandExecution/requestApproval { command, cwd } — 응답 { decision: 'accept'|'decline' }
//  · 형식 오류 응답은 fail-closed(실행 거부) — 게이트가 죽어도 열리지 않는다
//  · 파일 패치 승인(item/fileChange/requestApproval)은 경로를 직접 싣지 않는다 — 선행 item/started의
//    fileChange 아이템(changes[].path)을 추적해 판정한다. 추적 실패 = 판정 불가 = decline(fail-closed)
//  · 한도 소진은 error 알림의 codexErrorInfo === 'usageLimitExceeded'(+ 재개 시각 문구) — 인증 오류와
//    구분되는 1급 분류(OpenRouter 402/429와 대칭). AUTH_ERR_RE 자가치유를 오발동시키지 않는다.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePermissionGate } from '../permission-gate.mjs';
import { scrubServerSecrets } from './shared.mjs';
import { codexHome, codexCmd, importCodexAuth, recoverCodexAuth, writeCodexTurnConfig, CODEX_EFFORTS } from './codex.mjs';

/** 크루 effort → app-server ReasoningEffort 값(순수). CLI 인자(codexEffortArgs)와 같은 사상 —
    'max'는 Claude 전용 명칭이라 xhigh로. 미지원 값은 null(모델 기본). (export: 회귀 테스트용) */
export function codexEffortValue(effort) {
  const v = String(effort ?? '').trim().toLowerCase();
  const mapped = v === 'max' ? 'xhigh' : v;
  return CODEX_EFFORTS.includes(mapped) ? mapped : null;
}

/** 승인 판정자 — permission-gate를 codex 승인 표면에 사상한다(규칙 사본 금지: 판정은 게이트 함수
    자신이 한다). exec는 Bash 판정(명령 문자열 리터럴 방어), 패치는 경로별 Write 판정.
    반환: 'accept' | 'decline'. 판정 불가(경로 미상·게이트 예외)는 decline — fail-closed.
    (export: 회귀 테스트용) */
export function makeApprovalJudge(wsRoot, { workRoots = [], lang = 'ko' } = {}) {
  const gate = makePermissionGate(null, null, wsRoot, null, lang, workRoots);
  return async function judge(kind, payload) {
    try {
      if (kind === 'exec') {
        const command = String(payload?.command ?? '');
        if (!command) return 'decline';
        return (await gate('Bash', { command })).behavior === 'allow' ? 'accept' : 'decline';
      }
      if (kind === 'patch') {
        const paths = payload?.paths ?? [];
        if (!Array.isArray(paths) || !paths.length) return 'decline'; // 경로 미상 = 판정 불가
        for (const p of paths) {
          if ((await gate('Write', { file_path: String(p) })).behavior !== 'allow') return 'decline';
        }
        return 'accept';
      }
      return 'decline'; // 미지의 승인 종류 — 열지 않는다
    } catch {
      return 'decline'; // 게이트 예외도 닫는 방향
    }
  };
}

/** error 알림 → 정직한 실패(순수). 한도 소진은 limitReached 플래그 + 재개 시각을 남겨 상위(chat)가
    인증 오류(자가치유 러너 교체)와 다르게 다루게 한다. (export: 회귀 테스트용) */
export function mapTurnError(errParams) {
  const info = errParams?.error?.codexErrorInfo ?? errParams?.codexErrorInfo;
  const message = String(errParams?.error?.message ?? errParams?.message ?? '러너 오류');
  if (info === 'usageLimitExceeded' || /usage limit/i.test(message)) {
    const when = message.match(/try again at ([^.]+)/i)?.[1]?.trim();
    return Object.assign(new Error(
      `Codex 구독 사용 한도에 도달했습니다${when ? ` — ${when}에 재개됩니다` : ''}. 다른 러너를 연결해 두면 그동안 크루가 그쪽으로 일합니다. `
      + `Codex usage limit reached${when ? ` — resets at ${when}` : ''}.`,
    ), { limitReached: true, runner: 'codex' });
  }
  return new Error(message.slice(0, 300));
}

/** app-server 1턴 세션(스트림 지향) — 프로세스와 분리해 가짜 스트림으로 행동 테스트가 가능한 이음매.
    input/output = 서버의 stdin(쓰기)/stdout(읽기) 스트림. judge = makeApprovalJudge 산출.
    반환: { reply }. 실패는 throw(mapTurnError·timedOut). (export: 테스트 이음매) */
export function runAppServerSession({ input, output, prompt, model = '', effort = '', cwd, timeoutMs, judge, signal = null }) {
  return new Promise((resolveP, rejectP) => {
    let nextId = 1;
    const pending = new Map();
    let done = false;
    let lastAgentText = '';
    let fatal = null; // willRetry:false error 알림 — turn/completed(failed)보다 원문이 정확하다
    const items = new Map(); // itemId → item (fileChange 경로 추적)
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const write = (obj) => { try { input.write(JSON.stringify(obj) + '\n'); } catch { /* 스트림 사망 — 아래 close가 정리 */ } };
    const send = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      write({ jsonrpc: '2.0', id, method, params });
    });
    const timer = setTimeout(() => {
      write({ jsonrpc: '2.0', id: nextId++, method: 'turn/interrupt', params: {} }); // 베스트에포트 — 실패해도 아래 kill이 정리
      // killed:true — 상위(runners.mjs)가 cliTurnFailure로 kind-aware 문구(잡=쪼개기/대화=SDK 위임)로
      // 덮게 하는 신호(exec 경로의 우리 kill 흔적과 동형). 아래 문구는 그 덮기가 없을 때의 폴백.
      const cap = timeoutMs >= 3_600_000 ? `${Math.round((timeoutMs / 3_600_000) * 10) / 10}시간` : `${Math.round((timeoutMs / 60_000) * 10) / 10}분`;
      finish(rejectP, Object.assign(new Error(`시간 초과: 이 턴이 상한 ${cap}을 넘겨 중단됐습니다. Timed out after the cap.`), { timedOut: true, killed: true }));
    }, timeoutMs); // unref 금지 — 이 타이머가 세션 종결성의 마지막 보루다(스트림이 조용히 죽으면 타이머만 남는다)
    if (signal) signal.addEventListener('abort', () => finish(rejectP, Object.assign(new Error('중단됨'), { aborted: true })), { once: true });

    let buf = '';
    output.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; } // 비JSON 잡음(벤더 로그)은 무시
        handle(m).catch(() => { /* 개별 메시지 처리 실패가 세션을 죽이지 않는다 — 승인은 fail-closed */ });
      }
    });
    // 스트림 종료 = 응답 없이 죽음. stage:'read'로 상위(cliTurnFailure)가 "응답 없이 종료" 진단을
    // 붙이게 한다(exec 경로의 read 단계 ENOENT와 동형). fatal(한도 등)이 있으면 그 원문이 우선.
    output.on('close', () => finish(rejectP, fatal ?? Object.assign(new Error('러너가 응답 없이 종료했습니다(app-server 스트림 종료)'), { stage: 'read' })));

    async function handle(m) {
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) { // 우리 요청의 응답
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.rej(Object.assign(new Error(String(m.error?.message ?? JSON.stringify(m.error))), { rpc: true })) : p.res(m.result); }
        return;
      }
      if (m.id !== undefined && m.method) { // 서버→클라 요청 — 승인이 여기로 온다
        if (/commandExecution\/requestApproval$|^execCommandApproval$/.test(m.method)) {
          const decision = await judge('exec', { command: m.params?.command, cwd: m.params?.cwd });
          write({ jsonrpc: '2.0', id: m.id, result: { decision } });
        } else if (/fileChange\/requestApproval$|^applyPatchApproval$/.test(m.method)) {
          const item = items.get(m.params?.itemId);
          const paths = (item?.changes ?? []).map((c) => c?.path).filter(Boolean);
          const decision = await judge('patch', { paths });
          write({ jsonrpc: '2.0', id: m.id, result: { decision } });
        } else {
          // 미지의 서버 요청(권한 승격·사용자 입력·MCP elicitation 등) — 열어주지 않는다. 형식이 안 맞는
          // 응답에 codex는 fail-closed(스파이크 실측)라, 빈 응답 = 거부 방향으로 수렴한다.
          write({ jsonrpc: '2.0', id: m.id, result: {} });
        }
        return;
      }
      // 알림
      const item = m.params?.item;
      if (item?.id) items.set(item.id, item); // fileChange 경로 추적(승인 시점 참조)
      if (m.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') lastAgentText = item.text;
      if (m.method === 'error' && m.params && m.params.willRetry === false) fatal = mapTurnError(m.params);
      if (m.method === 'turn/completed') {
        const status = m.params?.turn?.status;
        if (status === 'completed') finish(resolveP, { reply: lastAgentText.trim() });
        else finish(rejectP, fatal ?? mapTurnError(m.params?.turn ?? {}));
      }
    }

    (async () => {
      await send('initialize', { clientInfo: { name: 'argo', title: 'Argo', version: '0' } });
      write({ jsonrpc: '2.0', method: 'initialized' });
      const th = await send('thread/start', {
        cwd,
        approvalPolicy: 'untrusted', // 전량 승인 — 게이트가 유일한 판정자다. acceptForSession은 쓰지 않는다(세션 우회 방향)
        sandbox: 'read-only',        // 승인 없는 쓰기 경로 자체를 벤더 수준에서 제거
        ...(model ? { model } : {}),
      });
      const threadId = th?.thread?.id;
      if (!threadId) throw new Error('thread/start가 스레드 id를 주지 않았습니다');
      const eff = codexEffortValue(effort);
      await send('turn/start', { threadId, input: [{ type: 'text', text: prompt }], ...(eff ? { effort: eff } : {}) });
    })().catch((e) => finish(rejectP, e));
  });
}

/** app-server 엔진 1턴 — externalExec의 codex 분기와 같은 인자 계약(홈 격리·auth 반입/회수·MCP 주입
    전부 동일 경로 재사용), 실행 방식만 exec→app-server. ARGO_CODEX_ENGINE=appserver일 때만 탄다. */
export async function execCodexAppServer({ model, cwd, prompt, timeoutMs = 300_000, cred = null, signal = null, effort = '', workRoots = [], mcpServers = null, lang = 'ko' }) {
  const dir = await mkdtemp(join(tmpdir(), 'argo-codex-as-'));
  const baseHome = cred?.home ? cred.home : await codexHome();
  const CODEX_HOME = join(dir, 'home');
  await mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
  const auth = await importCodexAuth(baseHome, CODEX_HOME);
  await writeCodexTurnConfig(CODEX_HOME, mcpServers);
  const cmd = await codexCmd(); // 관리본(핀) 우선 — exec 경로와 같은 조달 규율
  // windowsHide — exec()(shared.mjs)와 동형. 없으면 윈도우 사이드카에서 턴마다 콘솔 창이 뜬다
  // (2026-08-21 제보 계열, 분리 검수 MEDIUM-3). 스폰 실패·비정상 종료는 아래 child 이벤트로 잡는다.
  const child = spawn(cmd.file, [...cmd.args, 'app-server'], {
    cwd,
    env: { ...scrubServerSecrets(process.env, 'codex'), ...(cred?.env ?? {}), CODEX_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
  // child 실패를 세션과 경쟁시킨다(분리 검수 HIGH-1·MEDIUM-2). spawn 'error'(ENOENT 등)는 리스너가
  // 없으면 uncaughtException으로 **상주 프로세스를 죽인다**(exec 경로는 promisify라 자동으로 거절이었다).
  // 'exit'의 종료 코드는 exec 경로가 남기던 신호 — isProcessCrash(shared.mjs)가 'exited with code N'을
  // 봐 윈도우 크래시(0xC0000005) 1회 재시도를 발동시킨다. 정상 완료(session resolve)가 먼저면 무시된다.
  let settled = false;
  const childFail = new Promise((_, rej) => {
    child.on('error', (e) => { if (!settled) rej(Object.assign(e, { stage: 'exec', stderr: stderrTail })); }); // e.code(ENOENT 등) 보존 → apiError가 CLI 미발견 번역
    child.on('exit', (code, sig) => {
      if (settled || code === 0 || code == null) return; // 정상·신호 종료(우리 kill)는 세션 결과가 정한다
      rej(Object.assign(new Error(`app-server exited with code ${code}`), { code, stage: 'exec', stderr: stderrTail }));
    });
  });
  try {
    const { reply } = await Promise.race([
      runAppServerSession({
        input: child.stdin, output: child.stdout,
        prompt, model, effort, cwd, timeoutMs, signal,
        judge: makeApprovalJudge(cwd, { workRoots, lang }),
      }),
      childFail,
    ]);
    settled = true;
    return reply;
  } catch (e) {
    settled = true;
    // 스트림 조기 종료 등 원인 불명은 stderr 꼬리를 붙여 정직하게(키류는 상위 apiError 계열이 마스킹)
    if (!e.timedOut && !e.limitReached && e.stage === 'read' && stderrTail && !e.stderr) {
      e.message += `: ${stderrTail.replace(/\s+/g, ' ').slice(-200)}`;
    }
    throw e;
  } finally {
    try { child.kill(); } catch { /* 이미 종료 */ }
    await recoverCodexAuth(auth).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
