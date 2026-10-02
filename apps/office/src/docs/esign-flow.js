// 서명 요청·다시 보내기·완료 알림의 메일 부분 — 로그인 모드는 오피스 메일 보내기 경로(연결한 Gmail 계정, core/mail.js → api/mail send),
// 예시 모드는 가짜 발송 기록. 메일 계정이 없으면 보내지 않고 링크만 돌려준다(화면이 복사 단추로 보여 준다 — 인트라넷은 메일만 있었다).
import { getMode } from '../core/session.js';
import { getState } from '../core/store.js';
import { backend } from './backend.js';
import { signRequestMail, signCompletedMail } from './esign-mail.js';
import { signedFilename, TOKEN_DAYS, normEmail } from './esign-model.js';
import { getLang } from '../core/i18n.js';

/** 받는 사람이 요청을 보낸 우리 회사인가 — 그러면 내부용 요청 문구 */
const internalOf = (email, company) => !!company?.email && normEmail(email) === normEmail(company.email);

/** 보낼 수 있는 메일 계정(연결 상태 'ok') */
export const mailAccounts = () => (getState().mailAccounts ?? []).filter((a) => a.status === 'ok');

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

async function deliver(space, esignId, account, mail, extra = {}) {
  const be = await backend();
  if (getMode() === 'sample') { await be.recordMail(space, esignId, { to: mail.to, subject: mail.subject, text: mail.text, ...extra }); return 'recorded'; }
  if (!account) return 'skipped';
  const { sendMail } = await import('../core/mail.js');
  await sendMail({ account, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, attachments: mail.attachments ?? [] });
  return 'sent';
}

/** 서명 요청 — 발송 상태로 바꾸고 서명자마다 링크 메일. 반환 { esign, links: [{ name, email, link, delivery }] } */
export async function requestSignatures({ space, esign, signers, fields, company, account }) {
  const be = await backend();
  const { esign: next, links } = await be.sendEsign(space, esign.id, { signers, fields, account });
  for (const l of links) {
    const mail = signRequestMail({ name: l.name, title: next.title, link: l.link, company: company?.name, days: TOKEN_DAYS, internal: internalOf(l.email, company), lang: getLang() });
    try { l.delivery = await deliver(space, esign.id, account, { ...mail, to: l.email }, { link: l.link, kind: 'request' }); }
    catch (e) { l.delivery = 'failed'; l.error = e?.code ?? 'mail'; }
  }
  return { esign: next, links };
}

/** 한 서명자에게 새 링크(옛 링크는 끊긴다) */
export async function resendLink({ space, esign, signer, company, account }) {
  const be = await backend();
  const l = await be.resend(space, esign.id, signer.id);
  const mail = signRequestMail({ name: l.name, title: esign.title, link: l.link, company: company?.name, days: TOKEN_DAYS, internal: internalOf(l.email, company), lang: getLang() });
  try { l.delivery = await deliver(space, esign.id, account, { ...mail, to: l.email }, { link: l.link, kind: 'request' }); }
  catch (e) { l.delivery = 'failed'; l.error = e?.code ?? 'mail'; }
  return l;
}

/** 완료 알림을 직접 보내기(서버가 못 보냈을 때 — 발신 계정이 없거나 만료) — 서명본 첨부 */
export async function sendCompletedNotice({ space, esign, account }) {
  const be = await backend();
  const pdf = await be.esignPdf(space, esign, 'final');
  const mail = signCompletedMail({ title: esign.title, signers: esign.signers });
  const attachments = [{ name: signedFilename(esign.title), type: 'application/pdf', data: b64(pdf) }];
  for (const s of esign.signers) await deliver(space, esign.id, account, { ...mail, to: s.email, attachments }, { kind: 'completed', attachment: attachments[0].name });
  await be.markNotified?.(space, esign.id);
}
