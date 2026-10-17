#!/usr/bin/env node
// PR 본문 규칙 검사(CLAUDE.md "인접 회귀 방지 3"·"DB 위생 5"·"회귀 게이트 1·5"·"벤더 1·4"·"버그 방지" — 2026-10-12, REVIEW.md Testing·Risk·How to revert·요청자 — 2026-10-17).
// 바뀐 파일과 추가된 줄을 보고, 규칙이 요구하는 절이 PR 본문에서 비어 있으면 실패한다. 문서만 바뀐 PR은 검사하지 않는다.
// 절은 .github/pull_request_template.md의 `## ` 제목 단위로 읽고(`###` 이하는 위 절에 합친다), 안내 주석(<!-- -->)·빈 표 칸·자리 표시(대기·pending·TBD만)는 내용으로 치지 않는다.
// CI: .github/workflows/pr-rules.yml. 로컬: node scripts/pr-rules-check.mjs <본문파일> <파일목록> <diff>. 시험: test/rule-gates.test.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOC_ONLY = /\.(md|txt|png|jpe?g|gif|svg|webp)$|^docs\/|^artifacts\//;
const NOT_PRODUCT = /^test\/|\/test\/|\.test\.m?js$|\.(md|txt)$/; // 주기 호출 판정에서 빼는 파일(시험·문서)
// 상태를 바꾸는 파일 — 회귀 게이트 1(동기화·결제·권한·메신저 표지). 폴더·파일 이름의 한 부분이 이 낱말이어야 한다(author·async-queue 오탐 방지).
// 시험·문서 파일만 바뀐 것은 세지 않는다.
const STATEFUL = (f) => !NOT_PRODUCT.test(f) && (/^supabase\/migrations\//.test(f) || /^apps\/messenger\/src\//.test(f)
  || /(^|\/)(billing|cloud-?sync|sync|auth|permissions?|quota|storage|lease|entitlement|msgr)([-_./]|$)/i.test(f));
const RUNNER = /^src\/engine\/(native-query|native-flags|messages-http|responses-wire|gemini-wire|prompt-cache|builtin-tools)\.mjs$|^test\/helpers\/strict-vendor\.mjs$/;
// ponytail: 흔한 형태만 잡는 정규식이다(지연을 계산식으로 넘기는 재귀 setTimeout 등은 못 잡는다) — 그런 변경은 검수에서 본다.
const PERIODIC = new RegExp([
  String.raw`cron\.schedule`, String.raw`setInterval\s*\(`, String.raw`useInterval\s*\(`, String.raw`refetchInterval`,
  String.raw`\b\w*(INTERVAL|POLL|HEARTBEAT|TICK|EVERY|TTL|PERIOD)\w*_MS\s*=\s*\d`, String.raw`\b(interval|poll|heartbeat|tick|every)\w*Ms\s*=\s*\d`,
  String.raw`\b\w*(_INTERVAL|_POLL|_HEARTBEAT)\w*\s*=\s*\d`,
  String.raw`setTimeout\s*\(\s*\w+\s*,\s*(\d{3,}|\w*(INTERVAL|POLL|HEARTBEAT|TICK|EVERY|DELAY)\w*)\s*\)`,
].join('|'), 'i');

// 메신저가 가져다 쓰는 본체 파일 — vite 별칭 shared('…')와 apps/messenger/src의 상대 import에서 읽는다(목록을 손으로 두지 않는다).
export function messengerShared(root = ROOT) {
  const out = new Set();
  const vite = join(root, 'apps/messenger/vite.config.js');
  if (existsSync(vite)) for (const [, p] of readFileSync(vite, 'utf8').matchAll(/shared\('([^']+)'\)/g)) if (p !== '.') out.add(p);
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const src = join(root, 'apps/messenger/src');
  if (existsSync(src)) for (const file of walk(src).filter((p) => /\.(jsx?|mjs)$/.test(p))) {
    const rel = file.slice(root.length).replace(/\\/g, '/');
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from\s+'((?:\.\.\/)+[^']+)'/g)) {
      const target = posix.normalize(posix.join(posix.dirname(rel), spec));
      if (!target.startsWith('apps/messenger/')) out.add(target);
    }
  }
  return out;
}

// 본문을 `## 제목` 단위로 나누고, 주석·빈 표 칸·구분선을 지운 내용만 남긴다.
// `###`·`####` 소제목은 바로 위 `#`·`##` 절의 일부다 — 새 절로 끊으면 "## 영향 반경" 아래에 "### 축"을 둔 본문이 빈 절로 실패했다(#961 검수 LOW-1).
// 소제목 글자는 내용으로 치지 않는다. 위에 절이 없으면 `###`도 절로 읽고, 그 뒤 같은 단계 제목은 새 절이다(제목 단계를 하나 내려 쓴 본문).
export function sections(body) {
  const clean = String(body || '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '(코드)'); // 코드 블록 안의 # 줄은 제목이 아니다
  const out = {};
  let cur = ''; let level = 0; // 지금 절의 제목 단계 — 같거나 높은 단계의 제목이 나오면 새 절
  for (const line of clean.split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (h && (h[1].length <= 2 || cur === '' || h[1].length <= level)) { cur = h[2]; level = h[1].length; out[cur] ??= ''; continue; }
    if (h) continue; // 소제목 — 위 절에 합친다
    const text = line.replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/, '').replace(/^\s*(\|\s*)+$/, '').trim();
    if (text) out[cur] = `${out[cur] ?? ''}${text}\n`;
  }
  return out;
}
const sectionText = (secs, re) => Object.entries(secs).filter(([k]) => re.test(k)).map(([, v]) => v).join('');
const EMPTY = /^(해당\s*없음|없음|안\s*함|미실시|n\/?a|-)\.?$/i;
// 자리 표시 — 줄마다 목록 기호와 "라벨:"을 떼고 이것만 남으면 내용이 아니다. 절의 모든 줄이 자리 표시면 빈 절이다("분리 검수: 대기"만 적어도 통과하던 것, #961 검수 LOW-2).
const PLACEHOLDER = /^(대기(\s*중)?|예정|pending|tbd|todo|wip)\.?$/i;
const placeholderLine = (l) => PLACEHOLDER.test(l.replace(/^[-*]\s*/, '').replace(/^[^:：]{1,30}[:：]\s*/, '').trim());
// 위험도 숫자 — 앞뒤 서식(**·`·표 칸)과 문장 끝 마침표는 받고, 소수(1.5)·3 이상·고르지 않은 "0/1/2"는 받지 않는다(#review 검수 I-1)
const RISK_GRADE = /(위험도|등급|grade|risk)[\s*_`|]*(level)?[\s*_`|]*[:：]?[\s*_`|]*[012](?!\d|\.\d|\s*\/)/i;
// 요청자 값 — 같은 줄의 값이 자리 표시·"해당 없음"이면 빈 것으로 본다(#review 검수 I-2)
const requester = (t) => [...t.matchAll(/(요청자|requester)[\s*_]*[:：][ \t*_]*([^\n]*)/gi)].some((m) => filled(m[2].replace(/[*_]+$/, '')));
const filled = (t) => t.trim() !== '' && !EMPTY.test(t.trim()) && !t.trim().split('\n').every(placeholderLine);

// 반환: 빠진 항목 설명 목록(빈 배열 = 통과). added = [{ file, line }]
export function checkPr({ body = '', files = [], added = [], shared = messengerShared() }) {
  const code = files.filter((f) => !DOC_ONLY.test(f));
  if (!code.length) return [];
  const secs = sections(body);
  const all = Object.values(secs).join('');
  const missing = [];
  if (!filled(sectionText(secs, /영향\s*반경/))) missing.push('영향 반경: "## 영향 반경" 절에 걸치는 문맥 축과 축마다 "검증함(방법)/미검증"(인접 회귀 방지 3)');
  if (!filled(sectionText(secs, /검수/))) missing.push('분리 검수: "## 검수" 절에 만든 컨텍스트가 아닌 검수 결과(지적과 처리)(자기 승인 금지)');
  if (code.some(STATEFUL) && !filled(sectionText(secs, /경우\s*표/))) missing.push('경우 표: 상태를 바꾸는 파일(마이그레이션·결제·메신저·동기화·권한)이 바뀌었다 — "## 경우 표"에 칸마다 기대 결과와 근거(회귀 게이트 1)');
  if (added.some(({ file, line }) => !NOT_PRODUCT.test(file) && PERIODIC.test(line)) && !/분당/.test(sectionText(secs, /부하/))) missing.push('부하 계산: 새 주기 호출이 있다 — "## 부하"에 "기기 N대 × 분당 M회 = 분당 K행"과 유휴 쓰기 0 시험(DB 위생 5)');
  if (code.some((f) => shared.has(f)) && !['390', '1280', '880'].every((n) => sectionText(secs, /화면/).includes(n))) missing.push(`메신저 화면 확인: 메신저가 쓰는 공용 파일(${code.filter((f) => shared.has(f)).join('·')})이 바뀌었다 — "## 화면"에 메신저 390·1280·880(회귀 게이트 5)`);
  if (code.some((f) => RUNNER.test(f)) && !/러너/.test(all)) missing.push('러너별 검증: 벤더 와이어·도구 정의 파일이 바뀌었다 — 러너(벤더)마다 "실턴/가짜 서버/미검증"(벤더 1·4)');
  // 리뷰 방식(REVIEW.md, 2026-10-17) — 직접 돌린 확인, 위험도 0/1/2와 이유, 되돌리는 방법, 요청자
  if (!filled(sectionText(secs, /testing|테스트|시험/i))) missing.push('Testing: "## Testing"에 직접 돌린 테스트·빌드·린트·화면 확인과 결과(REVIEW.md)');
  const risk = sectionText(secs, /risk|위험/i);
  if (!filled(risk) || !RISK_GRADE.test(risk)) missing.push('Risk: "## Risk"에 위험도(0/1/2)와 이유, 무엇이 잘못될 수 있나(REVIEW.md 위험도 기준)');
  if (!filled(sectionText(secs, /revert|되돌|롤백/i))) missing.push('How to revert: "## How to revert"에 되돌리는 방법(커밋 revert·플래그 끄기·마이그레이션 되돌리기)(REVIEW.md)');
  if (!requester(all)) missing.push('요청자: 본문에 "요청자: <이름>"(변경을 시킨 사람 — 세션이 대신 썼어도 요청한 사람)(REVIEW.md)');
  return missing;
}

// diff에서 추가된 줄을 파일과 함께(파일 머리 줄 제외)
export function addedFromDiff(diff) {
  const out = []; let file = '';
  for (const l of diff.split('\n')) {
    const m = l.match(/^\+\+\+ b\/(.+)$/); if (m) { file = m[1]; continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) out.push({ file, line: l.slice(1) });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [bodyFile, filesFile, diffFile] = process.argv.slice(2);
  const body = readFileSync(bodyFile, 'utf8');
  const files = readFileSync(filesFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const added = diffFile ? addedFromDiff(readFileSync(diffFile, 'utf8')) : [];
  const missing = checkPr({ body, files, added });
  if (missing.length) {
    console.log('PR 본문에 규칙이 요구하는 내용이 없습니다(.github/pull_request_template.md 참고):');
    for (const m of missing) console.log(`- ${m}`);
    process.exit(1);
  }
  console.log(`PR 본문 규칙 통과 (코드 파일 ${files.filter((f) => !DOC_ONLY.test(f)).length}개)`);
}
