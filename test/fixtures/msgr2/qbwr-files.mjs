// qbwr 합성 첨부를 Storage API로 올리거나 지운다(scripts/qbwr-seed.sh files·files-rm이 부른다). 키는 환경 변수로만 받고 출력하지 않는다.
// 사용: node qbwr-files.mjs [""|-rm] attachments.json
//   서비스 키 방식: QBWR_STORAGE_URL(https://<qbwr>.supabase.co) + QBWR_SERVICE_ROLE_KEY(JWT ref = qbwr·service_role)
//   사용자 방식(서비스 키가 없을 때): C·QBWR_ANON_KEY·QBWR_SEED_PASSWORD — 백필(Q4) 뒤에 각 첨부의 글쓴이(합성 계정)로 로그인해 앱 기기를 등록하고
//     그 사람 권한으로 자기 방 경로에 올린다(실제 사용자 경로와 같다). 지우기는 정책상 허용되는 것만 지워지고, 남은 것은 QBWR_LEFTOVER 파일에 경로를 남긴다.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ORIGIN, jwtOk, originOk, userEnv } from './qbwr-lib.mjs';

const [, , mode, manifest] = process.argv;
const key = process.env.QBWR_SERVICE_ROLE_KEY;
const list = () => JSON.parse(readFileSync(manifest, 'utf8'));
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

if (key) {
  // 주소는 정확히 https://<qbwr>.supabase.co(경로·포트 없음), 키는 JWT 페이로드 ref = qbwr·역할 service_role(#1093 검수 3: "ref 포함"만 보면 운영 주소 경로에 끼워 넣어 통과했다)
  if (!originOk(process.env.QBWR_STORAGE_URL) || !jwtOk(key, 'service_role')) { console.error(`거부  qbwr Storage 주소(${ORIGIN})와 qbwr service_role 키가 필요합니다`); process.exit(5); }
  const H = { authorization: `Bearer ${key}`, apikey: key };
  const items = list();
  if (mode === '-rm') {
    let n = 0;
    for (let i = 0; i < items.length; i += 100) { // 한 번에 100개(Storage API 삭제는 경로 목록)
      const r = await fetch(`${ORIGIN}/storage/v1/object/msgr`, { method: 'DELETE', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: items.slice(i, i + 100).map((x) => x.path) }) });
      if (!r.ok) { console.error(`삭제 실패 ${r.status} (${i}번째부터)`); process.exit(3); }
      n += (await r.json()).length;
    }
    console.log(`지움 ${n}/${items.length}(서비스 키)`);
  } else {
    let ok = 0, fail = 0;
    const queue = [...items];
    const worker = async () => {
      for (let x; (x = queue.shift());) {
        const r = await fetch(`${ORIGIN}/storage/v1/object/${x.bucket}/${enc(x.path)}`, { method: 'POST', headers: { ...H, 'content-type': 'text/plain', 'x-upsert': 'true' }, body: randomBytes(x.bytes) });
        if (r.ok) ok++; else { fail++; if (fail <= 3) console.error(`올리기 실패 ${r.status}`); }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker)); // 동시 8개
    console.log(`올림 ${ok}/${items.length}, 실패 ${fail}(서비스 키)`);
    if (fail) process.exit(3);
  }
} else {
  const { sql, loginUid, reg } = userEnv(); // 검문한 접속·qbwr anon 키가 아니면 exit 5
  const items = list();
  const wanted = new Set(items.map((x) => `msgr/${x.path}`));
  // 백필된 첨부 행에서 글쓴이를 찾는다(합성 계정만). 글쓴이가 없는 첨부(작성자 지운 글 등)는 올리지 못하고 목록에 남긴다
  const rows = sql(`select a.storage_path || '|' || coalesce(m.author_user_id::text, '') from public.msgr2_attachments a join public.msgr2_messages m on m.id = a.message_id
                    where a.storage_path like 'msgr/%' and a.id::text like 'c906%'`).split('\n').filter(Boolean)
    .map((l) => l.split('|')).filter(([p]) => wanted.has(p));
  const byUser = new Map();
  const leftover = [];
  for (const [full, uid] of rows) { if (!uid) { leftover.push({ path: full, why: 'no_author' }); continue; } if (!byUser.has(uid)) byUser.set(uid, []); byUser.get(uid).push(full.replace(/^msgr\//, '')); }
  let ok = 0, fail = 0;
  for (const [uid, paths] of byUser) {
    const s = await loginUid(uid);
    const d = await reg(s);
    if (!d.id) { for (const p of paths) leftover.push({ path: `msgr/${p}`, why: `device ${d.err}` }); fail += paths.length; continue; }
    if (mode === '-rm') {
      const { data, error } = await s.c.storage.from('msgr').remove(paths);
      const gone = new Set((data ?? []).map((o) => o.name));
      for (const p of paths) if (gone.has(p)) ok++; else { fail++; leftover.push({ path: `msgr/${p}`, why: error ? error.message : 'policy' }); }
    } else {
      for (const p of paths) {
        const bytes = items.find((x) => x.path === p)?.bytes ?? 1024;
        const { error } = await s.c.storage.from('msgr').upload(p, randomBytes(bytes), { contentType: 'text/plain', upsert: true });
        if (error) { fail++; leftover.push({ path: `msgr/${p}`, why: error.message }); } else ok++;
      }
    }
  }
  const out = process.env.QBWR_LEFTOVER;
  if (out) writeFileSync(out, JSON.stringify(leftover, null, 1));
  console.log(`${mode === '-rm' ? '지움' : '올림'} ${ok}/${items.length}, 못 한 것 ${leftover.length}(사용자 토큰${out ? `, 목록 ${out}` : ''}) — 못 지운 것은 서비스 키가 생긴 뒤 files-rm으로`);
  if (mode !== '-rm' && fail) process.exit(3);
}
