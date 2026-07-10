import { listDocs, readDoc } from '../../../../../src/hub.mjs';

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
