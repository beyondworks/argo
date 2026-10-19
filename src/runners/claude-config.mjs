// Claude(Anthropic) SDK 턴의 설정 폴더 격리 — 사용자 ~/.claude에 Argo 대화 전사를 남기지 않는다.
// 제보 2026-10-15: Claude만 연결한 사용자의 ChatGPT 앱 목록에 "Argo" 대화가 수십 개 쌓였다. SDK CLI는 CLAUDE_CONFIG_DIR이 없으면
// ~/.claude/projects/<작업 폴더>/<세션>.jsonl에 전사를 쓰고(제목 customTitle "Argo"), ChatGPT의 'Claude 정보 가져오기'가 그 폴더를 읽는다.
// 설정 폴더만 바꾸면 "이 컴퓨터 로그인(host)"이 끊긴다(임시 HOME 실측: "Not logged in") — CLI가 자격 저장소 이름·위치를 설정 폴더에서 정하기 때문이다.
// CLAUDE_SECURESTORAGE_CONFIG_DIR=''이면 자격은 종전 자리(맥 키체인 "Claude Code-credentials" 접미사 없음 · ~/.claude/.credentials.json)를 쓴다(동봉 CLI 0.3.280 판독 + 파일 저장소 실측).
// 윈도우 host는 격리하지 않는다 — CLI가 자격 증명 관리자 사용 여부를 설정 폴더 안 .claude.json 플래그로 골라 새 폴더에서 끊길 수 있고, 실측하지 못했다.
import { copyFile, cp, mkdir, readdir, stat } from 'node:fs/promises';
import { constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let __mkdirWarned = false;

/** claude 러너 턴 env에 덮을 값. tokenCred = 회사 자격(API 키·구독 토큰)이 env로 실리는 턴인가 — 아니면 host 로그인·호스트 env 폴백. */
export function claudeConfigEnv(wsId, { tokenCred = false, platform = process.platform } = {}) {
  if (!tokenCred && platform === 'win32') return {}; // 윈도우 host·폴백은 종전 그대로(위 주석)
  // 접두 claude-config-는 msgr-recall(sdkConfigDirs)이 전사 폴더 후보로 읽는 이름이다. cl-는 호환 러너(ws-·hostfb-)와 폴더를 나눈다 —
  // 그쪽은 호스트 로그인을 일부러 못 보게 한 폴더라 .claude.json을 같이 쓰지 않는다.
  const dir = join(homedir(), '.argo', `claude-config-cl-${wsId}`);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
    if (!__mkdirWarned) { __mkdirWarned = true; console.warn(`[argo] Claude 설정 폴더 생성 실패(계속 진행): ${e?.code ?? e?.message ?? e}`); }
  }
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' };
}

/** 격리 전 설정 폴더 후보 — 사용자 ~/.claude와 이 프로세스의 CLAUDE_CONFIG_DIR(Claude Code 안에서 실행 등). */
const legacyDirs = (toDir) => [...new Set([process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter((d) => d && d !== toDir))];

async function findSession(dir, sessionId) {
  let projects = [];
  try { projects = await readdir(join(dir, 'projects')); } catch { return null; }
  for (const p of projects) {
    const f = join(dir, 'projects', p, `${sessionId}.jsonl`);
    if (await stat(f).then((s) => s.isFile(), () => false)) return { project: p, file: f };
  }
  return null;
}

/** 이어 쓸 세션이 격리 폴더에 없고 옛 설정 폴더에 있으면 **복사**한다(원본 보존 — 사용자 데이터). 맥락이 끊기지 않게 하는 것이 목적이고,
    실패해도 던지지 않는다 — 그러면 CLI가 "No conversation found"를 내고 종전 새 세션 재시도로 간다. 반환: 복사했으면 true. */
export async function adoptLegacyTranscript(toDir, sessionId) {
  try {
    if (!toDir || !SESSION_ID.test(String(sessionId ?? ''))) return false;
    if (await findSession(toDir, sessionId)) return false; // 이미 있다 — 덮지 않는다
    for (const dir of legacyDirs(toDir)) {
      const hit = await findSession(dir, sessionId);
      if (!hit) continue;
      const dest = join(toDir, 'projects', hit.project);
      await mkdir(dest, { recursive: true, mode: 0o700 });
      await copyFile(hit.file, join(dest, `${sessionId}.jsonl`), constants.COPYFILE_EXCL);
      const sub = join(dir, 'projects', hit.project, sessionId); // 같은 이름 폴더(서브에이전트 전사)
      if (await stat(sub).then((s) => s.isDirectory(), () => false)) await cp(sub, join(dest, sessionId), { recursive: true, force: false, errorOnExist: false });
      return true;
    }
  } catch (e) {
    console.warn(`[argo] 이전 Claude 세션 복사 실패(새 세션으로 진행될 수 있음): ${e?.code ?? e?.message ?? e}`);
  }
  return false;
}
