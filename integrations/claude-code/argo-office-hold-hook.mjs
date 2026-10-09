#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅 — 사람이 "보류·미루자·이것부터" 같은 말을 하면, 미루는 일을 오피스에 남기는 명령(argo office hold)을 안내만 한다.
// 서버 호출 0, 파일 쓰기 0. 평범한 입력이면 아무것도 출력하지 않는다(0바이트). 항상 종료 코드 0.
// 안내의 argo office 명령은 모두 훅 폴더(ARGO_ROOT=~/.argo/office-hook)로 부르게 쓰고, 세션 제목(--source-name)을 꼭 넣게 한다.
// 명령은 이 훅과 같은 저장소의 bin/argo.mjs를 이 훅을 돌리는 node로 부른다 — 맥에 설치된 argo가 office 명령이 없는 예전 판이면 안내대로 실행해도 실패했다(10/8 실측).
// 대화 기록에 세션 제목(custom-title)이 있으면 그 제목을 명령에 그대로 넣는다(상태 파일에 남은 읽은 위치부터 이어 읽기 — 쓰지 않는다).
// 사람 입력만 본다: 프롬프트에 붙어 오는 태그 블록(<task-notification>…</task-notification>, <system-reminder>…, <cross-session-message>… 등)을 걷어 낸 뒤에만
// 보류 표현을 찾는다 — 실측 오탐: 작업 완료 알림 본문의 '보류' 낱말에 반응했다.
import { fileURLToPath } from 'node:url';

const HOLD = /보류|미뤄|미루자|미루고|나중에\s*(하자|해|할게)|킵해|킵하고|잠깐\s*(멈추|두고|접어)|이것부터|이거부터|그것부터|먼저\s*하자/;
// 닫는 태그 없이 끝까지 이어지는 블록도 걷어 내는 이름들(알림·시스템 글은 사람이 쓴 글이 아니다)
const OPEN_TO_END = /<(task-notification|system-reminder|cross-session-message|command-[\w-]+|local-command-[\w-]+|bash-[\w-]+|user-prompt-submit-hook)\b[^>]*>[\s\S]*$/i;

/** 태그 블록을 걷어 낸 사람 입력 — 짝이 맞는 <이름 …>…</이름>을 안쪽부터 반복해서 지우고, 닫히지 않은 알림 블록은 끝까지 지운다. */
function humanText(prompt) {
  let s = String(prompt ?? '');
  for (let i = 0; i < 20; i++) {
    const t = s.replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    if (t === s) break;
    s = t;
  }
  return s.replace(OPEN_TO_END, ' ');
}

const lang = /^ko/i.test(process.env.LC_ALL || process.env.LANG || 'ko') ? 'ko' : 'en';
const ENV = 'ARGO_ROOT=~/.argo/office-hook';
/** 셸 작은따옴표 — 제목에 따옴표·$·백틱이 있어도 명령이 그대로 그 글자를 넘긴다 */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ARGO = `${ENV} ${shq(process.execPath)} ${shq(fileURLToPath(new URL('../../bin/argo.mjs', import.meta.url)))}`;
const hint = (title) => {
  const src = title ? shq(title) : null;
  return {
    ko: [
      '[아르고 오피스] 사람이 일을 미루거나 다른 일을 먼저 하자고 했다. 미루는 일이 있으면 오피스 업무 현황에 보류로 남긴다(사람이 원치 않으면 남기지 않는다):',
      `  새 일: ${ARGO} office hold "<미루는 일 제목>" --reason "<보류 사유>" --source-name ${src ?? '"<이 세션 제목>"'}`,
      `  이미 오피스에 있는 일: ${ARGO} office hold --task <할 일 id> --reason "<보류 사유>"  (id는 ${ARGO} office tasks로 찾는다)`,
      src ? `--source-name에는 이 세션 제목(${src})을 그대로 넣는다.` : '--source-name에는 이 세션의 제목을 꼭 넣는다(빠지면 명령이 거절한다).',
      '"이것부터"처럼 먼저 할 일을 정했다면, 그 대상은 미루는 일의 보류 사유에 적는다.',
    ],
    en: [
      '[Argo Office] The person is putting work off or wants to do something else first. If a task is being put off, record it as on hold in Office Work status (skip it if the person does not want that):',
      `  New task: ${ARGO} office hold "<task title>" --reason "<why it is on hold>" --source-name ${src ?? '"<this session title>"'}`,
      `  Task already in Office: ${ARGO} office hold --task <task id> --reason "<why it is on hold>"  (find ids with ${ARGO} office tasks)`,
      src ? `Use this session's title (${src}) for --source-name as is.` : 'Always give this session\'s title in --source-name (the command refuses without it).',
      'If they chose what to do first, write that in the reason of the task being put off.',
    ],
  }[lang].join('\n');
};

async function main() {
  const chunks = [];
  await Promise.race([
    new Promise((resolve) => { process.stdin.on('data', (c) => chunks.push(c)); process.stdin.on('end', resolve); process.stdin.on('error', resolve); }),
    new Promise((r) => setTimeout(r, 2000).unref()),
  ]);
  let input = {};
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return; }
  if (!HOLD.test(humanText(input?.prompt))) return;
  let title = null; // 보류 표현이 있을 때만 읽는다 — 평범한 입력은 모듈도 싣지 않는다
  try {
    const { hookRoot, sessionTitle } = await import('../../src/office-cli.mjs');
    if (typeof input?.session_id === 'string' && typeof input?.transcript_path === 'string') title = await sessionTitle(hookRoot(), input.session_id, input.transcript_path);
  } catch { /* 제목을 못 읽으면 자리표시로 안내한다 */ }
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: hint(title) } });
  await new Promise((r) => process.stdout.write(out, r)); // 맥의 파이프 출력은 비동기 — 다 보낸 뒤에 끝낸다
}

try { await main(); } catch { /* 훅은 대화를 막지 않는다 */ }
process.exit(0);
