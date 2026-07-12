import { relative, join, resolve, basename } from 'node:path';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { listDocs, readDoc } from '../../../../../src/hub.mjs';
import { saveNote, updateIndex } from '../../../../../src/memory.mjs';
import { paths } from '../../../../../src/workspace.mjs';
import { appendEvent } from '../../../../../src/events.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** notes/ 안의 안전한 절대 경로만 통과 — 기억 통제(편집/삭제)는 주제 노트에만 허용된다. */
function noteFile(ws, rel) {
  const p = paths(ws);
  const file = resolve(p.vault, rel);
  if (!file.startsWith(resolve(p.notes) + '/') || !file.endsWith('.md')) throw new Error('주제 노트만 수정할 수 있습니다');
  return file;
}

export async function GET(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const rel = new URL(req.url).searchParams.get('rel');
    if (rel) return Response.json({ rel, content: await readDoc(ws, rel) });
    const docs = await listDocs(ws);
    let index = '';
    try { index = await readDoc(ws, '_index.md'); } catch {}
    return Response.json({ docs, index });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 지식 노트 직접 작성 — 저장 즉시 기존 기억과 자동 링크. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { title, content } = await req.json();
    if (!title?.trim() || !content?.trim()) {
      return Response.json({ error: '제목과 내용이 필요합니다' }, { status: 400 });
    }
    const { file, linked } = await saveNote(ws, title, content);
    return Response.json({ rel: relative(paths(ws).vault, file), linked });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

/** 주제 노트 직접 수정 — 사용자가 AI의 기억을 그 자리에서 고친다(통제 원칙). */
export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { rel, content } = await req.json();
    if (!rel || !content?.trim()) return Response.json({ error: 'rel·content가 필요합니다' }, { status: 400 });
    await writeFile(noteFile(ws, rel), content.endsWith('\n') ? content : `${content}\n`);
    await updateIndex(ws);
    await appendEvent(ws, { type: 'memory', ok: true, notes: [basename(rel, '.md')], op: 'edit' });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 주제 노트 삭제 — vault/.trash/로 이동(감사 가능), 인덱스에서 즉시 제거. */
export async function DELETE(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const rel = new URL(req.url).searchParams.get('rel');
    const file = noteFile(ws, rel ?? '');
    const trash = join(paths(ws).vault, '.trash');
    await mkdir(trash, { recursive: true });
    await rename(file, join(trash, `${Date.now()}-${basename(file)}`));
    await updateIndex(ws);
    await appendEvent(ws, { type: 'memory', ok: true, notes: [basename(file, '.md')], op: 'delete' });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
