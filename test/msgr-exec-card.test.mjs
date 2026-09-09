// 실행 카드·궤적·P0(2026-09-09 유건 지시 "UI 대폭 업그레이드") — 서버(상태 파일 steps·브리지 progress 방송·답글 meta.trace)와
// 클라이언트(ExecCard·Trace·안 읽음 배지·구분선·편집/삭제·반응·음소거·조용한 시간)의 배선을 소스 구간으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const app = read('apps/messenger/src/App.jsx'); const i18n = read('apps/messenger/src/i18n.js'); const css = read('apps/messenger/src/styles.css');
const bridge = read('src/gateway/msgr.mjs'); const chat = read('src/chat.mjs'); const ts = read('src/turn-status.mjs');

test('서버: chat.mjs가 steps를 상태 파일에 싣고 trace(steps·thought·ms·model·costUsd)를 반환 · 브리지는 1.5초마다 바뀐 스냅샷만 progress로 방송하고 답글에 meta.trace를 붙인다', () => {
  assert.match(ts, /steps: Array\.isArray\(steps\) \? steps\.slice\(-40\) : \(prev\.steps \?\? \[\]\)/, '상태 파일 steps(뒤 40)');
  assert.match(chat, /const trace = \{ steps, thought: String\(thought \?\? ''\)\.slice\(-1500\), ms: Date\.now\(\) - t0, model: actualModel \|\| null, costUsd \};/, 'trace 조립');
  assert.match(chat, /return \{ reply, sessionId: sid, handover, costUsd, trace, artifacts/, 'trace 반환');
  assert.match(bridge, /import \{ getTurnStatus \} from '\.\.\/turn-status\.mjs';/, '브리지가 상태 파일을 읽는다');
  assert.match(bridge, /const PROGRESS_MS = 1_500;/, '방송 주기');
  assert.match(bridge, /if \(key === last\) return;\n\s*last = key;\n\s*await ch\.send\(\{ type: 'broadcast', event: 'progress', payload \}\)/, '바뀐 스냅샷만 방송');
  assert.match(bridge, /startTyping\(wsId, job\.orgId, job\.channelId, job\.crewId, job\.slug\)/, 'slug 전달');
  assert.match(bridge, /\.\.\.\(turnTrace \? \{ meta: \{ trace: turnTrace \} \} : \{\}\)/, '답글 meta.trace(실패 턴은 없음)');
  assert.match(read('supabase/migrations/20260909003000_msgr_message_meta.sql'), /add column if not exists meta jsonb not null default '\{\}'::jsonb/, 'meta 열');
});

test('클라이언트: progress 방송 → ExecCard(단계·경과·도구 수·사고 과정·도구 단계·부분 텍스트 드롭다운), 완료 답글은 Trace(접힘) · 점 세 개는 progress 없는 크루만', () => {
  assert.match(app, /\.on\('broadcast', \{ event: 'progress' \}, \(\{ payload \}\) => setProgress/, 'progress 수신');
  assert.match(app, /const working = Object\.entries\(progress\)\.filter\(\(\[k, p\]\) => k\.startsWith\(`\$\{chId\}:`\) && Date\.now\(\) - p\.at < 8000 && typing\[k\]/, '실행 카드 대상 = progress+typing 살아 있는 크루');
  assert.match(app, /\{working\.map\(\(\[c, p\]\) => <ExecCard key=\{`exec-\$\{c\.id\}`\} crew=\{c\} p=\{p\} t=\{t\} \/>\)\}\n\s*\{typingCrews\.filter\(\(c\) => !workingIds\.has\(c\.id\)\)/, '점 세 개는 카드 없는 크루만');
  assert.match(app, /function ExecCard\(\{ crew, p, t \}\)[\s\S]*?<details className="msgr-exec"[\s\S]*?\{t\('exec\.thought'\)\}[\s\S]*?<StepList steps=\{p\.steps\}[\s\S]*?\{t\('exec\.partial'\)\}/, 'ExecCard 구성');
  assert.match(app, /\{m\.meta\?\.trace && <Trace trace=\{m\.meta\.trace\} t=\{t\} \/>\}<Markdown text=\{body\} \/>/, '크루 답글 위 궤적');
  assert.match(app, /function Trace\(\{ trace, t \}\)[\s\S]*?<details className="msgr-trace">/, 'Trace는 details(기본 접힘)');
  for (const k of ['exec.meta', 'exec.thought', 'exec.steps', 'exec.partial', 'trace.summary', 'chat.stage.memory', 'chat.stage.shell', 'chat.stage.runner']) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  assert.match(css, /^\.msgr-exec, \.msgr-trace \{/m, '카드 스타일');
});

test('P0: 안 읽음 RPC → 레일 배지(멘션은 mark·음소거는 dim)·굵은 이름·새 메시지 구분선(열 때 커서 고정)·보는 채널은 커서 갱신 · 편집/삭제는 본인 hover 액션 · 반응 칩·피커 · 음소거 메뉴·헤더 표시 · 조용한 시간은 알림 게이트', () => {
  assert.match(app, /supabase\.rpc\('msgr_unread', \{ org: orgId \}\)/, '안 읽음 RPC');
  assert.match(app, /useEffect\(\(\) => \{ if \(event\?\.kind === 'message'\) loadUnread\(\); \}, \[event\]\);/, '새 메시지 방송이면 재집계');
  assert.match(app, /<span className=\{`msgr-badge\$\{unread\[c\.id\]\.mention \? ' mark' : ''\}\$\{muted\.has\(c\.id\) \? ' dim' : ''\}`\}>\{unread\[c\.id\]\.n\}<\/span>/, '채널 배지');
  assert.match(app, /if \(divider > 0 && !newLine && m\.id > divider && !\(m\.author_kind === 'user' && m\.author_user_id === uid\)\)/, '구분선은 남의 첫 새 글 앞');
  assert.match(app, /if \(!afterId\) \{ const rd = await q\(supabase\.from\('msgr_reads'\)/, '구분선 기준은 열 때 한 번');
  assert.match(app, /onRead\?\.\(chId, lastId\)/, '보는 채널은 커서 갱신');
  assert.match(app, /supabase\.from\('msgr_reads'\)\.upsert\(\{ channel_id: channelId, user_id: uid, last_read_id: lastId/, '커서 upsert');
  assert.match(app, /\{mine && m\.kind === 'text' && <button type="button" onClick=\{\(\) => \{ setDraft\(m\.body\); setEditing\(true\); \}\}>/, '편집은 내 글만');
  assert.match(app, /\{mine && \(confirmDel \? <button type="button" className="danger"/, '삭제는 2단계 확인');
  assert.match(app, /update\(\{ body: '', deleted_at: new Date\(\)\.toISOString\(\) \}\)/, '삭제 = deleted_at + 본문 비움');
  assert.match(app, /const quick = topEmoji\(3\);/, 'hover 즉시 반응 3개(빈도순)'); assert.match(app, /function EmojiPicker\(\{ t, onPick, onClose \}\)[\s\S]*?searchEmoji\(q\)[\s\S]*?EMOJI_GROUPS\.map/, '슬랙식 피커: 검색·자주 사용·분류');
  assert.match(app, /broadcast\?\.\('reaction', \{ channel_id: chId, message_id: m\.id \}\)/, '반응 방송');
  assert.match(app, /if \(event\.kind === 'reaction' && event\.channel_id === chId && event\.message_id\) reloadReacts/, '반응 수신');
  assert.match(app, /\{t\(muted\.has\(c\.id\) \? 'ch\.unmute' : 'ch\.mute'\)\}/, '음소거 메뉴');
  assert.match(app, /if \(r\.muted\.has\(channelId\) \|\| inQuiet\(r\.quiet\)\) return false;/, '알림 게이트');
  assert.match(app, /function inQuiet\(qh\) \{ if \(!qh\) return false; const h = new Date\(\)\.getHours\(\); return qh\.from <= qh\.to \? \(h >= qh\.from && h < qh\.to\) : \(h >= qh\.from \|\| h < qh\.to\); \}/, '자정 넘는 구간');
  for (const k of ['msg.new', 'msg.edited', 'msg.react', 'ui.edit', 'ui.delete', 'ch.mute', 'ch.unmute', 'ch.muted', 'profile.quiet', 'profile.quiet.desc']) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  const mig = read('supabase/migrations/20260909004000_msgr_p0_reads_reactions_prefs.sql');
  assert.match(mig, /create or replace function public\.msgr_unread\(org uuid\)[\s\S]*?security invoker/, 'RPC는 RLS 통과(invoker)');
  assert.match(mig, /m\.deleted_at is null\n\s*and \(m\.author_user_id is null or m\.author_user_id <> \(select auth\.uid\(\)\)\)/, '내 글·삭제 글 제외');
});
