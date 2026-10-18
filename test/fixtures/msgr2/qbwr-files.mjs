// qbwr 합성 첨부를 Storage API로 올리거나 지운다(scripts/qbwr-seed.sh files·files-rm이 부른다). 키는 환경 변수로만 받고 출력하지 않는다.
// 사용: QBWR_STORAGE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node qbwr-files.mjs [""|-rm] attachments.json
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [, , mode, manifest] = process.argv;
const base = process.env.QBWR_STORAGE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base?.includes('qbwrlynzvjmphwuqglsx') || !key) { console.error('거부  qbwr Storage 주소와 키가 필요합니다'); process.exit(5); }
const list = JSON.parse(readFileSync(manifest, 'utf8'));
const H = { authorization: `Bearer ${key}`, apikey: key };
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

if (mode === '-rm') {
  let n = 0;
  for (let i = 0; i < list.length; i += 100) { // 한 번에 100개(Storage API 삭제는 경로 목록)
    const r = await fetch(`${base}/storage/v1/object/msgr`, { method: 'DELETE', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: list.slice(i, i + 100).map((x) => x.path) }) });
    if (!r.ok) { console.error(`삭제 실패 ${r.status} (${i}번째부터)`); process.exit(3); }
    n += (await r.json()).length;
  }
  console.log(`지움 ${n}/${list.length}`);
} else {
  let ok = 0, fail = 0;
  const queue = [...list];
  const worker = async () => {
    for (let x; (x = queue.shift());) {
      const r = await fetch(`${base}/storage/v1/object/${x.bucket}/${enc(x.path)}`, { method: 'POST', headers: { ...H, 'content-type': 'text/plain', 'x-upsert': 'true' }, body: randomBytes(x.bytes) });
      if (r.ok) ok++; else { fail++; if (fail <= 3) console.error(`올리기 실패 ${r.status}`); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker)); // 동시 8개
  console.log(`올림 ${ok}/${list.length}, 실패 ${fail}`);
  if (fail) process.exit(3);
}
