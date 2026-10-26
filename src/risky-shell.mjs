// 메신저 문맥 턴의 셸 명령 결정적 위험 분류(D28). "AI 방어: 프롬프트는 힌트, 코드가 보장" — 결재가 모델의 request_approval
// 호출에만 달려 있으면 코드가 보장하는 것이 없다(정비사 원장 P-C9: 주인 턴 `rm -rf ./old-reports`가 결재 없이 실행).
// 여기 걸리면 권한 게이트가 이번 실행을 막고 서버 결재 카드를 만든다(permission-gate.mjs). 승인되면 같은 명령을 한 번 허용한다.
// ponytail: 정규식 표(셸 파서 아님). 검사 전에 deobfuscate가 흔한 철자 비틀기(r\m·"r"m·r''m)·$(echo rm)·R=rm; $R를 풀고,
// 풀지 못한 계산된 명령 이름($(…)·$VAR)에 재귀·강제 플래그가 붙으면 dynamic-command로 잡는다(2026-10-26 총괄 감사 축 A).
// 별칭·base64·파일에서 읽은 명령은 여전히 못 잡는다 — 금지 구역 리터럴 방어와 같은 1차 방어이고, 미탐은 종전(전권 실행)으로 흐른다.
// 규칙을 늘릴 때는 test/helpers/risky-shell-cases.mjs 표에 양성·음성을 함께 넣는다.
const SEP = String.raw`(?:^|[\s;&|(\x60"'])`; // 명령 시작 경계(줄 처음·공백·; & | ( 백틱·따옴표 — bash -c "rm …"·eval '…' 래퍼 안쪽)
const RM = String.raw`(?:sudo\s+)?(?:\\|(?:/usr)?/bin/)?rm`; // \rm(별칭 우회)·/bin/rm 경로 호출 포함
const GIT = String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+)*`; // git -C repo … 전역 옵션
// 한 정규식에 중첩 탐색을 넣으면 긴 입력에서 제곱 시간이 된다 — any(하나라도) 또는 every(모두)로 나눈 검사. re.test와 같은 모양
const allOf = (any, every) => {
  const a = any ? new RegExp(any) : null; const e = every.map((x) => new RegExp(x));
  return { test: (s) => (a ? a.test(s) : false) || e.every((r) => r.test(s)) };
};
export const SHELL_RULES = Object.freeze([
  { id: 'recursive-delete', ko: '재귀 삭제', en: 'recursive delete', re: new RegExp(`${SEP}${RM}\\s(?:[^;&|]*\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`) }, // r 플래그 위치 무관(rm -f -r·rm x -rf)
  { id: 'rmdir', ko: '폴더 삭제', en: 'directory removal', re: new RegExp(`${SEP}(?:sudo\\s+)?rmdir\\b`) },
  { id: 'find-delete', ko: '찾아서 삭제', en: 'find -delete', re: /\bfind\b[^;&|]*\s-delete\b|\bfind\b[^;&|]*-exec(?:dir)?\s+(?:sudo\s+)?(?:\S*\/)?(?:rm|shred|unlink)\b/ }, // -exec /bin/rm·-execdir
  { id: 'xargs-delete', ko: '목록 받아 삭제(xargs)', en: 'xargs delete', re: /\bxargs\b[^;&|]*\s(?:sudo\s+)?(?:\S*\/)?(?:rm|shred|unlink)\b/ },
  { id: 'glob-delete', ko: '여러 파일 삭제(와일드카드)', en: 'wildcard delete', re: new RegExp(`${SEP}${RM}\\s(?:[^;&|]*\\s)?[^\\s;&|]*[*?][^\\s;&|]*`) }, // rm -f *.md·rm build/*
  { id: 'force-push', ko: '강제 푸시', en: 'force push', re: new RegExp(`${GIT}push\\b[^;&|]*\\s(?:-f\\b|--force(?:-with-lease)?\\b|\\+[\\w./-]+)`) }, // +refspec도 강제 푸시
  { id: 'remote-delete', ko: '원격 브랜치 삭제', en: 'remote branch delete', re: new RegExp(`${GIT}push\\b[^;&|]*\\s(?:--delete\\b|-d\\b|--mirror\\b|--prune\\b|:[\\w./-]+)`) }, // push origin :main = 원격 삭제
  { id: 'branch-force-delete', ko: '브랜치 강제 삭제', en: 'force branch delete', re: allOf(`${GIT}branch\\b[^;&|]*\\s-[a-zA-Z]*D\\b`, [`${GIT}branch\\b[^;&|]*\\s(?:-d|--delete)\\b`, `${GIT}branch\\b[^;&|]*\\s(?:-f|--force)\\b`]) }, // -D = -d -f(병합 안 된 브랜치도 지움). 중첩 탐색 대신 검사를 나눠 긴 입력에서도 선형
  { id: 'discard-changes', ko: '작업 내용 되돌림', en: 'discard local changes', re: new RegExp(`${GIT}(?:checkout|restore)\\b[^;&|]*\\s(?:--\\s+)?(?:\\.|:/|\\*)(?=$|[\\s;&|])`) }, // checkout -- .·restore . (파일 하나는 제외)
  { id: 'stash-drop', ko: '보관 내용 삭제(stash)', en: 'stash drop', re: new RegExp(`${GIT}stash\\s+(?:drop|clear)\\b`) },
  { id: 'hard-reset', ko: '하드 리셋', en: 'hard reset', re: new RegExp(`${GIT}reset\\b[^;&|]*\\s--hard\\b`) },
  { id: 'git-clean', ko: '추적 안 된 파일 삭제', en: 'git clean', re: new RegExp(`${GIT}clean\\b[^;&|]*\\s-[a-zA-Z]*f`) },
  { id: 'rsync-delete', ko: '동기화하며 삭제(rsync --delete)', en: 'rsync --delete', re: /\brsync\b[^;&|]*\s--delete(?:-[a-z]+)*\b/ },
  { id: 'move-to-null', ko: '파일을 /dev/null로 이동', en: 'move to /dev/null', re: /\bmv\b[^;&|]*\s\/dev\/null\b/ },
  { id: 'file-truncate', ko: '파일 비우기', en: 'file truncate', re: /\btruncate\s+(?:[^;&|]*\s)?(?:-s\s*0\b|--size[= ]0\b)/ },
  { id: 'shred', ko: '파일 파쇄', en: 'shred', re: new RegExp(`${SEP}(?:sudo\\s+)?shred\\b`) },
  { id: 'unlink', ko: '파일 삭제(unlink)', en: 'unlink', re: new RegExp(`${SEP}(?:sudo\\s+)?unlink\\s`) },
  { id: 'rimraf', ko: '재귀 삭제(rimraf)', en: 'rimraf', re: new RegExp(`${SEP}(?:npx\\s+(?:-y\\s+)?)?rimraf(?![\\w-])`) }, // yarn rimraf-check 같은 스크립트 이름은 제외
  { id: 'script-delete', ko: '스크립트로 삭제', en: 'delete via inline script', re: allOf(null, [String.raw`\b(?:python[\d.]*|node|bun|deno)\b[^\n]*?\s(?:-c|-e|--eval|eval)\s`, String.raw`shutil\.rmtree|os\.remove|os\.unlink|\brmSync\b|\brmdirSync\b|\bunlinkSync\b|fs\.(?:promises\.)?rm\s*\(`]) }, // python -c …rmtree·node -e …rmSync(인라인 실행 + 삭제 API가 함께 있을 때)
  { id: 'docker-prune', ko: '도커 정리(prune)', en: 'docker prune', re: /\bdocker\b[^;&|]*\s(?:(?:system|volume|image|container|network|builder)\s+)?prune\b/ },
  { id: 'kubectl-delete', ko: '쿠버네티스 삭제', en: 'kubectl delete', re: /\bkubectl\b[^;&|]*\sdelete\b/ },
  { id: 'gh-delete', ko: 'GitHub 저장소·릴리스 삭제', en: 'GitHub repo/release delete', re: /\bgh\s+(?:repo|release)\s+delete\b/ },
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

// 계산된 명령 이름 — 정규화로 풀지 못한 $(…)·`…`·$VAR가 명령 자리에 있고 재귀·강제 플래그가 붙었다(정체를 모르는 삭제일 수 있다)
const DYNAMIC = Object.freeze({ id: 'dynamic-command', ko: '계산된 명령(정체 불명) 재귀·강제 실행', en: 'computed command with recursive/force flags',
  re: /(?:^|[;&|(\n]\s*|\b(?:sudo|env|command|exec|xargs)\s+)(?:\$\(|\$\{?[A-Za-z_]|\x60)[^;&|\n]{0,200}?\s(?:-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b|--force\b|-delete\b)/ });

/** 검사용 정규화(셸 파서 아님) — 역슬래시 해제(r\m)·따옴표 제거("r"m·r''m·짝 안 맞는 따옴표로 뒤를 문자열로 숨기기)·
 *  $(echo X)·`echo X`·$(printf X) 풀기·같은 줄의 NAME=값 대입을 $NAME·${NAME}에 넣기. 원문 검사와 함께 쓴다(둘 중 하나라도 걸리면 고위험). */
export function deobfuscate(command) {
  let s = String(command ?? '').replace(/\\(?=[\w./-])/g, '').replace(/["']/g, '');
  for (let i = 0; i < 3; i++) {
    const vars = new Map();
    for (const m of s.matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=([^\s;&|()]+)/g)) vars.set(m[1], m[2]);
    const next = s
      .replace(/\$\(\s*(?:echo|printf)\s+(?:-\w+\s+)*([^()\x60;&|]*?)\s*\)/g, '$1')
      .replace(/\x60\s*(?:echo|printf)\s+(?:-\w+\s+)*([^()\x60;&|]*?)\s*\x60/g, '$1')
      .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, a, b) => vars.get(a ?? b) ?? all);
    if (next === s) break;
    s = next;
  }
  return s;
}

/** 고위험이면 { id, label }, 아니면 null. lang은 label 언어. 원문과 정규화본을 모두 본다. */
export function classifyShell(command, lang = 'ko') {
  const cmd = String(command ?? '');
  const plain = deobfuscate(cmd);
  for (const r of [...SHELL_RULES, DYNAMIC]) if (r.re.test(cmd) || r.re.test(plain)) return { id: r.id, label: lang === 'en' ? r.en : r.ko };
  return null;
}
/** 결재·승인 대조용 정규화 — 앞뒤 공백 제거·연속 공백 하나로(같은 명령을 띄어쓰기만 바꿔 재요청해도 같은 결재). */
export const normalizeShell = (command) => String(command ?? '').trim().replace(/\s+/g, ' ');
