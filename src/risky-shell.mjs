// 메신저 문맥 턴의 셸 명령 결정적 위험 분류(D28). "AI 방어: 프롬프트는 힌트, 코드가 보장" — 결재가 모델의 request_approval
// 호출에만 달려 있으면 코드가 보장하는 것이 없다(정비사 원장 P-C9: 주인 턴 `rm -rf ./old-reports`가 결재 없이 실행).
// 여기 걸리면 권한 게이트가 이번 실행을 막고 서버 결재 카드를 만든다(permission-gate.mjs). 승인되면 같은 명령을 한 번 허용한다.
// ponytail: 정규식 표(셸 파서 아님). 검사 전에 deobfuscate가 흔한 철자 비틀기(r\m·"r"m·r''m)·$(echo rm)·R=rm; $R를 풀고,
// 풀지 못한 계산된 명령 이름($(…)·$VAR)에 재귀·강제 플래그가 붙으면 dynamic-command로 잡는다(2026-10-26 총괄 감사 축 A).
// 별칭·base64·파일에서 읽은 명령은 여전히 못 잡는다 — 금지 구역 리터럴 방어와 같은 1차 방어이고, 미탐은 종전(전권 실행)으로 흐른다.
// 규칙을 늘릴 때는 test/helpers/risky-shell-cases.mjs 표에 양성·음성을 함께 넣는다.
// 성능: 규칙 다수가 `X[^;&|]*\s…` 모양이라 X가 되풀이된 긴 입력에서 제곱 시간이 된다(옛 규칙도 같았다). 판정은 메신저 턴마다 서버에서 동기로
// 돌므로 MAX_CLASSIFY를 넘는 명령은 정규식을 돌리지 않고 결재로 보낸다(fail-closed, 분리 검수 HIGH: `$(echo ` + 공백 4천 자에 49초).
const SEP = String.raw`(?:^|[\s;&|(\x60"'])`; // 명령 시작 경계(줄 처음·공백·; & | ( 백틱·따옴표 — bash -c "rm …"·eval '…' 래퍼 안쪽)
const RM = String.raw`(?:sudo\s+)?(?:\\|(?:/usr)?/bin/)?rm`; // \rm(별칭 우회)·/bin/rm 경로 호출 포함
// 명령 자리(공백이 아니라 줄 처음·; & | ( 백틱 뒤, 또는 sudo·env·bash -c 같은 감싸는 명령 뒤) — 검색어·커밋 문구 속 낱말(grep unlink·"rm old files?")을 명령으로 보지 않는다
const CMD = String.raw`(?:^|[;&|(\n\x60]\s*|\b(?:sudo|doas|env|command|exec|nice|nohup|eval|(?:ba|z|da)?sh\s+-c|xargs(?:\s+-{1,2}[\w-]+(?:[= ][^\s;&|]+)?)*)\s+)`; // 따옴표는 경계가 아니다(git grep "rimraf") — bash -c "…"는 정규화본(따옴표 제거)에서 sh -c 뒤로 잡는다
export const MAX_CLASSIFY = 4096; // 이보다 긴 명령은 분류하지 않고 결재(oversized-command)
const GIT = String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+)*`; // git -C repo … 전역 옵션
// 한 정규식에 중첩 탐색을 넣으면 긴 입력에서 제곱 시간이 된다 — any(하나라도) 또는 every(모두)로 나눈 검사. re.test와 같은 모양
// every는 명령 한 토막(; & | 줄바꿈 사이) 안에서 모두 맞아야 한다 — `git branch -d a && git branch -f main x`를 합쳐 보지 않게(분리 검수)
const allOf = (any, every, { segment = false } = {}) => {
  const a = any ? new RegExp(any) : null; const e = every.map((x) => new RegExp(x));
  const all = (t) => e.length > 0 && e.every((r) => r.test(t));
  return { test: (s) => (a ? a.test(s) : false) || (segment ? String(s).split(/[;&|\n]/).some(all) : all(String(s))) };
};
// 맞되 제외 조건이 같은 토막에 있으면 아니다(git restore --staged ., git checkout -p .)
const butNot = (re, not) => ({ test: (s) => String(s).split(/[;&|\n]/).some((seg) => re.test(seg) && !not.test(seg)) });
export const SHELL_RULES = Object.freeze([
  { id: 'recursive-delete', ko: '재귀 삭제', en: 'recursive delete', re: new RegExp(`${SEP}${RM}\\s(?:[^;&|]*\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\\b`) }, // r 플래그 위치 무관(rm -f -r·rm x -rf)
  { id: 'rmdir', ko: '폴더 삭제', en: 'directory removal', re: new RegExp(`${SEP}(?:sudo\\s+)?rmdir\\b`) },
  { id: 'find-delete', ko: '찾아서 삭제', en: 'find -delete', re: /\bfind\b[^;&|]*\s-delete\b|\bfind\b[^;&|]*-exec(?:dir)?\s+(?:sudo\s+)?(?:\S*\/)?(?:rm|shred|unlink)\b/ }, // -exec /bin/rm·-execdir
  { id: 'xargs-delete', ko: '목록 받아 삭제(xargs)', en: 'xargs delete', re: /\bxargs(?:\s+-{1,2}[\w-]+(?:[= ][^\s;&|]+)?)*?\s+(?:sudo\s+)?(?:\S*\/)?(?:rm|shred|unlink)\b/ }, // xargs 옵션 바로 뒤의 명령만(xargs grep "rm "은 아니다)
  { id: 'glob-delete', ko: '여러 파일 삭제(와일드카드)', en: 'wildcard delete', re: new RegExp(`${CMD}${RM}\\s(?:[^;&|]*\\s)?[^\\s;&|]*[*?][^\\s;&|]*`) }, // rm -f *.md·rm build/* (명령 자리의 rm만 — 커밋 문구 "rm old files?"는 아니다)
  { id: 'force-push', ko: '강제 푸시', en: 'force push', re: new RegExp(`${GIT}push\\b[^;&|]*\\s(?:-f\\b|--force(?:-with-lease)?\\b|\\+[\\w./-]+)`) }, // +refspec도 강제 푸시
  { id: 'remote-delete', ko: '원격 브랜치 삭제', en: 'remote branch delete', re: new RegExp(`${GIT}push\\b[^;&|]*\\s(?:--delete\\b|-d\\b|--mirror\\b|--prune\\b|:[\\w./-]+)`) }, // push origin :main = 원격 삭제
  { id: 'branch-force-delete', ko: '브랜치 강제 삭제', en: 'force branch delete', re: allOf(`${GIT}branch\\b[^;&|]*\\s-[a-zA-Z]*D\\b`, [`${GIT}branch\\b[^;&|]*\\s(?:-d|--delete)\\b`, `${GIT}branch\\b[^;&|]*\\s(?:-f|--force)\\b`], { segment: true }) }, // -D = -d -f(병합 안 된 브랜치도 지움). 중첩 탐색 대신 검사를 나눠 긴 입력에서도 선형
  { id: 'discard-changes', ko: '작업 내용 되돌림', en: 'discard local changes', re: butNot(new RegExp(`${GIT}(?:checkout|restore)\\b[^;&|]*\\s(?:--\\s+)?(?:\\.|:/|\\*)(?=$|[\\s;&|])|${GIT}checkout\\b[^;&|]*\\s(?:-f|--force)\\b`), /\s(?:-p|--patch)\b|\brestore\b(?=[^;&|]*\s(?:--staged|-S)\b)(?![^;&|]*\s(?:--worktree|-W)\b)/) }, // checkout -- .·restore .·checkout -f (파일 하나·--staged만·-p 대화형은 제외)
  { id: 'stash-drop', ko: '보관 내용 삭제(stash)', en: 'stash drop', re: new RegExp(`${GIT}stash\\s+(?:drop|clear)\\b`) },
  { id: 'hard-reset', ko: '하드 리셋', en: 'hard reset', re: new RegExp(`${GIT}reset\\b[^;&|]*\\s--hard\\b`) },
  { id: 'git-clean', ko: '추적 안 된 파일 삭제', en: 'git clean', re: new RegExp(`${GIT}clean\\b[^;&|]*\\s-[a-zA-Z]*f`) },
  { id: 'rsync-delete', ko: '동기화하며 삭제(rsync --delete)', en: 'rsync --delete', re: /\brsync\b[^;&|]*\s--delete(?:-[a-z]+)*\b/ },
  { id: 'move-to-null', ko: '파일을 /dev/null로 이동', en: 'move to /dev/null', re: /(?:^|[;&|(\n]\s*|\bsudo\s+)mv\b[^;&|>]*\s\/dev\/null\b/ }, // 출력 버리기(> /dev/null)는 아니다
  { id: 'file-truncate', ko: '파일 비우기', en: 'file truncate', re: /\btruncate\s+(?:[^;&|]*\s)?(?:-s\s*0\b|--size[= ]0\b)/ },
  { id: 'shred', ko: '파일 파쇄', en: 'shred', re: new RegExp(`${CMD}shred\\b`) }, // 명령 자리만(grep -rn shred lib은 아니다)
  { id: 'unlink', ko: '파일 삭제(unlink)', en: 'unlink', re: new RegExp(`${CMD}unlink\\s`) }, // npm unlink·grep unlink은 아니다
  { id: 'rimraf', ko: '재귀 삭제(rimraf)', en: 'rimraf', re: new RegExp(`${CMD}(?:(?:npx|pnpm\\s+dlx|bunx)\\s+(?:-y\\s+)?)?rimraf(?![\\w-])`) }, // npm i rimraf·yarn rimraf-check는 아니다
  { id: 'script-delete', ko: '스크립트로 삭제', en: 'delete via inline script', re: allOf(null, [String.raw`\b(?:python[\d.]*|node|bun|deno)\b[^\n]*?\s(?:-c|-e|--eval|eval)\s`, String.raw`shutil\.rmtree|os\.remove|os\.unlink|\brmSync\b|\brmdirSync\b|\bunlinkSync\b|fs\.(?:promises\.)?rm\s*\(`]) }, // python -c …rmtree·node -e …rmSync(인라인 실행 + 삭제 API가 함께 있을 때)
  { id: 'docker-prune', ko: '도커 정리·볼륨 삭제', en: 'docker prune / volume delete', re: /\bdocker\b[^;&|]*\s(?:(?:system|volume|image|container|network|builder)\s+)?prune\b|\bdocker\s+(?:volume\s+rm|(?:container\s+)?rm)\b|\bdocker[\s-]compose\b[^;&|]*\sdown\b[^;&|]*\s(?:-v|--volumes)\b/ }, // compose down -v·volume rm·docker rm(run --rm은 아니다)
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
// 플래그는 rm식 재귀+강제 묶음(-rf·-fr·-Rf·-rfv…)·--recursive·-delete만 — $PIP -r·$PAGER -R·$CC -Werror·$JAVA -version·build.sh --force는 아니다(분리 검수 과차단)
const DYNAMIC = Object.freeze({ id: 'dynamic-command', ko: '계산된 명령(정체 불명) 재귀 삭제 모양', en: 'computed command with recursive-delete flags',
  re: /(?:^|[;&|(\n]\s*|\b(?:sudo|env|command|exec|xargs)\s+)(?:\$\(|\$\{?[A-Za-z_]|\x60)[^;&|\n]{0,200}?\s(?:-(?=[rRfFiIvd]*[rR])(?=[rRfFiIvd]*f)[rRfFiIvd]+\b|--recursive\b|-delete\b)/ });
const OVERSIZED = Object.freeze({ id: 'oversized-command', ko: '너무 긴 명령(분류 생략)', en: 'command too long to classify' });

// $(echo X)·`echo X`·$(printf X) 풀기 — 정규식 대신 직접 훑는다(`\s+`·게으른 `[^…]*?`·`\s*`가 같은 공백을 나눠 가지며 세제곱 시간이 됐다, 분리 검수 HIGH)
function unwrapEcho(s) {
  let out = ''; let i = 0;
  for (;;) {
    const a = s.indexOf('$(', i); const b = s.indexOf('\x60', i);
    const at = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (at < 0) return out + s.slice(i);
    const tick = s[at] === '\x60';
    const open = at + (tick ? 1 : 2);
    const close = s.indexOf(tick ? '\x60' : ')', open);
    const inner = close < 0 ? null : s.slice(open, close).trim().match(/^(?:echo|printf)\s+((?:-\w+\s+)*)(.*)$/s);
    if (!inner || /[()\x60;&|]/.test(inner[2])) { out += s.slice(i, open); i = open; continue; }
    out += s.slice(i, at) + inner[2].trim(); i = close + 1;
  }
}

/** 검사용 정규화(셸 파서 아님) — 역슬래시 해제(r\m)·따옴표 제거("r"m·r''m·짝 안 맞는 따옴표로 뒤를 문자열로 숨기기)·
 *  $(echo X)·`echo X`·$(printf X) 풀기·같은 줄의 NAME=값 대입을 $NAME·${NAME}에 넣기. 원문 검사와 함께 쓴다(둘 중 하나라도 걸리면 고위험). */
export function deobfuscate(command) {
  let s = String(command ?? '')
    .replace(/\\\r?\n/g, '') // 역슬래시+줄바꿈 줄 잇기(r\⏎m = rm)
    .replace(/\$\{?IFS\}?/g, ' ') // $IFS·${IFS} = 공백
    .replace(/\\(?=[\w./-])/g, '').replace(/["']/g, '')
    .replace(/\{([^{},\s]+(?:,[^{},\s]+)+)\}/g, (_, x) => x.split(',').join(' ')); // 중괄호 확장 {rm,-rf,x} → rm -rf x
  const cap = Math.max(s.length * 2, 1024); // 변수 치환이 결과를 폭증시키지 않게(분리 검수: 1.4KB 입력이 RangeError)
  for (let i = 0; i < 3; i++) {
    const vars = new Map();
    for (const m of s.matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_]\w*)=([^\s;&|()]+)/g)) vars.set(m[1], m[2]);
    const next = unwrapEcho(s).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, a, b) => vars.get(a ?? b) ?? all);
    if (next === s || next.length > cap) break;
    s = next;
  }
  return s;
}

/** 고위험이면 { id, label }, 아니면 null. lang은 label 언어. 원문과 정규화본을 모두 본다. */
export function classifyShell(command, lang = 'ko') {
  const cmd = String(command ?? '');
  if (cmd.length > MAX_CLASSIFY) return { id: OVERSIZED.id, label: lang === 'en' ? OVERSIZED.en : OVERSIZED.ko };
  const plain = deobfuscate(cmd);
  for (const r of [...SHELL_RULES, DYNAMIC]) if (r.re.test(cmd) || r.re.test(plain)) return { id: r.id, label: lang === 'en' ? r.en : r.ko };
  return null;
}
/** 결재·승인 대조용 정규화 — 앞뒤 공백 제거·연속 공백 하나로(같은 명령을 띄어쓰기만 바꿔 재요청해도 같은 결재). */
export const normalizeShell = (command) => String(command ?? '').trim().replace(/\s+/g, ' ');
