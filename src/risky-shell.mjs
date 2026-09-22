// 메신저 문맥 턴의 셸 명령 결정적 위험 분류(D28). "AI 방어: 프롬프트는 힌트, 코드가 보장" — 결재가 모델의 request_approval
// 호출에만 달려 있으면 코드가 보장하는 것이 없다(정비사 원장 P-C9: 주인 턴 `rm -rf ./old-reports`가 결재 없이 실행).
// 여기 걸리면 권한 게이트가 이번 실행을 막고 서버 결재 카드를 만든다(permission-gate.mjs). 승인되면 같은 명령을 한 번 허용한다.
// ponytail: 정규식 표(셸 파서 아님) — 변수·별칭·base64로 감춘 명령은 못 잡는다. 금지 구역 리터럴 방어와 같은 1차 방어이고,
// 미탐은 종전(전권 실행)으로 흐른다. 규칙을 늘릴 때는 test/helpers/risky-shell-cases.mjs 표에 양성·음성을 함께 넣는다.
const SEP = String.raw`(?:^|[\s;&|(\x60"'])`; // 명령 시작 경계(줄 처음·공백·; & | ( 백틱·따옴표 — bash -c "rm …"·eval '…' 래퍼 안쪽)
const RM = String.raw`(?:sudo\s+)?(?:\\|(?:/usr)?/bin/)?rm`; // \rm(별칭 우회)·/bin/rm 경로 호출 포함
const GIT = String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+)*`; // git -C repo … 전역 옵션
export const SHELL_RULES = Object.freeze([
  { id: 'recursive-delete', ko: '재귀 삭제', en: 'recursive delete', re: new RegExp(`${SEP}${RM}\\s(?:[^;&|]*\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`) }, // r 플래그 위치 무관(rm -f -r·rm x -rf)
  { id: 'rmdir', ko: '폴더 삭제', en: 'directory removal', re: new RegExp(`${SEP}(?:sudo\\s+)?rmdir\\b`) },
  { id: 'find-delete', ko: '찾아서 삭제', en: 'find -delete', re: /\bfind\b[^;&|]*\s-delete\b|\bfind\b[^;&|]*-exec\s+rm\b/ },
  { id: 'force-push', ko: '강제 푸시', en: 'force push', re: new RegExp(`${GIT}push\\b[^;&|]*\\s(?:-f\\b|--force(?:-with-lease)?\\b|\\+[\\w./-]+)`) }, // +refspec도 강제 푸시
  { id: 'hard-reset', ko: '하드 리셋', en: 'hard reset', re: new RegExp(`${GIT}reset\\b[^;&|]*\\s--hard\\b`) },
  { id: 'git-clean', ko: '추적 안 된 파일 삭제', en: 'git clean', re: new RegExp(`${GIT}clean\\b[^;&|]*\\s-[a-zA-Z]*f`) },
  { id: 'sql-drop', ko: 'DB 삭제(DROP)', en: 'SQL DROP', re: /\bdrop\s+(?:table|database|schema|view|index|function)\b/i },
  { id: 'sql-truncate', ko: 'DB 비우기(TRUNCATE)', en: 'SQL TRUNCATE', re: /\btruncate\s+(?:table\s+)?[\w."]+/i },
  { id: 'sql-delete-all', ko: 'DB 전체 삭제(WHERE 없는 DELETE)', en: 'SQL DELETE without WHERE', re: /\bdelete\s+from\s+[\w."]+(?![^;"']*\bwhere\b)/i },
  { id: 'sql-update-all', ko: 'DB 전체 수정(WHERE 없는 UPDATE)', en: 'SQL UPDATE without WHERE', re: /\bupdate\s+[\w."]+\s+set\b(?![^;"']*\bwhere\b)/i },
  { id: 'secret-file', ko: '시크릿 파일 접근', en: 'secret file access', re: /(?:^|[\s'"=/<>:])(?:\.env(?:\.[\w-]+)?|id_rsa|id_ed25519|\.netrc|\.pgpass)(?=$|[\s'";|&)])|~\/\.ssh\b|\.aws\/credentials\b/ },
  { id: 'pipe-to-shell', ko: '내려받아 바로 실행', en: 'download piped to shell', re: /\b(?:curl|wget)\b[^;&|]*\|\s*(?:sudo\s+)?(?:(?:ba|z|da)?sh|python3?|perl|ruby|node)\b|\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b|(?:\b(?:ba|z|da)?sh\s+-c|\beval)\s+["']?\$\(\s*(?:curl|wget)\b/ }, // | python·bash <(curl)·sh -c "$(curl)"
  { id: 'disk-wipe', ko: '디스크 덮어쓰기', en: 'disk overwrite', re: /\bmkfs(?:\.\w+)?\b|\bdd\s+[^;&|]*\bof=\/dev\// },
  // Windows(K74) — Bash 도구가 PowerShell·cmd 표면을 연다(#448). 둘 다 대소문자 무시. PowerShell 매개변수는 약어가 된다(-r·-rec = -Recurse),
  // cmd는 /s가 재귀다. Remove-Item 별칭 rm·del·erase·ri·rd·rmdir 포함(rm -r·rmdir는 위 POSIX 규칙이 먼저 잡는다).
  { id: 'win-recursive-delete', ko: '재귀 삭제', en: 'recursive delete', re: new RegExp(`${SEP}(?:remove-item|ri|rm|del|erase|rd|rmdir)\\s(?:[^;&|]*\\s)?(?:-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?|/s)\\b`, 'i') },
  { id: 'volume-format', ko: '볼륨 포맷', en: 'volume format', re: new RegExp(`\\bformat-volume\\b|${SEP}format(?:\\.com)?\\s+[a-z]:`, 'i') },
]);

/** 고위험이면 { id, label }, 아니면 null. lang은 label 언어. */
export function classifyShell(command, lang = 'ko') {
  const cmd = String(command ?? '');
  for (const r of SHELL_RULES) if (r.re.test(cmd)) return { id: r.id, label: lang === 'en' ? r.en : r.ko };
  return null;
}
/** 결재·승인 대조용 정규화 — 앞뒤 공백 제거·연속 공백 하나로(같은 명령을 띄어쓰기만 바꿔 재요청해도 같은 결재). */
export const normalizeShell = (command) => String(command ?? '').trim().replace(/\s+/g, ' ');
