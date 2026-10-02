// 서명 메일 문구 — 인트라넷 lib/esign/mail.ts의 HTML을 오피스 색(graphite, 액션 #1a1a1a)으로, 글자 본문(text)도 같이 만든다
// (오피스 메일 보내기 경로는 글자 본문을 기본으로 보내고 HTML은 함께 싣는다 — 글자만 보는 메일 앱도 링크를 볼 수 있게).
// 서버 함수(api/esign)와 브라우저가 같이 쓴다. 문구는 한국어 서식(인트라넷과 같음) — 받는 사람 언어를 알 수 없어서다.
import { partyLabel } from './esign-model.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const wrap = (inner) => `<div style="font-family:'Pretendard',-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:8px">${inner}</div>`;
const kicker = (t) => `<p style="font-size:11px;font-weight:700;letter-spacing:2px;color:#6b6b6b;text-transform:uppercase">e-sign · ${t}</p>`;

/** 서명 요청 메일 — { subject, text, html } (인트라넷 mail.ts:57-65, 제목 "[서명 요청] 제목") */
export function signRequestMail({ name, title, link, company = '', days = 30, internal = false, lang = 'ko' }) {
  // 받는 사람이 요청을 보낸 우리 회사면 "(주)비욘드웍스님, (주)비욘드웍스에서…"처럼 겹치지 않게 내부용 문구(유건 10/2 13차). 내부 메일은 보낸 사람 화면 언어로
  if (internal) {
    const en = lang === 'en';
    const head = en ? `Our company's turn to sign — please sign "${title}".` : `우리 회사 서명 차례입니다 — "${title}" 계약서에 서명해 주세요.`;
    const body = en ? `Open the link below and sign online. You will confirm with this email address.\n\n${link}\n\nThe link works for ${days} days.` : `아래 링크를 열어 온라인으로 서명해 주세요. 이 이메일 주소로 본인 확인을 합니다.\n\n${link}\n\n링크는 ${days}일 동안 쓸 수 있습니다.`;
    return {
      subject: en ? `[Signature request] ${title}` : `[서명 요청] ${title}`,
      text: `${head}\n${body}`,
      html: wrap(`${kicker(en ? 'our turn' : '우리 회사 서명')}
    <h2 style="color:#1a1a1a;font-size:20px;margin:6px 0 14px">${esc(title)}</h2>
    <p style="color:#5a5a5a;line-height:1.7;font-size:14px">${esc(head)}</p>
    <p><a href="${esc(link)}" style="display:inline-block;margin:16px 0;background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:700">${en ? 'Sign now' : '서명하러 가기'}</a></p>
    <p style="color:#999;font-size:12px;word-break:break-all">${en ? 'Link' : '링크'}: ${esc(link)}</p>`),
    };
  }
  const from = company ? `${company}에서 ` : '';
  return {
    subject: `[서명 요청] ${title}`,
    text: `${name}님, ${from}"${title}" 계약서에 서명을 요청드립니다.\n아래 링크를 열어 온라인으로 서명(손그림 또는 도장 그림)해 주세요. 서명 요청을 받은 이메일 주소로 본인 확인을 합니다.\n\n${link}\n\n링크는 ${days}일 동안 쓸 수 있습니다.`,
    html: wrap(`${kicker('서명 요청')}
    <h2 style="color:#1a1a1a;font-size:20px;margin:6px 0 14px">${esc(title)}</h2>
    <p style="color:#5a5a5a;line-height:1.7;font-size:14px">${esc(name)}님, ${esc(from)}위 계약서에 서명을 요청드립니다. 아래 버튼을 눌러 온라인으로 서명(손그림 + 도장)해 주세요.</p>
    <p><a href="${esc(link)}" style="display:inline-block;margin:16px 0;background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:700">서명하러 가기</a></p>
    <p style="color:#999;font-size:12px;word-break:break-all">링크: ${esc(link)}<br>링크는 ${days}일 동안 쓸 수 있습니다.</p>`),
  };
}

/** 서명 완료 메일 — 모든 당사자에게 서명본 첨부(인트라넷 mail.ts:68-81, 제목 "[서명 완료] 제목") */
export function signCompletedMail({ title, signers = [] }) {
  const parties = signers.map((s) => ({ label: partyLabel(s.ord ?? 0), name: s.name, email: s.email }));
  const rows = parties.map((p) => `<tr><td style="padding:4px 10px 4px 0;color:#1a1a1a;font-weight:700">${esc(p.label)}</td><td style="padding:4px 0;color:#5a5a5a">${esc(p.name)} &lt;${esc(p.email)}&gt;</td></tr>`).join('');
  return {
    subject: `[서명 완료] ${title}`,
    text: `"${title}" — 모든 당사자의 서명이 완료되었습니다. 서명본 PDF(감사 증명 페이지 포함)를 첨부합니다.\n\n${parties.map((p) => `${p.label}  ${p.name} <${p.email}>`).join('\n')}`,
    html: wrap(`${kicker('서명 완료')}
    <h2 style="color:#1a1a1a;font-size:20px;margin:6px 0 14px">${esc(title)}</h2>
    <p style="color:#5a5a5a;line-height:1.7;font-size:14px">모든 당사자의 서명이 완료되었습니다. 서명본 PDF(감사 증명 페이지 포함)를 첨부합니다.</p>
    ${rows ? `<table style="margin:14px 0;font-size:13px;border-collapse:collapse">${rows}</table>` : ''}`),
  };
}
