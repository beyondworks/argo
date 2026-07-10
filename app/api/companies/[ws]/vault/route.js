import { relative } from 'node:path';
import { listDocs, readDoc } from '../../../../../src/hub.mjs';
import { saveNote } from '../../../../../src/memory.mjs';
import { paths } from '../../../../../src/workspace.mjs';

export async function GET(req, { params }) {
  try {
    const { ws } = await params;
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
