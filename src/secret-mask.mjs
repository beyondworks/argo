// 비밀 가림 — 화면·저장·기기 간 동기화에 실리는 글(도구 단계 요약 등)에서 비밀 모양을 가린다(순수, 같은 입력 → 같은 출력, 두 번 돌려도 같다).
// maskKeyLike(벤더 키 모양 — runners/shared.mjs) 위에 PEM 개인키·Bearer/Basic/Token 헤더·쿠키·접두사 토큰(GitHub·GitLab·Slack·AWS·npm·Hugging Face)·
// CLI 인자로 넘긴 비밀(--password X·--token X·-p비밀번호·curl -u user:pass)·URL 비밀번호·이름이 비밀인 KEY=VALUE를 가린다.
//
// 두 가지를 함께 지킨다 — ① 가리는 범위는 옛 규칙(feat/turn-trace 1e9333bd maskSecrets)보다 줄지 않는다 ② 모든 규칙은 입력 길이에 선형이다.
// 정규식 서비스 거부(ReDoS, 2026-10-09 보안 검토): 옛 규칙은 `curl `·`mysql ` 반복 4만 자에서 100ms, `a.a.a.` 4만 자에서 1.4초로 이차 시간이었다.
//  · 줄 안의 도구 이름 뒤를 보는 규칙(mysql·curl)은 `.*?`로 시작 자리마다 줄 끝까지 훑지 않고, 줄마다 도구 이름 첫 등장 뒤만 한 번 훑는다(maskAfterTool).
//  · URL 비밀번호는 스킴 길이를 묶지 않고 `://`에서 시작한다 — 스킴이 길어도(postgresql+asyncpg://, mongodb+srv://) 가린다.
//  · PEM은 되돌려 참조·`[\s\S]*?` 없이 indexOf로 한 번 훑는다. 같은 글자를 두 수량자가 나눠 먹는 모양(`.*…\b…`)은 쓰지 않는다.
//  · 끝나지 않은 따옴표 값은 입력(또는 줄) 끝까지를 값으로 본다 — 그래야 호출자가 입력을 잘라 넘겨도(상한) 따옴표가 안 닫혀 앞 조각이 드러나지 않는다.
// 호출자가 입력을 수십 KB로 묶는 것을 전제로 한다(turn-status.mjs detailForTool: 64KB, 자른 자리 근처는 버린다). 이 파일 안에서는 입력을 자르지 않는다.
// maskKeyLike의 JWT 갈래도 같은 병이 있어(`eyJ-eyJ-…` 10만 자 8초 이상) 같은 PR에서 앞을 (?<![\w-])로 고정해 고쳤다(runners/shared.mjs).
import { maskKeyLike } from './runners/shared.mjs';

// 이름이 비밀을 뜻하는 KEY=VALUE·KEY: VALUE(따옴표 JSON 키 포함)는 값만 가린다(무엇이 있었는지는 보이게). 이름 판정을 좁게 둔다 —
// 'key'가 들어간 아무 이름(monkey·keyboard·primaryKey)까지 가리면 평범한 도구 출력이 읽히지 않는다.
const SECRET_TAIL = /(?:^|[_.-])(?:api[_-]?key|apikey|secret|secret[_-]?key|secretkey|token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|id[_-]?token|auth[_-]?token|authtoken|bot[_-]?token|password|passwd|pwd|credentials?|authorization|auth|database[_-]?url|databaseurl|dsn|private[_-]?key|privatekey|access[_-]?key(?:[_-]?id)?|accesskey(?:id)?|cookie|session[_-]?token|sessiontoken|client[_-]?secret|clientsecret|webhook[_-]?secret|signing[_-]?secret)$/i;
const SCREAMING = /^[A-Z0-9_]+$/;
/** 이름이 비밀 자리인가(순수) — OPENAI_API_KEY·GITHUB_TOKEN·client_secret·apiKey·password·DATABASE_URL·SUPABASE_SERVICE_ROLE_KEY(대문자 *_KEY). */
export const isSecretName = (name) => {
  const n = String(name ?? '');
  if (SECRET_TAIL.test(n)) return true;
  // 대문자 이름: *_KEY(MONKEY·TURKEY는 아님)와 SECRET·PASSWORD·TOKEN이 든 이름 — 수량자 두 개가 맞물리는 정규식 대신 문자열 검사
  return SCREAMING.test(n) && (n === 'KEY' || n.endsWith('_KEY') || n.includes('SECRET') || n.includes('PASSWORD') || n.includes('TOKEN'));
};

const PEM_BEGIN = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----/g;
/** PEM 개인키 블록 → 표지만 남기고 본문을 가린다. 끝 표지(같은 종류)가 없으면 입력 끝까지. 종류는 시작 표지에서 읽는다(indexOf — 되돌려 참조·`[\s\S]*?` 없음). */
function maskPem(text) {
  if (!text.includes('PRIVATE KEY-----')) return text;
  let out = ''; let from = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
    const endMark = `-----END ${m[1]}PRIVATE KEY-----`;
    const at = text.indexOf(endMark, m.index + m[0].length);
    const stop = at < 0 ? text.length : at + endMark.length;
    out += `${text.slice(from, m.index)}-----BEGIN ${m[1]}PRIVATE KEY----- *** ${endMark}`;
    from = stop; PEM_BEGIN.lastIndex = stop;
  }
  return out + text.slice(from);
}

const BEARER_RE = /\b(Bearer|bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g; // Authorization 헤더 값과 그 밖의 곳 모두
const COOKIE_RE = /\b((?:Set-)?Cookie\s*:\s*)[^\n]+/gi; // 헤더 값 전체(여러 쿠키·세션 id) — 줄 끝까지
// 접두사 토큰 — 벤더마다 본문 글자 종류·길이가 달라 각각 문다(패턴 하나로 '시크릿 없음' 선언 금지)
const TOKEN_FORMS = [
  /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, // GitHub ghp_/gho_/ghu_/ghs_/ghr_
  /\b(github_pat_)[A-Za-z0-9_]{20,}/g, // GitHub 세분화 토큰
  /\b(glpat-)[A-Za-z0-9_-]{16,}/g, // GitLab
  /\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, // Slack
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS 액세스 키 id(장기·임시)
  /\b(npm_)[A-Za-z0-9]{30,}/g, // npm
  /\b(hf_)[A-Za-z0-9]{30,}/g, // Hugging Face
];
// 값: 따옴표째(끝나지 않은 따옴표는 입력 끝까지) 또는 공백 전까지
const VALUE = '"[^"]*(?:"|$)|\'[^\']*(?:\'|$)|\\S+';
// CLI 인자 — --password X·--password=X·--token X·--api-key X·--cookie X (홑 하이픈도)
const FLAG_RE = new RegExp(`((?<!\\S)--?(?:(?:(?:http|ftp|proxy)-)?(?:password|passwd|pass)|pwd|token|api-?key|secret|client-secret|auth-token|access-token|cookie)(?:=|\\s+))(?:${VALUE})`, 'gi');
const SSHPASS_RE = new RegExp(`\\b(sshpass\\s+-p\\s*)(?:${VALUE})`, 'g');
// -p비밀번호 — 붙여 쓴 꼴은 도구마다 뜻이 달라(mkdir -pv·cp -pr) mysql 계열·7z에서만, 같은 줄의 도구 이름 뒤에서만 본다
const DB_TOOL = /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump|7z|7za|7zr)\b/;
const ATTACHED_P_RE = new RegExp(`(\\s-p)(?!\\s)(?:${VALUE})`, 'g');
const CURL_TOOL = /\bcurl\b/;
const CURL_USER_RE = /(\s(?:-u\s*|--user[\s=]+))(?:"([^":\s]+):[^"]*(?:"|$)|'([^':\s]+):[^']*(?:'|$)|([^\s:"']+):[^\s"']+)/g;
// URL 비밀번호 — `://사용자:비밀번호@`. 스킴은 보지 않는다(어떤 스킴이든). 비밀번호에 @가 든 꼴은 마지막 @까지.
const URL_PASSWORD_RE = /(:\/\/[^/\s:@]*:)[^/\s]+@/g;
// 이름이 비밀인 KEY=VALUE. 따옴표 값이 닫히지 않으면 줄 끝(입력 끝)까지.
const KV_RE = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)("[^"\n]*(?:"|(?=\n)|$)|'[^'\n]*(?:'|(?=\n)|$)|[^\s"',;&}\]]+)/g;
const MASKED_VALUE = /^(["'])?\*+\1?$/;
const SCHEME_WORD = /^(bearer|basic|token)$/i;

/** 줄마다 도구 이름 첫 등장부터 줄 끝까지만 replace로 가린다 — `.*?`가 시작 자리마다 줄 끝까지 훑어 이차 시간이 되던 것을 줄당 한 번 훑기로.
    의미는 옛 `^.*\bTOOL\b.*?\s-p…`와 같다(도구 이름 뒤, 같은 줄). 도구 이름이 없는 글은 줄 나누기도 하지 않는다. */
function maskAfterTool(text, toolRe, replace) {
  if (!toolRe.test(text)) return text;
  return text.split('\n').map((line) => {
    const hit = toolRe.exec(line);
    return hit ? line.slice(0, hit.index) + replace(line.slice(hit.index)) : line;
  }).join('\n');
}

/** 화면·저장에 실리는 글에서 비밀 모양을 가린다(순수). 호출자가 입력 길이를 묶는 것을 전제로 한다(위 머리말). */
export function maskSecrets(s) {
  if (s == null) return '';
  let out = maskPem(String(s));
  out = out.replace(BEARER_RE, '$1 ***');
  out = out.replace(COOKIE_RE, '$1***');
  for (const re of TOKEN_FORMS) out = out.replace(re, '$1***');
  out = maskKeyLike(out);
  out = out.replace(FLAG_RE, '$1***');
  out = maskAfterTool(out, DB_TOOL, (tail) => tail.replace(ATTACHED_P_RE, '$1***'));
  out = out.replace(SSHPASS_RE, '$1***');
  out = maskAfterTool(out, CURL_TOOL, (tail) => tail.replace(CURL_USER_RE, (m, head, u1, u2, u3) => `${head}${u1 ?? u2 ?? u3}:***`));
  out = out.replace(URL_PASSWORD_RE, '$1***@');
  out = out.replace(KV_RE, (m, q, name, sep, val) => {
    if (!isSecretName(name) || MASKED_VALUE.test(val) || SCHEME_WORD.test(val)) return m;
    return `${q}${name}${q}${sep}${val.startsWith('"') ? '"***"' : val.startsWith("'") ? "'***'" : '***'}`;
  });
  return out;
}
