// 비밀 가림 — 화면·저장·기기 간 동기화에 실리는 글(도구 단계 요약 등)에서 비밀 모양을 가린다(순수, 같은 입력 → 같은 출력, 두 번 돌려도 같다).
// maskKeyLike(벤더 키 모양 — runners/shared.mjs: sk-·AIza·xai-·JWT·GitHub·GitLab·Slack·AWS·npm·Hugging Face) 위에 PEM 개인키·Bearer/Basic/Token 헤더·쿠키·
// CLI 인자로 넘긴 비밀(--password X·--token X·-p비밀번호·curl -u user:pass)·URL 비밀번호·이름이 비밀인 KEY=VALUE를 가린다.
//
// 두 가지를 함께 지킨다 — ① 가리는 범위는 옛 규칙(feat/turn-trace 1e9333bd maskSecrets)보다 줄지 않는다 ② 모든 규칙은 입력 길이에 선형이다.
// 정규식 서비스 거부(ReDoS, 2026-10-09 보안 검토): 옛 규칙은 `curl `·`mysql ` 반복 4만 자에서 100ms, `a.a.a.` 4만 자에서 1.4초로 이차 시간이었다.
//  · 줄 안의 도구 이름 뒤를 보는 규칙(mysql·curl)은 `.*?`로 시작 자리마다 줄 끝까지 훑지 않고, 줄마다 도구 이름 첫 등장 뒤만 한 번 훑는다(afterToolSpans).
//  · URL 비밀번호는 스킴 길이를 묶지 않고 `://`에서 시작한다 — 스킴이 길어도(postgresql+asyncpg://, mongodb+srv://) 가린다.
//  · PEM은 되돌려 참조·`[\s\S]*?` 없이 indexOf로 한 번 훑는다. 같은 글자를 두 수량자가 나눠 먹는 모양(`.*…\b…`)은 쓰지 않는다.
//  · 끝나지 않은 따옴표 값은 입력 끝까지를 값으로 본다 — 그래야 호출자가 입력을 잘라 넘겨도(상한) 따옴표가 안 닫혀 앞 조각이 드러나지 않는다.
//    (KEY=VALUE의 중간에 낀 닫히지 않은 따옴표는 옛 규칙처럼 건너뛴다 — 삼키면 뒤 이름이 가려지지 않는다.)
//  · 규칙을 차례로 적용하면 앞 규칙이 바꾼 글 속에서 뒤 규칙이 찾을 단어(`--password`·`mysql`·`Bearer`)가 사라져 뒤 규칙의 비밀이 남는다 — 그래서 PEM·키 모양
//    (옛 순서와 같음)만 글을 바꾸고, 나머지는 같은 글에서 가릴 자리를 모아 한 번에 바꾼다(applySpans).
// maskKeyLike의 JWT 갈래도 같은 병이 있어(`eyJ-eyJ-…` 10만 자 8초 이상) 덩어리를 한 번 잡고 '.'으로 나누는 선형 구현(maskJwt)으로 바꿨다(runners/shared.mjs — feat/turn-trace d54aaea4와 같은 글).
import { maskKeyLike } from './runners/shared.mjs';

// 이름이 비밀을 뜻하는 KEY=VALUE·KEY: VALUE(따옴표 JSON 키 포함)는 값만 가린다(무엇이 있었는지는 보이게). 이름 판정을 좁게 둔다 —
// 'key'가 들어간 아무 이름(monkey·keyboard·primaryKey)까지 가리면 평범한 도구 출력이 읽히지 않는다.
const SECRET_TAIL = /(?:^|[_.-])(?:api[_-]?key|apikey|secret|secret[_-]?key|secretkey|token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|id[_-]?token|auth[_-]?token|authtoken|bot[_-]?token|password|passwd|pwd|credentials?|authorization|auth|database[_-]?url|databaseurl|dsn|private[_-]?key|privatekey|access[_-]?key(?:[_-]?id)?|accesskey(?:id)?|cookie|session[_-]?token|sessiontoken|client[_-]?secret|clientsecret|webhook[_-]?secret|signing[_-]?secret)$/i;
/** 이름이 비밀 자리인가(순수) — OPENAI_API_KEY·GITHUB_TOKEN·client_secret·apiKey·password·DATABASE_URL·SUPABASE_SERVICE_ROLE_KEY(대문자 *_KEY).
    옛 세 규칙(feat/turn-trace 1e9333bd)을 그대로 쓴다 — 이름은 KV_RE에서 81자 이내로 묶여 맞물린 수량자(`[A-Z0-9_]*…[A-Z0-9_]*`)도 상수 비용이다.
    소문자가 섞인 이름이 `_KEY`로 끝나는 꼴(next_public_supabase_anon_KEY)도 가려야 한다(대문자 이름만 보는 판정은 이를 놓쳤다). */
export const isSecretName = (name) => {
  const n = String(name ?? '');
  return SECRET_TAIL.test(n) || /(?:^|_)[A-Z0-9_]*KEY$/.test(n) || /^[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN)[A-Z0-9_]*$/.test(n);
};

const PEM_BEGIN = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----/g;
const BEARER_RE = /\b([Bb][Ee][Aa][Rr][Ee][Rr]|Basic|Token)(\s+)([A-Za-z0-9._~+/=*-]{8,})/g; // Bearer는 대소문자 무관(BEARER·bearer), Basic·Token은 옛 규칙처럼 첫 글자 대문자. 값 글자에 `*`를 넣은 것은 앞 단계(키 모양)가 토큰 앞쪽만 `sk-***`로 가렸을 때 뒤가 남지 않게
const AUTH_SCHEME_RE = /\b(authorization["']?\s*[:=]\s*["']?(?:basic|token|digest|negotiate)\s+)([^\s"']{4,})/gi; // Authorization 바로 뒤의 스킴은 소문자·대문자 모두
const COOKIE_RE = /\b((?:Set-)?Cookie\s*:\s*)([^\n]+)/gi; // 헤더 값 전체(여러 쿠키·세션 id) — 줄 끝까지
// 값: 따옴표째(끝나지 않은 따옴표는 입력 끝까지) + 따옴표 바로 뒤에 붙은 글자(같은 셸 낱말), 또는 공백 전까지
const VALUE = '(?:"[^"]*(?:"|$)|\'[^\']*(?:\'|$))\\S*|\\S+';
// CLI 인자 — --password X·--password=X·--token X·--api-key X·--cookie X (홑 하이픈도). 앞 공백 한 글자를 같이 먹는다(옛 규칙과 같은 자리 — 입력 맨 앞의 플래그는 보지 않는다).
// 값 자리에 다음 플래그가 오면(`--token --token X`) 그것을 값으로 삼키지 않는다.
const FLAG_NAMES = '(?:(?:(?:http|ftp|proxy)-)?(?:password|passwd|pass)|pwd|token|api-?key|secret|client-secret|auth-token|access-token|cookie)';
const FLAG_RE = new RegExp(`(\\s--?${FLAG_NAMES}(?:=|\\s+))((?:"[^"]*(?:"|$)|'[^']*(?:'|$))\\S*|(?!--?${FLAG_NAMES}(?:=|\\s|$))\\S+)`, 'gi');
const SSHPASS_RE = new RegExp(`\\b(sshpass\\s+-p\\s*)(${VALUE})`, 'g');
// -p비밀번호 — 붙여 쓴 꼴은 도구마다 뜻이 달라(mkdir -pv·cp -pr) mysql 계열·7z에서만, 같은 줄의 도구 이름 뒤에서만 본다
const DB_TOOL = /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump|7z|7za|7zr)\b/;
const ATTACHED_P_RE = new RegExp(`(\\s-p)(?!\\s)(${VALUE})`, 'g');
const CURL_TOOL = /\bcurl\b/;
const CURL_USER_RE = /(\s(?:-u\s*|--user[\s=]+))(?:"([^":\s]+):[^"]*(?:"|$)|'([^':\s]+):[^']*(?:'|$)|([^\s:"']+):([^\s"']+))/g;
// URL 비밀번호 — `://사용자:비밀번호@`. 스킴은 보지 않는다(어떤 스킴이든). 비밀번호에 @가 든 꼴은 마지막 @까지.
const URL_PASSWORD_RE = /(:\/\/[^/\s:@]*:)([^/\s]+)@/g;
// 이름이 비밀인 KEY=VALUE — 머리(이름·구분)와 값을 따로 훑는다. 머리만 정규식으로 찾고, 이름이 비밀일 때만 그 자리에서 값을 읽는다(sticky). 이름이 비밀이 아닌 값을 통째로
// 삼키면 그 안의 `PASSWORD=…`가 가려지지 않는다(`asyncpg://PASSWORD=@비번`, 닫히지 않은 따옴표 속) — 옛 규칙은 앞 규칙이 글을 바꿔 우연히 피했다. 머리 찾기는 시작마다 상수 비용이고
// 값은 비밀 이름에서만 읽고, 비밀 값 속의 머리는 값 끝 100자만 다시 본다(값을 끝에서 끝나는 머리만 값이 끝 너머로 이어질 수 있다) — 전체가 선형이다. 따옴표 값이 입력 끝까지 닫히지 않으면 입력 끝까지(잘린 입력 대비), 중간의
// 닫히지 않은 따옴표는 옛 규칙처럼 건너뛴다.
const KV_HEAD_RE = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)/g;
const KV_VALUE_RE = /"[^"\n]*"|'[^'\n]*'|[^\s"',;&}\]]+|"[^"\n]*$|'[^'\n]*$/y;
const USERINFO_TAIL = /^[^/\s]*@/; // `://이름:` 뒤가 `비밀번호@`로 이어진다 = URL 사용자 정보
const MASKED_VALUE = /^(["'])?(?:\*+|sk-\*\*\*)\1?$/; // 이미 가려진 값(옛 규칙과 같다 — `sk-***` 표지는 그대로 둔다)
const SCHEME_WORD = /^(bearer|basic|token|digest|negotiate)$/i;

/* 나머지 규칙은 **같은 글**(PEM·maskKeyLike를 지난 것)을 훑어 가릴 자리(spans)만 모은 뒤 한 번에 바꾼다. 규칙을 차례로 적용하면 앞 규칙이 바꾼 글 속에서 뒤 규칙이
   찾을 단어(`--password`·`mysql`·`Bearer`…)가 사라져 — 앞 규칙의 값 자리에 그 단어가 들어오는 입력에서 — 뒤 규칙의 비밀이 그대로 남았다(차분 퍼즈에서 찾음).
   모은 자리가 겹치면 하나로 합친다. spans 항목: { s, e, r } — r이 null이면 `***`, 있으면 그 글로 바꾼다(PEM 표지·curl 사용자). */
const span = (spans, s, e, r = null) => { if (e > s) spans.push({ s, e, r }); };
/** 정규식 m의 마지막 캡처 그룹 value가 있는 위치 = 맞춘 글 끝에서 value 길이만큼 앞(그룹이 맨 끝에 올 때만 쓴다). */
const tailSpan = (spans, m, value) => span(spans, m.index + m[0].length - value.length, m.index + m[0].length);

/** PEM 개인키: 표지는 두고 본문만 가린다 — 맨 먼저(옛 순서). 키 모양 규칙이 먼저 돌면 표지에 붙은 `-----BEGIN`을 삼켜 블록이 안 보인다.
    끝 표지(같은 종류)가 없으면 입력 끝까지 + 끝 표지를 붙인다(두 번 돌려도 뒤 글을 삼키지 않게). indexOf — 되돌려 참조·`[\s\S]*?` 없음. */
function maskPem(text) {
  if (!text.includes('PRIVATE KEY-----')) return text;
  let out = ''; let from = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let m = PEM_BEGIN.exec(text); m; m = PEM_BEGIN.exec(text)) {
    const bodyStart = m.index + m[0].length;
    const endMark = `-----END ${m[1]}PRIVATE KEY-----`;
    const at = text.indexOf(endMark, bodyStart);
    out += `${text.slice(from, bodyStart)} *** ${endMark}`;
    from = at < 0 ? text.length : at + endMark.length;
    PEM_BEGIN.lastIndex = from;
  }
  return out + text.slice(from);
}
/** 줄마다 도구 이름 첫 등장부터 줄 끝까지만 tailRe를 훑는다 — `.*?`가 시작 자리마다 줄 끝까지 훑어 이차 시간이 되던 것을 줄당 한 번 훑기로.
    의미는 옛 `^.*\bTOOL\b.*?\s-p…`와 같다(도구 이름 뒤, 같은 줄). 도구 이름이 없는 글은 줄 나누기도 하지 않는다. */
function afterToolSpans(t, toolRe, tailRe, onMatch) {
  if (!toolRe.test(t)) return;
  let base = 0;
  for (const line of t.split('\n')) {
    const hit = toolRe.exec(line);
    if (hit) {
      tailRe.lastIndex = hit.index;
      for (let m = tailRe.exec(line); m; m = tailRe.exec(line)) onMatch(m, base);
    }
    base += line.length + 1;
  }
}
/** 맞는 글마다 fn을 부른다. valueGroup을 주면 다음 훑기를 그 그룹(값)의 시작부터 한다 — 값이 다음 규칙 머리의 글자를 품어도(`Token \ntoken=Token 비밀`) 겹친 머리를 놓치지 않는다.
    값은 공백 없는 낱말(또는 따옴표 한 덩어리)이라 다시 훑는 양이 값 길이를 넘지 않는다 — 전체는 선형. */
const eachMatch = (re, t, fn, valueGroup = 0) => {
  re.lastIndex = 0;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    fn(m);
    if (valueGroup) re.lastIndex = m.index + m[0].length - m[valueGroup].length;
  }
};

/** 가릴 자리를 합쳐 바꾼다 — 겹치거나 맞닿은 자리는 하나로, 합친 자리 전체를 덮는 항목에 바꿀 글(r)이 있으면 그것을 쓴다. */
function applySpans(t, spans) {
  if (!spans.length) return t;
  spans.sort((a, b) => a.s - b.s || b.e - a.e);
  let out = ''; let pos = 0;
  for (let i = 0; i < spans.length;) {
    const { s } = spans[i]; let e = spans[i].e; let j = i + 1;
    while (j < spans.length && spans[j].s <= e) { if (spans[j].e > e) e = spans[j].e; j += 1; }
    const whole = spans.slice(i, j).find((x) => x.r != null && x.s === s && x.e === e);
    out += t.slice(pos, s) + (whole ? whole.r : '***');
    pos = e; i = j;
  }
  return out + t.slice(pos);
}

/** 화면·저장에 실리는 글에서 비밀 모양을 가린다(순수). 호출자가 입력 길이를 묶는 것을 전제로 한다(위 머리말). */
export function maskSecrets(s) {
  if (s == null) return '';
  const t = maskKeyLike(maskPem(String(s))); // PEM → 벤더 키 모양(JWT 포함): 옛 규칙과 같은 순서
  const spans = [];
  eachMatch(BEARER_RE, t, (m) => tailSpan(spans, m, m[3]), 3);
  eachMatch(AUTH_SCHEME_RE, t, (m) => tailSpan(spans, m, m[2]), 2);
  eachMatch(COOKIE_RE, t, (m) => tailSpan(spans, m, m[2]));
  eachMatch(FLAG_RE, t, (m) => { if (!MASKED_VALUE.test(m[2])) tailSpan(spans, m, m[2]); }, 2);
  afterToolSpans(t, DB_TOOL, ATTACHED_P_RE, (m, base) => span(spans, base + m.index + m[1].length, base + m.index + m[0].length));
  eachMatch(SSHPASS_RE, t, (m) => tailSpan(spans, m, m[2]), 2);
  afterToolSpans(t, CURL_TOOL, CURL_USER_RE, (m, base) => {
    const user = m[2] ?? m[3] ?? m[4];
    if (m[5] != null) span(spans, base + m.index + m[0].length - m[5].length, base + m.index + m[0].length); // user:비밀번호 — 비밀번호만
    else span(spans, base + m.index + m[1].length, base + m.index + m[0].length, `${user}:***`); // 따옴표로 묶인 "user:비밀번호" — 따옴표째 user:***
  });
  eachMatch(URL_PASSWORD_RE, t, (m) => span(spans, m.index + m[1].length, m.index + m[1].length + m[2].length));
  KV_HEAD_RE.lastIndex = 0;
  for (let m = KV_HEAD_RE.exec(t); m; m = KV_HEAD_RE.exec(t)) {
    const vs = m.index + m[0].length; // 값 시작 — 비밀이 아닌 이름은 여기서 이어 훑는다(값 속의 다른 이름도 본다)
    if (!isSecretName(m[2])) continue;
    if (m[3] === ':' && m.index >= 3 && t.startsWith('://', m.index - 3) && USERINFO_TAIL.test(t.slice(vs, vs + 2000))) continue; // `://사용자:비밀번호@` — URL 규칙이 맡는다(KEY 규칙이 `@호스트/경로`까지 삼키지 않게)
    KV_VALUE_RE.lastIndex = vs;
    const v = KV_VALUE_RE.exec(t);
    if (!v) continue;
    const val = v[0];
    const end = vs + val.length;
    // 비밀 값 속의 머리도 본다 — 단 값 끝 쪽 100자만: 다른 머리의 값이 이 값 끝 너머(공백·줄바꿈 뒤)로 이어질 수 있는 것은 값을 끝에서 끝나는 머리뿐이고,
    // 값 전체를 다시 훑으면 `KEY=KEY=KEY=…`에서 이차 시간이 된다.
    KV_HEAD_RE.lastIndex = Math.max(vs, end - 100);
    if (MASKED_VALUE.test(val) || SCHEME_WORD.test(val)) continue;
    const quote = val[0] === '"' || val[0] === "'" ? val[0] : null;
    if (!quote) span(spans, vs, end);
    else span(spans, vs + 1, end - (val.length > 1 && val.endsWith(quote) ? 1 : 0)); // 따옴표는 두고 안쪽만
  }
  return applySpans(t, spans);
}
