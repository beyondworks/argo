// 예시 데이터 모드의 문서·전자서명 저장소 — 서버 대신 이 브라우저(IndexedDB)에 같은 흐름을 담는다(spec8 규칙 3).
// 서명 링크(/sign/<토큰>)를 같은 브라우저의 새 탭에서 열면 서명까지 이어지고, 메일은 "가짜 발송 기록"으로 남는다.
// 실제 경로(backend-live.js)와 같은 모양을 돌려준다 — 화면은 둘을 구분하지 않는다. kv·compose를 주입받아 노드 테스트로 흐름 전체를 잠근다.
import { signCompletedMail } from './esign-mail.js';
import { signedFilename, cleanSigners, normalizeFields, normalizePlacements, normEmail, maskEmail, sha256Hex, newToken, expiresAt, signLink, tokenOk, TOKEN_DAYS } from './esign-model.js';
import { DOC } from './doc-text.js';

const KEY = 'argo-office-docs:sample';
const blobKey = (path) => `argo-office-docs-blob:${path}`;
const uid = () => globalThis.crypto.randomUUID();
const fail = (code) => Object.assign(new Error(code), { code });

/** 공개 서명자 보기(토큰·IP 등 내부 값 빼고) */
const publicSigner = ({ token_hash, token_expires, ip, ua, placements, ...s }) => s;
const allSigned = (st, esignId) => { const list = st.signers.filter((s) => s.esign_id === esignId); return list.length > 0 && list.every((s) => s.status === 'signed'); };
const publicEsign = (e, signers) => ({ ...e, signers: signers.filter((s) => s.esign_id === e.id).sort((a, b) => a.ord - b.ord).map(publicSigner) });

/** kv: { get(key) → Promise<값>, set(key, 값) → Promise, del(key) → Promise } · compose(bundle) → Uint8Array(서명본) · confirmOrder(space, orderId, at) · now() */
export function createSampleDocs({ kv, compose, confirmOrder = async () => 'skipped', now = () => new Date().toISOString(), origin = () => globalThis.location?.origin ?? 'http://localhost' }) {
  let chain = Promise.resolve();
  const read = async () => ({ docs: [], esign: [], signers: [], events: [], mails: [], ...((await kv.get(KEY)) ?? {}) });
  /** 한 번에 하나씩(같은 탭 안의 동시 쓰기가 서로를 덮지 않게) */
  const tx = (fn) => { const run = chain.then(async () => { const st = await read(); const out = await fn(st); await kv.set(KEY, st); return out; }); chain = run.catch(() => {}); return run; };
  const event = (st, esignId, actor, action, extra = {}) => { st.events.push({ id: uid(), esign_id: esignId, actor, action, at: now(), ...extra }); };
  const putBlob = (path, bytes) => kv.set(blobKey(path), bytes);
  const getBlob = async (path) => { const b = await kv.get(blobKey(path)); if (!b) throw fail('missing_file'); return b instanceof Uint8Array ? b : new Uint8Array(b); };
  const esignOf = (st, space, id) => { const e = st.esign.find((x) => x.id === id && x.space === space); if (!e) throw fail('not_found'); return e; };

  async function bySigner(token) {
    if (!tokenOk(token)) return null;
    const hash = await sha256Hex(token);
    const st = await read();
    const signer = st.signers.find((s) => s.token_hash === hash);
    if (!signer || Date.parse(signer.token_expires) < Date.parse(now())) return null;
    const esign = st.esign.find((e) => e.id === signer.esign_id);
    return esign ? { signer, esign } : null;
  }

  /** 전원 서명 → 서명본 합성·보관·완료(서버 경로에서는 api/esign이 한다). 다시 불러도 같은 결과 */
  async function complete(esignId) {
    const st = await read();
    const e = st.esign.find((x) => x.id === esignId);
    if (e.status === 'completed') return { done: true, final: await getBlob(e.final_path), signers: st.signers.filter((x) => x.esign_id === e.id).map(publicSigner), title: e.title, esignId: e.id };
    if ((await sha256Hex(await getBlob(e.orig_path))) !== e.doc_hash) throw fail('tampered');
    const signers = st.signers.filter((x) => x.esign_id === e.id).sort((a, b) => a.ord - b.ord);
    const completedAt = now();
    const final = await compose({
      origPdf: await getBlob(e.orig_path), docHash: e.doc_hash, title: e.title, completedAt,
      signers: signers.map((s) => ({ ...s, placements: s.placements.map((p) => (p.img ? { ...p, img: { type: p.img.type, bytes: Uint8Array.from(atob(p.img.data), (c) => c.charCodeAt(0)) } } : p)) })),
    });
    const finalPath = `${e.space}/esign/${e.id}/final.pdf`;
    await putBlob(finalPath, final);
    const finalHash = await sha256Hex(final);
    const sync = e.order_id ? await confirmOrder(e.space, e.order_id, completedAt).catch((err) => `failed:${err?.code ?? err?.message ?? 'error'}`) : null;
    await tx((s2) => {
      const row = s2.esign.find((x) => x.id === e.id);
      Object.assign(row, { status: 'completed', final_path: finalPath, final_hash: finalHash, completed_at: completedAt, order_sync: sync });
      event(s2, row.id, 'system', 'completed');
      const mail = signCompletedMail({ title: row.title, signers });
      signers.forEach((sg) => s2.mails.push({ id: uid(), esign_id: row.id, at: completedAt, to: sg.email, subject: mail.subject, text: mail.text, attachment: signedFilename(row.title), kind: 'completed' })); // 가짜 발송 기록(서버 경로는 발신 계정으로 실제 발송)
    });
    return { done: true, final, signers: signers.map(publicSigner), title: e.title, esignId: e.id };
  }

  return {
    mode: 'sample',
    async load(space) {
      const st = await read();
      return {
        // 실제 경로와 같은 모양 — 목록에는 입력값(input)·칸 배치(fields)를 싣지 않는다(열 때 getDoc·getEsign)
        docs: st.docs.filter((d) => d.space === space).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ input, ...d }) => d),
        esign: st.esign.filter((e) => e.space === space).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((e) => { const { fields, ...rest } = publicEsign(e, st.signers); return rest; }),
        can_write: true,
      };
    },
    async getDoc(space, id) { const d = (await read()).docs.find((x) => x.id === id && x.space === space); if (!d) throw fail('not_found'); return d; },
    async getEsign(space, id) { const st = await read(); return publicEsign(esignOf(st, space, id), st.signers); },
    async saveDoc(space, d) {
      const id = d.id ?? uid();
      const path = `${space}/docs/${id}.pdf`;
      if (d.pdf) await putBlob(path, d.pdf);
      return tx((st) => {
        const old = st.docs.find((x) => x.id === id);
        const row = { ...(old ?? { created_at: now() }), id, space, kind: d.kind, title: d.title, customer_name: d.customer_name ?? '', customer_id: d.customer_id || null, order_id: d.order_id || null,
          input: d.input ?? {}, pdf_path: d.pdf ? path : old?.pdf_path ?? '', pdf_size: d.pdf ? d.pdf.byteLength : old?.pdf_size ?? 0, pdf_hash: d.pdf_hash ?? old?.pdf_hash ?? '', filename: d.filename ?? old?.filename ?? '',
          supply: d.supply ?? 0, vat: d.vat ?? 0, total: d.total ?? 0, updated_at: now() };
        if (old) Object.assign(old, row); else st.docs.push(row);
        return row;
      });
    },
    docPdf: (space, doc) => getBlob(doc.pdf_path),
    async deleteDoc(space, id) {
      const paths = await tx((st) => { const d = st.docs.find((x) => x.id === id && x.space === space); st.docs = st.docs.filter((x) => x !== d); st.esign.forEach((e) => { if (e.doc_id === id) e.doc_id = null; }); return d?.pdf_path ? [d.pdf_path] : []; });
      await Promise.all(paths.map((p) => kv.del(blobKey(p))));
    },

    async createEsign(space, { id = uid(), title, docId = null, orderId = null, pdf, docHash, fields = [], signers = [], pages = Infinity }) {
      const orig = `${space}/esign/${id}/orig.pdf`;
      await putBlob(orig, pdf);
      return tx((st) => {
        const row = { id, space, title: String(title || '').trim().slice(0, 200) || DOC.untitledEsign, doc_id: docId, order_id: orderId, status: 'draft', orig_path: orig, doc_hash: docHash, final_path: null, final_hash: null,
          fields: normalizeFields(fields, pages), pages: Number.isFinite(pages) ? pages : null, created_at: now(), sent_at: null, completed_at: null, cancelled_at: null, filed_at: null, order_sync: null };
        st.esign.push(row);
        cleanSigners(signers).forEach((s, ord) => st.signers.push({ id: uid(), esign_id: id, ord, ...s, status: 'pending', token_hash: '', token_expires: null, signed_at: null, opened_at: null, ip: null, ua: null, placements: [] }));
        event(st, id, 'owner', 'created');
        return publicEsign(row, st.signers);
      });
    },
    updateEsign: (space, id, { title, fields, signers }) => tx((st) => {
      const e = esignOf(st, space, id);
      if (title !== undefined) { const t = String(title).trim().slice(0, 200); if (!t) throw fail('title'); if (t !== e.title) { e.title = t; event(st, id, 'owner', 'renamed'); } }
      if (fields !== undefined || signers !== undefined) {
        if (e.status !== 'draft') throw fail('state');
        if (fields !== undefined) e.fields = normalizeFields(fields, e.pages ?? Infinity);
        if (signers !== undefined) { st.signers = st.signers.filter((s) => s.esign_id !== id); cleanSigners(signers).forEach((s, ord) => st.signers.push({ id: uid(), esign_id: id, ord, ...s, status: 'pending', token_hash: '', token_expires: null, signed_at: null, opened_at: null, ip: null, ua: null, placements: [] })); }
      }
      return publicEsign(e, st.signers);
    }),
    /** 발송 — 서명자마다 새 토큰(해시만 저장), 링크 원문은 돌려준다(메일은 화면이 보낸다 — sendRecords) */
    async sendEsign(space, id, { signers, fields }) {
      const valid = cleanSigners(signers);
      const tokens = await Promise.all(valid.map(async () => { const token = newToken(); return { token, hash: await sha256Hex(token) }; }));
      return tx((st) => {
        const e = esignOf(st, space, id);
        if (e.status === 'completed') throw fail('completed');
        if (e.status === 'sent') throw fail('sent');
        if (e.status === 'cancelled') throw fail('cancelled');
        if (!valid.length) throw fail('signers');
        if (st.signers.some((s) => s.esign_id === id && s.status === 'signed')) throw fail('signed'); // 서명 기록 보호(인트라넷 send route:37-39)
        e.fields = normalizeFields(fields, e.pages ?? Infinity);
        st.signers = st.signers.filter((s) => s.esign_id !== id);
        const links = valid.map((s, ord) => {
          st.signers.push({ id: uid(), esign_id: id, ord, ...s, status: 'pending', token_hash: tokens[ord].hash, token_expires: expiresAt(Date.parse(now()), TOKEN_DAYS), signed_at: null, opened_at: null, ip: null, ua: null, placements: [] });
          return { ord, name: s.name, email: s.email, link: signLink(origin(), tokens[ord].token) };
        });
        e.status = 'sent'; e.sent_at = now();
        event(st, id, 'owner', 'sent');
        return { esign: publicEsign(e, st.signers), links };
      });
    },
    /** 서명 대기 중인 한 사람에게 새 링크(옛 링크는 끊긴다) */
    async resend(space, id, signerId) {
      const token = newToken(), hash = await sha256Hex(token);
      return tx((st) => {
        const e = esignOf(st, space, id);
        const s = st.signers.find((x) => x.id === signerId && x.esign_id === id);
        if (e.status !== 'sent' || !s || s.status === 'signed') throw fail('state');
        s.token_hash = hash; s.token_expires = expiresAt(Date.parse(now()), TOKEN_DAYS);
        event(st, id, 'owner', 'resent');
        return { ord: s.ord, name: s.name, email: s.email, link: signLink(origin(), token) };
      });
    },
    // 전원 서명 건은 취소하지 않는다(완료 다시 시도로 끝낸다)
    cancelEsign: (space, id) => tx((st) => { const e = esignOf(st, space, id); if (e.status === 'completed') throw fail('completed'); if (e.status === 'sent' && allSigned(st, id)) throw fail('signed'); if (e.status === 'cancelled') return publicEsign(e, st.signers); e.status = 'cancelled'; e.cancelled_at = now(); event(st, id, 'owner', 'cancelled'); return publicEsign(e, st.signers); }),
    async deleteEsign(space, id) {
      const paths = await tx((st) => { const e = esignOf(st, space, id); st.esign = st.esign.filter((x) => x !== e); st.signers = st.signers.filter((s) => s.esign_id !== id); st.events = st.events.filter((x) => x.esign_id !== id); st.mails = st.mails.filter((m) => m.esign_id !== id); return [e.orig_path, e.final_path].filter(Boolean); });
      await Promise.all(paths.map((p) => kv.del(blobKey(p))));
    },
    /** 완료 다시 시도 — 전원 서명했는데 아직 완료가 아닌 건만 */
    async finishEsign(space, id) {
      const st = await read();
      const e = esignOf(st, space, id);
      if (e.status !== 'sent' || !allSigned(st, id)) throw fail('state');
      return complete(id);
    },
    markFiled: (space, id) => tx((st) => { const e = esignOf(st, space, id); e.filed_at = now(); }),
    esignPdf: (space, e, which = 'orig') => getBlob(which === 'final' ? e.final_path : e.orig_path),
    events: async (space, id) => (await read()).events.filter((x) => x.esign_id === id),
    /** 가짜 발송 기록(예시 모드) — 메일 서버 없이 보낸 것으로 남기고 화면에 보여 준다 */
    recordMail: (space, id, mail) => tx((st) => { st.mails.push({ id: uid(), esign_id: id, at: now(), ...mail }); }),
    mails: async (space, id) => (await read()).mails.filter((m) => m.esign_id === id),

    /* ── 공개 서명(로그인 없음) — 인트라넷 app/api/esign/sign/[token]/route.ts와 같은 규칙 ── */
    async publicState(token) {
      const r = await bySigner(token);
      if (!r) throw fail('invalid');
      if (['completed', 'cancelled'].includes(r.esign.status)) return { status: r.esign.status };
      return { status: r.signer.status, maskedEmail: maskEmail(r.signer.email) };
    },
    async publicOpen(token, email) {
      const r = await bySigner(token);
      if (!r) throw fail('invalid');
      if (r.esign.status === 'completed') throw fail('completed');
      if (r.esign.status === 'cancelled') throw fail('cancelled');
      if (r.esign.status !== 'sent') throw fail('invalid');
      if (normEmail(email) !== normEmail(r.signer.email)) throw fail('email');
      if (r.signer.status !== 'signed') await tx((st) => { const s = st.signers.find((x) => x.id === r.signer.id); const recent = s.opened_at && Date.parse(now()) - Date.parse(s.opened_at) < 10 * 60e3; s.opened_at = now(); if (!recent) event(st, r.esign.id, s.email, 'opened', { ip: 'local', ua: globalThis.navigator?.userAgent?.slice(0, 300) ?? '' }); }); // 열람 기록은 10분에 한 번(쌓임 방지)
      return {
        alreadySigned: r.signer.status === 'signed', signer: { name: r.signer.name, email: r.signer.email, status: r.signer.status, ord: r.signer.ord },
        contract: { title: r.esign.title }, fields: (r.esign.fields ?? []).filter((f) => f.signer_ord === r.signer.ord), pdf: await getBlob(r.esign.orig_path),
      };
    },
    async publicSubmit(token, email, rawPlacements) {
      const r = await bySigner(token);
      if (!r) throw fail('invalid');
      if (r.esign.status !== 'sent') throw fail(r.esign.status === 'completed' ? 'completed' : r.esign.status === 'cancelled' ? 'cancelled' : 'invalid');
      if (normEmail(email) !== normEmail(r.signer.email)) throw fail('email');
      if (r.signer.status === 'signed') { if (allSigned(await read(), r.esign.id)) return complete(r.esign.id); throw fail('already'); } // 마무리만 끊긴 경우 이어서
      const placements = normalizePlacements(rawPlacements, r.esign.pages ?? Infinity);
      if (!placements.length) throw fail('empty');
      const done = await tx((st) => {
        const s = st.signers.find((x) => x.id === r.signer.id);
        Object.assign(s, { status: 'signed', signed_at: now(), ip: 'local', ua: globalThis.navigator?.userAgent?.slice(0, 300) ?? '', placements });
        event(st, r.esign.id, s.email, 'signed', { ip: 'local' });
        return st.signers.filter((x) => x.esign_id === r.esign.id).every((x) => x.status === 'signed');
      });
      if (!done) return { done: false };
      return complete(r.esign.id);
    },
  };
}
