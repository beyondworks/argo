// 회의실 '/' 커맨더 — 유건 요청 2026-09-02(회의실 개선 1/6): 크루 채팅의 커맨더(내장 명령·별칭·스킬)를
// 회의실 입력창에서도 쓸 수 있게. 후보 계산은 두 페이지가 공유하는 순수 모듈(slash-match.mjs)이라 행동
// 테스트로 잠그고, 화면 배선(키 처리·전송 가로채기·패널)은 클라이언트 컴포넌트라 소스 구간 불변식으로 잠근다.
// 서버는 손대지 않는다 — 스킬 호출은 크루 채팅과 같은 형태(사용 지시 텍스트 삽입)로 안건에 실리고, 스킬 본문은
// chat()이 출처(source)와 무관하게 시스템 프롬프트에 주입한다(아래 '코드 동일성' 핀 — 라이브 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchSlash, SLASH_TOKEN_RE } from '../app/c/[ws]/slash-match.mjs';

const stripComments = (src) => src
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' ')) // 줄주석 먼저 — 줄주석 속 글롭 /*가 유령 블록이 되지 않게(#346)
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const load = async (rel) => stripComments(await readFile(new URL(rel, import.meta.url), 'utf8'));

const FIX = {
  builtins: [
    { id: 'end', aliases: ['end', '마치기'], label: '회의 마치기', run: () => 'end' },
    { id: 'memory', aliases: ['memory', '기억', 'vault'], label: '기억', run: () => 'memory' },
  ],
  aliases: [{ cmd: 'report', text: '오늘 진행 상황을 표로 정리해서 보고해줘' }],
  skills: [{ id: 'daily-report', title: '일일 보고 양식' }, { id: 'seo', title: 'SEO 점검' }],
  skillInsert: (s) => `"${s.title}" 스킬을 사용해서 `,
};
const keys = (r) => r.map((c) => c.key);

test('matchSlash: 슬래시 토큰 하나일 때만 발동 — 문장 속 /·공백 뒤·앞 공백·줄바꿈은 null(일반 텍스트로 전송)', () => {
  for (const s of ['', 'hello', 'a /b', '/x y', '/x\n', ' /x', '@pepper /report', '/x /y', null, undefined]) {
    assert.equal(matchSlash(s, FIX), null, `null 이어야: ${JSON.stringify(s)}`);
  }
  for (const s of ['/', '/e', '/보고', '/daily-report']) assert.ok(Array.isArray(matchSlash(s, FIX)), `배열이어야: ${s}`);
  assert.equal(SLASH_TOKEN_RE.source, '^\\/(\\S*)$', '토큰 문법 = 크루 채팅 커맨더와 동일');
});

test('matchSlash: 빈 질의는 전부, 순서는 내장→별칭→스킬, 접두 매칭은 대소문자 무시·별칭/id/제목 어느 쪽이든', () => {
  assert.deepEqual(keys(matchSlash('/', FIX)), ['b:end', 'b:memory', 'a:report', 's:daily-report', 's:seo'], '빈 질의 전부·순서');
  assert.deepEqual(keys(matchSlash('/마', FIX)), ['b:end'], '한글 별칭 접두');
  assert.deepEqual(keys(matchSlash('/SEO', FIX)), ['s:seo'], '스킬 id 대소문자 무시');
  assert.deepEqual(keys(matchSlash('/일일', FIX)), ['s:daily-report'], '스킬 제목 접두');
  assert.deepEqual(keys(matchSlash('/re', FIX)), ['a:report'], '별칭 접두');
  assert.deepEqual(keys(matchSlash('/포트', FIX)), [], '중간 문자열은 매칭하지 않는다(접두만) — 빈 배열, null 아님');
  assert.deepEqual(matchSlash('/zzz', FIX), [], '후보 0 = 빈 배열(패널 닫힘, 텍스트 그대로 전송)');
});

test('matchSlash: 후보 형태 — 내장은 run+첫 별칭, 별칭은 지시 삽입, 스킬은 skillInsert가 만든 사용 지시 삽입', () => {
  const [end, , alias, skill] = matchSlash('/', FIX);
  assert.equal(end.kind, 'builtin'); assert.equal(end.cmd, 'end'); assert.equal(end.desc, '회의 마치기'); assert.equal(end.run(), 'end');
  assert.equal(alias.kind, 'alias'); assert.equal(alias.cmd, 'report'); assert.equal(alias.insert, FIX.aliases[0].text); assert.equal(alias.desc, FIX.aliases[0].text);
  assert.equal(skill.kind, 'skill'); assert.equal(skill.cmd, 'daily-report'); assert.equal(skill.desc, '일일 보고 양식');
  assert.equal(skill.insert, '"일일 보고 양식" 스킬을 사용해서 ', 'skillInsert 결과가 그대로 insert');
  assert.equal(new Set(keys(matchSlash('/', FIX))).size, 5, 'key 유일(React key)');
  assert.deepEqual(matchSlash('/', {}), [], '옵션 없음 = 빈 후보(예외 없음)');
});

// ── 회의실 화면 배선(소스 구간 불변식) ─────────────────────────────────────────
test('회의실: 공유 매처·내장 명령·별칭/스킬 출처가 배선돼 있다', async () => {
  const src = await load('../app/c/[ws]/room/page.jsx');
  assert.match(src, /import \{ matchSlash, SLASH_TOKEN_RE \} from '\.\.\/slash-match\.mjs';/, '공유 매처 임포트');
  assert.match(src, /import \{ useRouter \} from 'next\/navigation';/, '이동 명령용 라우터');
  // 후보 계산 — 보관 회의 열람 중(viewing)엔 닫힘, 스킬 미로드(null)면 빈 목록으로 내장·별칭만 먼저
  assert.match(src, /const slashList = viewing \? null : matchSlash\(input, \{ builtins: SLASH_CMDS, aliases, skills: skillCmds \?\? \[\], skillInsert: \(s\) => t\('chat\.cmd\.skillPrefix', \{ name: s\.title \}\) \}\);/,
    '후보 계산 호출부(형태 전체 앵커 — 인자 하나 빠지면 red)');
  assert.match(src, /const slashTok = !viewing && SLASH_TOKEN_RE\.test\(input\);/, '토큰 판정(멘션 양보 기준)');
  assert.match(src, /const slashOpen = !!slashList\?\.length;/, '패널 열림 = 후보 1개 이상');
  // 내장 명령 — 회의 마치기(버튼과 같은 노출 조건), 기억·데크 이동(크루 커맨더와 같은 별칭)
  assert.match(src, /const SLASH_CMDS = \[\s*\{ id: 'memory', aliases: \['memory', '기억', 'vault'\], label: t\('nav\.memory'\), run: \(\) => router\.push\(keepSide\(`\/c\/\$\{ws\}\/vault`, window\.location\.search\)\) \},\s*\{ id: 'deck', aliases: \['deck', '데크', 'home'\], label: t\('nav\.deck'\), run: \(\) => router\.push\(keepSide\(`\/c\/\$\{ws\}`, window\.location\.search\)\) \},\s*\.\.\.\(!viewing && \(messages\?\.length \?\? 0\) > 0 && !busy && !serverBusy \? \[\{ id: 'end', aliases: \['end', '마치기', '회의마치기'\], label: t\('room\.end'\), run: \(\) => endMeeting\(\) \}\] : \[\]\),\s*\];/,
    '내장 명령 목록 — 회의 마치기는 버튼 노출 조건과 동일(빈 방·진행 중엔 후보에서 빠진다)하고 맨 뒤(`/` 직후 Enter의 기본 선택이 방을 비우는 명령이 아니게 — 검수 LOW-1)');
  assert.match(src, /const slashSel = slashOpen \? Math\.min\(slashIdx, slashList\.length - 1\) : 0;/, '선택 항목 단일 계산 — 표시·실행이 같은 항목(후보가 줄어도 어긋나지 않게 — 검수 MEDIUM-1)');
  // 출처 — 별칭은 회사 정본(company.json.aliases), 스킬은 마켓 GET의 installedSkills(크루 커맨더와 같은 계약)
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!slashTok \|\| skillCmds !== null\) return;\s*api\(`\/api\/companies\/\$\{ws\}\/market`\)\.then\(\(d\) => setSkillCmds\(d\.installedSkills \?\? \[\]\)\)\.catch\(\(\) => setSkillCmds\(\[\]\)\);\s*api\(`\/api\/companies\/\$\{ws\}\?light=1`\)\.then\(\(d\) => setAliases\(d\.company\?\.aliases \?\? \[\]\)\)\.catch\(\(\) => \{\}\);\s*\}, \[slashTok, skillCmds, ws\]\);/,
    '별칭·스킬 출처 — 커맨더를 처음 여는 순간 한 이펙트에서 1회 로드(문장 위치까지 앵커: 죽은 분기로 감싸면 red — 검수 LOW-3). 스킬 실패는 빈 목록(내장은 계속 동작)');
  assert.equal((src.match(/\?light=1/g) ?? []).length, 1, '별칭 GET은 커맨더 로드 1곳뿐 — 방 진입마다 요청하지 않는다(검수 LOW-6)');
});

test('회의실: 키 처리 순서 — ↑↓=항목 이동, Enter=선택 실행이 멘션 완성·전송보다 먼저, 전송 버튼 경로도 가로챈다', async () => {
  const src = await load('../app/c/[ws]/room/page.jsx');
  const k0 = src.indexOf('{...imeGuardWith((e) => {');
  assert.ok(k0 > 0, 'imeGuardWith 핸들러');
  const keyFn = src.slice(k0, src.indexOf('})}', k0));
  // ↑↓ — 커맨더가 떠 있을 때만 가로챈다(아니면 textarea 기본 커서 이동)
  assert.match(keyFn, /if \(slashOpen && \(e\.key === 'ArrowUp' \|\| e\.key === 'ArrowDown'\)\) \{\s*e\.preventDefault\(\);\s*setSlashIdx\(e\.key === 'ArrowDown' \? \(slashSel \+ 1\) % slashList\.length : \(slashSel - 1 \+ slashList\.length\) % slashList\.length\);\s*return;\s*\}/, '↑↓ 순환 이동(클램프된 선택 기준)');
  // 인접 행동 보존 — Shift+Enter 줄바꿈, IME는 imeGuardWith가 앞에서 막는다(기존)
  assert.match(keyFn, /if \(e\.key !== 'Enter' \|\| e\.shiftKey\) return;\s*e\.preventDefault\(\);/, 'Shift+Enter 줄바꿈 보존');
  const enter = keyFn.slice(keyFn.indexOf("if (e.key !== 'Enter'"));
  const iSlash = enter.indexOf('if (slashOpen) { runSlash(slashList[slashSel]); return; }');
  const iMention = enter.indexOf("if (mentionOpen) { completeMention(suggestAll ? 'all' : suggests[0].name); return; }");
  const iSubmit = enter.indexOf('e.currentTarget.form?.requestSubmit();');
  assert.ok(iSlash > 0 && iMention > iSlash && iSubmit > iMention, `Enter 우선순위: 커맨더(${iSlash}) → 멘션 완성(${iMention}) → 전송(${iSubmit})`);
  // 전송 버튼(onSubmit) 경로 — '/end' 같은 명령 토큰이 안건으로 나가지 않게, 비어있음·busy 검사보다 먼저
  const s0 = src.indexOf('async function send(e)');
  const sendFn = src.slice(s0, src.indexOf('async function endMeeting', s0));
  assert.match(sendFn, /e\.preventDefault\(\);\s*if \(slashOpen\) \{ runSlash\(slashList\[slashSel\]\); return; \}\s*const text = input\.trim\(\);\s*if \(!text \|\| busy \|\| uploading\) return;/,
    '전송 가로채기 → 기존 빈 값·busy·uploading 게이트 보존');
  // 멘션 패널은 슬래시 토큰에 양보 — 같은 자리(bottom 100%)라 동시에 뜨지 않는다
  assert.match(src, /const mentionOpen = !!mention && !slashOpen && \(suggestAll \|\| suggests\.length > 0\);/, '멘션 양보 — 기준은 후보 유무(`/@이름`처럼 후보 없는 입력은 멘션 완성 유지, 검수 LOW-2)');
  assert.match(src, /const slashTok = !viewing && SLASH_TOKEN_RE\.test\(input\);[\s\S]*?const slashList = [\s\S]*?const slashOpen = !!slashList\?\.length;[\s\S]*?const mentionOpen = /, '선언 순서: slashOpen이 mentionOpen보다 먼저(렌더 중 TDZ 없음)');
  // 실행 — 내장은 입력을 비우고 실행, 별칭·스킬은 지시 텍스트 삽입(바로 전송하지 않는다 — 사장이 @이름·안건을 덧붙인다)
  assert.match(src, /function runSlash\(cmd\) \{\s*if \(cmd\.kind === 'builtin'\) \{ setInput\(''\); cmd\.run\(\); \}\s*else setInput\(cmd\.insert\);\s*composerRef\.current\?\.focus\(\);\s*\}/, 'runSlash 의미');
  assert.match(src, /useEffect\(\(\) => \{ setSlashIdx\(0\); \}, \[input\]\);/, '입력이 바뀌면 선택 위치 초기화');
});

test('회의실: 커맨더 패널 — 멘션 패널 뒤 같은 기준 박스, 측정형 좌우 클램프(dropUpClamp)·min/max·listbox 계약', async () => {
  const src = await load('../app/c/[ws]/room/page.jsx');
  // 측정 구간 — 열림 시점 layout effect + 자연 폭 1회 캐시 + 재측정 리스너(resize·argo:zoom), 기준 박스는 멘션과 같은 래퍼
  assert.match(src, /useIsoLayoutEffect\(\(\) => \{\s*if \(!slashOpen\) \{ setSlashClamp\(\{ shift: 0, maxW: 0 \}\); slashNatW\.current = 0; return; \}\s*const measure = \(\) => \{\s*if \(!mentionWrapRef\.current \|\| !slashPanelRef\.current\) return;\s*if \(!slashNatW\.current\) slashNatW\.current = slashPanelRef\.current\.offsetWidth;\s*setSlashClamp\(dropUpClamp\(mentionWrapRef\.current\.getBoundingClientRect\(\),\s*document\.documentElement\.clientWidth, slashNatW\.current\)\);\s*\};\s*measure\(\);\s*window\.addEventListener\('resize', measure\);\s*window\.addEventListener\('argo:zoom', measure\);\s*return \(\) => \{ window\.removeEventListener\('resize', measure\); window\.removeEventListener\('argo:zoom', measure\); \};\s*\}, \[slashOpen\]\);/,
    '측정 구간 전체(멘션 패널 처방과 동형)');
  // 패널 — 멘션 패널 블록 바로 다음(래퍼 첫 자식은 멘션 — 기존 zoom 핀 유지), 첫 렌더 무제한 → 측정 후 min(뷰포트, 480)
  const w0 = src.indexOf("<div ref={mentionWrapRef} style={{ position: 'relative' }}>");
  const wrap = src.slice(w0, src.indexOf('<form onSubmit={send}', w0));
  const iM = wrap.indexOf('{mentionOpen && (');
  const iS = wrap.indexOf('{slashOpen && (');
  assert.ok(iM > 0 && iS > iM, `래퍼 안 순서: 멘션(${iM}) → 커맨더(${iS})`);
  const panel = wrap.slice(iS, wrap.indexOf('{(att.length > 0 || uploading) && (', iS));
  assert.match(panel, /<div ref=\{slashPanelRef\} className="card card-float" role="listbox" style=\{\{\s*position: 'absolute', bottom: 'calc\(100% \+ 6px\)', left: slashClamp\.shift, zIndex: 40,\s*minWidth: slashClamp\.maxW \? Math\.min\(320, slashClamp\.maxW\) : 320,\s*maxWidth: slashClamp\.maxW \? Math\.min\(slashClamp\.maxW, 480\) : undefined, maxHeight: 320, overflowY: 'auto', padding: 6,/,
    '패널 클램프 적용(첫 렌더 무제한 + 측정 후 양쪽 상한)');
  assert.match(panel, /\{t\('chat\.commands'\)\}/, '헤더 라벨(크루 커맨더와 같은 사전 키)');
  assert.match(panel, /\{slashList\.map\(\(c, i\) => \(\s*<button key=\{c\.key\} type="button" role="option" aria-selected=\{i === slashSel\}\s*onClick=\{\(\) => runSlash\(c\)\} onMouseEnter=\{\(\) => setSlashIdx\(i\)\}/, '항목 = 클릭 실행·호버 선택·aria-selected');
  assert.match(panel, /\{c\.kind === 'skill' \? t\('chat\.cmd\.skills'\) : t\('chat\.cmd\.aliases'\)\}/, '종류 배지(스킬/별칭)');
  assert.match(panel, /<span className="mono" style=\{\{ flex: 'none', fontWeight: 650 \}\}>\/\{c\.cmd\}<\/span>/, '명령 표시');
});

// ── 크루 채팅도 같은 매처를 쓴다(정본 하나) ────────────────────────────────────
test('크루 채팅: 후보 계산이 공유 매처(matchSlash)로 이관됐다 — 인라인 사본(matchTok) 부활은 red', async () => {
  const src = await load('../app/c/[ws]/crew/[slug]/page.jsx');
  assert.match(src, /import \{ matchSlash \} from '\.\.\/\.\.\/slash-match\.mjs';/, '임포트');
  assert.match(src, /const slashMatches = slashToken \? matchSlash\(input, \{ builtins: SLASH_CMDS, aliases, skills: skillCmds \?\? \[\], skillInsert: \(s\) => t\('chat\.cmd\.skillPrefix', \{ name: s\.title \}\) \}\) : \[\];/,
    '호출부 형태 전체(회의실과 같은 인자 — 스킬 삽입문도 같은 사전 키)');
  assert.doesNotMatch(src, /const matchTok = /, '인라인 사본 제거');
});

// ── 서버: 스킬 주입은 출처 무관(코드 동일성 핀 — 라이브 아님) ───────────────────
test('chat(): 회사 스킬 주입(loadSkills)은 source 분기 앞에서 1회 — 회의실(source:room) 턴도 크루 채팅과 같은 스킬을 받는다', async () => {
  const chat = await load('../src/chat.mjs');
  const c0 = chat.indexOf('export async function chat(');
  const body = chat.slice(c0);
  const iLoad = body.indexOf('const skills = await loadSkills(wsId, SKILL_INJECT_CAP, lang, skillScope);');
  assert.ok(iLoad > 0, 'loadSkills 호출');
  assert.equal((body.match(/await loadSkills\(/g) ?? []).length, 1, 'chat() 안의 loadSkills 호출은 1곳');
  assert.doesNotMatch(body.slice(0, iLoad), /source === '|source !== '/, 'loadSkills 앞에 source 값 분기 없음(예산 차단 조기 반환만)');
  assert.doesNotMatch(body.slice(0, iLoad), /if\s*\([^)]*\bsource\b/, 'loadSkills 앞에 source를 조건으로 삼는 if 없음(등가 비교 외 형태 — 검수 LOW-4)');
  // 두 러너 경로 모두 같은 skills를 시스템 프롬프트에 싣는다
  assert.match(body, /systemPrompt: systemPromptFor\(md, p\.root, skills, meta, lang\)/, 'SDK 경로');
  assert.match(body, /systemPromptFor\(md, p\.root, skills, meta, lang, \{ hasTools: false/, 'CLI 경로');
  const room = await load('../src/room.mjs');
  assert.match(room, /r = await chat\(wsId, a\.slug, prompt, null, \{ source: 'room', attachments: att, mirrorCtx \}\);/, '회의실 발언 = 같은 chat() 진입점');
});
