// 가림 대조 시험의 기준 구현 — 시험 안에 그대로 옮겨 둔 옛 코드. 새 구현이 이보다 덜 가리면 안 된다(test/secret-mask*.test.mjs).
//  · REF_MAIN_KEY_LIKE  = origin/main(0.1.99)의 maskKeyLike
//  · REF_TT_KEY_LIKE    = feat/turn-trace 1e9333bd의 maskKeyLike(접두사 토큰이 더해진 것)
//  · refMaskSecrets     = feat/turn-trace 1e9333bd의 maskSecrets(+ REF_TT_KEY_LIKE)
// 모두 이차 시간 정규식을 품고 있어 짧은 입력에서만 쓴다.
// 이름 판정도 옛 코드 그대로(1e9333bd) — 새 isSecretName을 쓰면 판정이 좁아진 회귀를 가린다.
const SECRET_TAIL = /(?:^|[_.-])(?:api[_-]?key|apikey|secret|secret[_-]?key|secretkey|token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|id[_-]?token|auth[_-]?token|authtoken|bot[_-]?token|password|passwd|pwd|credentials?|authorization|auth|database[_-]?url|databaseurl|dsn|private[_-]?key|privatekey|access[_-]?key(?:[_-]?id)?|accesskey(?:id)?|cookie|session[_-]?token|sessiontoken|client[_-]?secret|clientsecret|webhook[_-]?secret|signing[_-]?secret)$/i;
const refIsSecretName = (name) => {
  const n = String(name ?? '');
  return SECRET_TAIL.test(n) || /(?:^|_)[A-Z0-9_]*KEY$/.test(n) || /^[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN)[A-Z0-9_]*$/.test(n);
};

export const REF_MAIN_KEY_LIKE = (s) => String(s).replace(/\b(sk-ant-[\w-]+|sk-[\w-]{16,}|AIza[\w-]{20,}|xai-[\w-]{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|[0-9a-f]{32}\.[\w-]{16,})\b/g, 'sk-***');
export const REF_TT_KEY_LIKE = (s) => String(s).replace(/\b(sk-ant-[\w-]+|sk-[\w-]{16,}|AIza[\w-]{20,}|xai-[\w-]{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|[0-9a-f]{32}\.[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})\b/g, 'sk-***');
const REF_KV = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}\]]+)/g;
const refMasked = (v) => /^(["'])?(?:\*+|sk-\*\*\*)\1?$/.test(v);
export function refMaskSecrets(s) { // feat/turn-trace 1e9333bd maskSecrets
  let out = String(s);
  out = out.replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, '-----BEGIN $1PRIVATE KEY----- *** -----END $1PRIVATE KEY-----');
  out = REF_TT_KEY_LIKE(out);
  out = out.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
  out = out.replace(/\b((?:Set-)?Cookie)(\s*:\s*)[^\n]+/gi, '$1$2***');
  out = out.replace(/(\s--?(?:password|passwd|pass|token|api-?key|secret|client-secret|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, (m, head, val) => (refMasked(val) ? m : `${head}***`));
  out = out.replace(/^(.*\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b.*?\s-p)(?!\s)(\S+)/gim, '$1***');
  out = out.replace(/(\bsshpass\s+-p\s+)(\S+)/g, '$1***');
  out = out.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+["']?)([^\s:"']+):([^\s"']+)/g, '$1$2:***');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@');
  out = out.replace(REF_KV, (m, q, name, sep, val) => {
    if (!refIsSecretName(name) || refMasked(val) || /^(Bearer|Basic|Token)$/.test(val)) return m;
    return `${q}${name}${q}${sep}${val.startsWith('"') ? '"***"' : val.startsWith("'") ? "'***'" : '***'}`;
  });
  return out;
}

