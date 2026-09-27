// 메일 번역(버튼을 누를 때만, 유건 9/27) — 메일 주인 기기의 Argo 앱이 주인의 구독으로 번역한다(src/gateway/office-translate.mjs).
// 통로는 본인만 보내고 받는 비공개 실시간 토픽 ot:<uid> — 웹소켓 방송이라 메일 내용이 DB에 남지 않는다.
// 빠르게: 같은 문장은 한 번만 보내고, 묶음으로 나눠 기기에서 4개씩 동시에 번역하고, 끝난 묶음부터 화면에 채운다. 한 번 번역한 메일은 이 기기에 둔다.
import { get, set, del, keys } from 'idb-keyval';
import { getClient } from './supabase.js';
import { batches, wanted } from './tr-batch.js';

const CACHE_MAX = 100;

/** 기기에 번역을 맡긴다. onPart(map) — 조각이 올 때마다 지금까지의 원문→번역 표. 기기가 꺼져 있으면 code 'offline' */
export async function translateStrings(strings, { lang = 'ko', onPart = () => {}, ackMs = 8000, timeoutMs = 180_000 } = {}) {
  const sb = await getClient();
  const uid = (await sb.auth.getSession()).data.session?.user.id;
  if (!uid) throw Object.assign(new Error('signed out'), { code: 'signed_out' });
  const bs = batches(strings.filter((s) => wanted(s, lang)));
  const map = new Map();
  if (!bs.length) return map;
  const rid = crypto.randomUUID();
  await sb.realtime.setAuth();                                    // 비공개 채널 권한은 로그인 토큰으로 판정된다
  const ch = sb.channel(`ot:${uid}`, { config: { private: true } });
  try {
    return await new Promise((resolve, reject) => {
      let acked = false, failed = 0, parts = 0;
      const ackTimer = setTimeout(() => { if (!acked) reject(Object.assign(new Error('device offline'), { code: 'offline' })); }, ackMs);
      const allTimer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs);
      const mine = (fn) => ({ payload }) => { if (payload?.rid === rid) fn(payload); };
      const finish = (fn) => { clearTimeout(ackTimer); clearTimeout(allTimer); fn(); };
      ch.on('broadcast', { event: 'office_translate_ack' }, mine(() => { acked = true; }))
        .on('broadcast', { event: 'office_translate_part' }, mine((p) => {
          const src = bs[p.i]?.items ?? [];
          src.forEach((s, k) => { if (typeof p.items?.[k] === 'string') map.set(s, p.items[k]); });
          onPart(map, p.partial ? parts : ++parts, bs.length);                         // 진행은 끝난 묶음만 센다(중간 결과는 화면만 채운다)
        }))
        .on('broadcast', { event: 'office_translate_fail' }, mine(() => { failed++; onPart(map, ++parts, bs.length); }))
        .on('broadcast', { event: 'office_translate_done' }, mine(() => finish(() => (map.size || !failed ? resolve(Object.assign(map, { failed })) : reject(Object.assign(new Error('failed'), { code: 'failed' }))))))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') ch.send({ type: 'broadcast', event: 'office_translate', payload: { rid, lang, batches: bs } });
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') finish(() => reject(Object.assign(new Error(status), { code: 'offline' })));
        });
    });
  } finally { sb.removeChannel(ch); }
}

/* ── 메일 한 통 ── */
const cacheKey = (m, lang) => `argo-office-tr:${lang}:${m.id}`;

/** 본문(HTML이면 글자 조각, 글이면 줄) + 제목을 번역하고, 번역된 제목·본문을 돌려준다. 한 번 번역한 메일은 이 기기에 둔다 */
export async function translateMail(m, c, { lang = 'ko', onProgress = () => {} } = {}) {
  try { const hit = await get(cacheKey(m, lang)); if (hit) return hit; } catch { /* 저장소 없음 — 그냥 번역 */ }
  const doc = c.html ? new DOMParser().parseFromString(c.html, 'text/html') : null;
  const nodes = [];
  if (doc) { const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (!/^(STYLE|SCRIPT)$/.test(n.parentNode.nodeName) && n.nodeValue.trim()) nodes.push(n); }
  const lines = doc ? [] : String(c.text ?? '').split('\n');
  const strings = [m.subject, ...(doc ? nodes.map((n) => n.nodeValue.trim()) : lines.map((l) => l.trim()))].filter(Boolean);
  const render = (map) => {
    const tr = (s) => map.get(s.trim()) ?? null;
    if (doc) for (const n of nodes) { const t = tr(n.nodeValue); if (t) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), t); }
    const head = doc ? [...doc.head.querySelectorAll('style')].map((s) => s.outerHTML).join('') : '';
    return { subject: map.get(m.subject?.trim()) ?? m.subject, html: doc ? head + doc.body.innerHTML : null, text: doc ? null : lines.map((l) => (l.trim() && map.get(l.trim())) ? l.replace(l.trim(), map.get(l.trim())) : l).join('\n') };
  };
  const map = await translateStrings(strings, { lang, onPart: (mp, done, total) => onProgress({ ...render(mp), done, total }) });
  const out = { ...render(map), partial: map.failed > 0 };
  if (!out.partial) {
    try {
      await set(cacheKey(m, lang), out);
      const all = (await keys()).filter((k) => String(k).startsWith('argo-office-tr:'));
      for (const k of all.slice(0, Math.max(0, all.length - CACHE_MAX))) await del(k);   // ponytail: 오래된 순이 아니라 키 순 정리 — 100통 넘으면 앞에서부터
    } catch { /* 저장 실패는 다음에 다시 번역하면 된다 */ }
  }
  return out;
}
