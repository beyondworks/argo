import { steerTurn } from '../../../../../../src/turn-abort.mjs';
import { addSteer, removeSteer } from '../../../../../../src/thread.mjs';
import { loadCompany } from '../../../../../../src/workspace.mjs';
import { nudgeSync } from '../../../../../../src/sync.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 바로 보내기(끼워 넣기) — 답변 중인 사장 턴을 멈추지 않고 대기열의 메시지를 그 실행에 더한다.
    steered:false면 받을 실행이 없다(이미 끝남) — 클라는 메시지를 대기열에 남겨 두고 평소대로 다음 턴으로 보낸다. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { slug, message, attachments: rawAtt } = await req.json();
    const text = String(message ?? '').trim();
    if (!slug || !text) return Response.json({ error: 'slug와 message가 필요합니다' }, { status: 400 });
    // 첨부 신뢰 규칙은 chat 라우트와 같다(업로드 API가 발급한 vault/files/ 상대경로만)
    const attachments = (Array.isArray(rawAtt) ? rawAtt : [])
      .filter((a) => typeof a?.rel === 'string' && a.rel.startsWith('files/') && !a.rel.includes('..'))
      .map((a) => ({ rel: a.rel, name: String(a.name ?? ''), mime: String(a.mime ?? ''), isImage: !!a.isImage }))
      .slice(0, 8);
    const saved = await addSteer(ws, slug, { text, attachments });
    if (!saved) return Response.json({ steered: false });
    const { steerId, turnId } = saved;
    const lang = (await loadCompany(ws).catch(() => ({}))).lang === 'en' ? 'en' : 'ko';
    const attNote = attachments.length
      ? (lang === 'en'
        ? `\n\n(Files the captain attached — read them directly: ${attachments.map((a) => `vault/${a.rel}`).join(', ')})`
        : `\n\n(사장이 첨부한 파일 — 직접 읽어 참고하라: ${attachments.map((a) => `vault/${a.rel}`).join(', ')})`)
      : '';
    // tag = 그 사장 턴(chat 라우트가 abortTag로 등록) — 같은 크루의 결재 후속 턴(source 'chat')으로 새지 않는다
    const steered = await steerTurn(ws, slug, { source: 'chat', tag: turnId, text: `${text}${attNote}` });
    if (!steered) { await removeSteer(ws, slug, steerId).catch(() => {}); return Response.json({ steered: false }); }
    nudgeSync();
    return Response.json({ steered: true, steerId });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
