// 실행 카드·궤적·P0(2026-09-09 유건 지시 "UI 대폭 업그레이드") — 서버(상태 파일 steps·브리지 progress 방송·답글 meta.trace)와
// 클라이언트(ExecCard·Trace·안 읽음 배지·구분선·편집/삭제·반응·음소거·조용한 시간)의 배선을 소스 구간으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'espree';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const app = read('apps/messenger/src/App.jsx'); const i18n = read('apps/messenger/src/i18n.js'); const css = read('apps/messenger/src/styles.css');
const bridge = read('src/gateway/msgr.mjs'); const chat = read('src/chat.mjs'); const ts = read('src/turn-status.mjs');

test('서버: chat.mjs가 steps를 상태 파일에 싣고 trace를 반환(데스크톱용) · 브리지는 1.5초마다 확인하고 크루당 최소 4초 간격으로 progress를 반복 방송하며(화면 QA HIGH: 8초 뒤 카드 소실 방지, L-b: 방송 횟수 제한) 메신저 답글에는 궤적을 붙이지 않는다', () => {
  assert.match(ts, /steps: Array\.isArray\(steps\) \? steps\.slice\(-40\) : \(prev\.steps \?\? \[\]\)/, '상태 파일 steps(뒤 40)');
  assert.match(chat, /const trace = \{ steps, thought: String\(thought \?\? ''\)\.slice\(-1500\), ms: Date\.now\(\) - t0, model: actualModel \|\| null, costUsd \};/, 'trace 조립');
  const ast=parse(chat,{ecmaVersion:'latest',sourceType:'module'});
  const turn=ast.body.find(n=>n.type==='FunctionDeclaration' && n.id?.name==='runChat');
  const result=turn.body.body.findLast(n=>n.type==='ReturnStatement').argument;
  assert.equal(result.type,'ObjectExpression');
  const trace=result.properties.find(p=>p.type==='Property' && p.key.name==='trace');
  assert.equal(trace?.value.type,'Identifier','SDK success must return the assembled trace');
  assert.equal(trace.value.name,'trace');
  assert.match(bridge, /import \{ getTurnStatus \} from '\.\.\/turn-status\.mjs';/, '브리지가 상태 파일을 읽는다');
  assert.match(bridge, /const PROGRESS_MS = 1_500;/, '방송 주기');
  // payload가 턴 내내 고정이라(시작 시각·원본 메시지 id) "바뀐 것만" 방송하면 턴당 한 번만 나가 8초 뒤 화면 카드·중단 버튼이 사라졌다(화면 QA HIGH, 2026-09-26).
  // typing 방송처럼 매 틱 다시 보낸다 — DB 쓰기 없는 websocket 방송이라 무해.
  assert.doesNotMatch(bridge, /if \(key === last\) return;/, '바뀐 것만 거르는 dedupe를 없앴다(고쳤다는 증거 — 되돌아가면 이 단언이 잡는다)');
  assert.match(bridge, /const PROGRESS_MIN_GAP_MS = 4_000;/, '실제 방송은 크루당 최소 4초 간격(재검수 2026-09-26 L-b)');
  assert.match(bridge, /if \(now - lastSentAt < PROGRESS_MIN_GAP_MS\) return;/, '4초 안 지났으면 보내지 않는다');
  assert.match(bridge, /const payload = \{ channel_id: channelId, crew_id: crewId, startedAt: s\.startedAt, source_msg_id: sourceMsgId \};.*\n\s*lastSentAt = now;\n\s*await ch\.send\(\{ type: 'broadcast', event: 'progress', payload \}\)/, '4초 지나면 무조건 다시 방송(값이 그대로여도)');
  assert.match(bridge, /if \(stopped \|\| !s \|\| s\.source !== 'messenger'\) return;/, '상태 파일 source 게이트(검수 M-6)');
  assert.match(bridge, /startTyping\(wsId, job\.orgId, job\.channelId, job\.crewId, job\.slug, \{ full: ch\.kind === 'public', sourceMsgId: job\.msgId \}\)/, 'slug·원본 메시지 id 전달(id는 크루 작업 중단 버튼의 대상) + 본문·사고 방송은 공개 채널만(검수 C-1)');
  assert.doesNotMatch(bridge, /turnTrace = ch\.kind === 'public'/, '메신저 답글에는 궤적을 저장하지 않는다(유건 결정 2026-09-24)');
  assert.match(read('supabase/migrations/20260909003000_msgr_message_meta.sql'), /add column if not exists meta jsonb not null default '\{\}'::jsonb/, 'meta 열');
});

test('클라이언트: progress 방송 → ExecCard는 "답변 준비 중" 한 줄(사고·도구 단계·작성 중 본문·궤적 없음 — 유건 결정 2026-09-24) · 점 세 개는 progress 없는 크루만', () => {
  assert.match(app, /\.on\('broadcast', \{ event: 'progress' \}, active\(onProgressEvent\)\)/, 'progress 수신 — 해제 뒤 콜백을 막는 active() 안에서');
  assert.match(app, /const onProgressEvent = \(\{ payload \}\) => \{ if \(acceptTyping\(settledRef\.current, payload\)\) setProgress\(/, 'progress 처리기 = 답글 직후 늦은 방송 거름 + setProgress(2026-09-23 유령 표시)');
  assert.match(app, /const working = Object\.entries\(progress\)\.filter\(\(\[k, p\]\) => k\.startsWith\(`\$\{chId\}:`\) && Date\.now\(\) - p\.at < 8000 && typing\[k\]/, '실행 카드 대상 = progress+typing 살아 있는 크루');
  assert.match(app, /\{working\.map\(\(\[c, p\]\) => <ExecCard key=\{`exec-\$\{c\.id\}`\} crew=\{c\} t=\{t\} canStop=\{canStop\(c, p\)\} stopping=\{!!stopping\[`\$\{c\.id\}:\$\{p\.source_msg_id\}`\]\} stopRequested=\{!!stopRequested\[`\$\{c\.id\}:\$\{p\.source_msg_id\}`\]\} onStop=\{\(\) => requestStop\(c\.id, p\.source_msg_id\)\} \/>\)\}\n\s*\{typingCrews\.filter\(\(c\) => !workingIds\.has\(c\.id\)\)/, '점 세 개는 카드 없는 크루만 + 중단 버튼 3단 상태 배선(2026-09-26)');
  const card = app.slice(app.indexOf('function ExecCard('), app.indexOf('/** 결재 슬립'));
  assert.match(card, /\{t\('exec\.preparing'\)\}/, '"답변 준비 중"');
  for (const gone of ['exec.thought', 'exec.partial', 'StepList', '<details', 'p.thought', 'p.partial', 'p.steps']) assert.ok(!card.includes(gone), `실행 카드에 ${gone} 없음`);
  assert.match(card, /canStop && <button type="button" className=\{`btn sm ghost msgr-stop-btn\$\{stopRequested \? ' requested' : ''\}`\} disabled=\{stopping \|\| stopRequested\}/, '시킨 사람·크루 주인에게만 보이는 중단 버튼(서버 msgr_request_stop이 권한을 다시 검사) — 중단 중/요청됨이면 비활성, 요청됨은 대비용 클래스(UI LOW)');
  assert.match(read('apps/messenger/src/styles.css'), /\.msgr-exec > \.summary \.msgr-stop-btn\.requested \{ opacity: 1 !important; color: var\(--fg\); background: var\(--card-2\); border-color: var\(--border\); font-weight: 600; \}/, '"중단 요청됨"은 최고 대비 텍스트로 고정(재검수 UI LOW)');
  assert.match(card, /const label = stopRequested \? t\('exec\.stopRequested'\) : stopping \? t\('exec\.stopping'\) : t\('exec\.stop'\);/, '3단 상태 문구(분리 검수 L-3)');
  assert.doesNotMatch(app, /<Trace /, '완료 답글 위 궤적 드롭다운 없음(옛 meta.trace도 그리지 않는다)');
  assert.match(i18n, /'exec\.preparing': \['답변 준비 중', 'Preparing a reply'\]/, 'ko/en');
  assert.match(css, /^\.msgr-exec > \.summary \{/m, '한 줄 스타일');
});

test('P0: 안 읽음 RPC → 레일 배지(멘션은 mark·음소거는 dim)·굵은 이름·새 메시지 구분선(열 때 커서 고정)·보는 채널은 커서 갱신 · 편집/삭제는 본인 hover 액션 · 반응 칩·피커 · 음소거 메뉴·헤더 표시 · 조용한 시간은 알림 게이트', () => {
  assert.match(app, /supabase\.rpc\('msgr_unread', \{ org: orgId === PERSONAL \? null : orgId \}\)/, '안 읽음 RPC(개인 공간은 org=null)');
  assert.match(app, /useEffect\(\(\) => \{ if \(event\?\.kind === 'message'\) loadUnread\(\); \}, \[event\]\);/, '새 메시지 방송이면 재집계');
  assert.match(app, /<span className=\{`msgr-badge\$\{unread\[c\.id\]\.mention \? ' mark' : ''\}\$\{muted\.has\(c\.id\) \? ' dim' : ''\}`\}>\{unread\[c\.id\]\.n\}<\/span>/, '채널 배지');
  assert.match(app, /if \(divider > 0 && !newLine && m\.id > divider && !\(m\.author_kind === 'user' && m\.author_user_id === uid\)\)/, '구분선은 남의 첫 새 글 앞');
  assert.match(app, /afterId \? null : q\(supabase\.from\('msgr_reads'\)[\s\S]{0,200}\n    if \(!afterId\) setDivider\(rd\?\.last_read_id \?\? 0\);/, '구분선 기준은 열 때 한 번, 글보다 먼저(D15 순서는 apps/messenger/test/newline-divider.test.mjs)');
  assert.match(app, /onRead\?\.\(chId, lastId\)/, '보는 채널은 커서 갱신');
  assert.match(app, /supabase\.from\('msgr_reads'\)\.upsert\(\{ channel_id: channelId, user_id: uid, last_read_id: lastId/, '커서 upsert');
  assert.match(app, /\{mine && m\.kind === 'text' && <button type="button" tabIndex=\{tabStop\} onClick=\{\(\) => \{ setDraft\(m\.body\); setEditing\(true\); \}\}>/, '편집은 내 글만(숨은 hover 동작은 탭 순서 밖 — D11)');
  assert.match(app, /\{mine && \(confirmDel \? <button type="button" tabIndex=\{tabStop\} className="danger"/, '삭제는 2단계 확인');
  assert.match(app, /update\(\{ body: '', deleted_at: new Date\(\)\.toISOString\(\) \}\)/, '삭제 = deleted_at + 본문 비움');
  assert.doesNotMatch(app, /const quick = topEmoji\(3\);/, 'hover 추천 없음(유건 지시)'); assert.match(app, /className="msgr-actsheet"[\s\S]*?<div className="quick">[\s\S]*?topEmoji\(5\)/, '빠른 반응은 폰의 길게 누른 시트 안에서만(슬랙식, 2026-09-11)'); assert.match(app, /grid\(topEmoji\(COLS\), 'freq'\)/, '자주 사용은 피커 상단 한 줄(열 수만큼)'); assert.match(app, /function EmojiPicker\(\{ t, anchor, onPick, onClose \}\)[\s\S]*?searchEmoji\(q\)[\s\S]*?EMOJI_GROUPS\.map/, '슬랙식 피커: 검색·자주 사용·분류'); assert.match(app, /className=\{`msgr-emojipop\$\{phone \? ' phone' : ''\}`\} ref=\{ref\}[^\n]*style=\{phone \? undefined : \{ left, top, width: W, maxHeight: H \}\}/, '피커는 화면 고정(스크롤 무관) — 폰은 앵커 대신 아래 시트(CSS)'); assert.match(read('apps/messenger/src/styles.css'), /^\.msgr-emojipop \{ position: fixed;/m, 'fixed'); assert.match(app, /document\.body\.classList\.add\('msgr-lock'\)/, '열린 동안 스크롤 잠금'); assert.match(read('apps/messenger/src/styles.css'), /^body\.msgr-lock \.msgr-thread \{ pointer-events: none; \}/m, '잠금 CSS');
  assert.match(app, /broadcast\?\.\('reaction', \{ channel_id: chId, message_id: m\.id \}\)/, '반응 방송');
  assert.match(app, /if \(event\.kind === 'reaction' && event\.channel_id === chId && event\.message_id\) reloadReacts/, '반응 수신');
  assert.match(app, /label: t\(muted\.has\(c\.id\) \? 'ch\.unmute' : 'ch\.mute'\), run: \(\) => toggleMute\(c\)/, '음소거 메뉴');
  assert.match(app, /if \(r\.muted\.has\(channelId\) \|\| inQuiet\(r\.quiet\)\) return false;/, '알림 게이트');
  assert.match(app, /function inQuiet\(qh\) \{ if \(!qh\) return false; const h = new Date\(\)\.getHours\(\); return qh\.from <= qh\.to \? \(h >= qh\.from && h < qh\.to\) : \(h >= qh\.from \|\| h < qh\.to\); \}/, '자정 넘는 구간');
  for (const k of ['msg.new', 'msg.edited', 'msg.react', 'ui.edit', 'ui.delete', 'ch.mute', 'ch.unmute', 'ch.muted', 'profile.quiet', 'profile.quiet.desc']) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  const mig = read('supabase/migrations/20260909004000_msgr_p0_reads_reactions_prefs.sql');
  assert.match(mig, /create or replace function public\.msgr_unread\(org uuid\)[\s\S]*?security invoker/, 'RPC는 RLS 통과(invoker)');
  assert.match(mig, /m\.deleted_at is null\n\s*and \(m\.author_user_id is null or m\.author_user_id <> \(select auth\.uid\(\)\)\)/, '내 글·삭제 글 제외');
});
