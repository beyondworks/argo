// 페이지 ⋯ 메뉴 '할 일로 만들기'(유건 10/4, 오피스 14차 트랙 T) — 페이지 제목과 본문 앞부분을 채운 새 할 일 창을 지금 화면 위에 연다.
// 메뉴는 첫 화면 묶음(core/commands.js)이라 창 코드는 누를 때만 받는다. 창은 앱 옆의 작은 뿌리에 그려서 어느 화면(페이지·트리 우클릭)에서 눌러도
// 화면을 옮기지 않고 같은 창이 뜬다. 만든 할 일에는 출처(source: 페이지 id)가 남아 할 일 패널에서 그 페이지로 돌아갈 수 있다.
import { createRoot } from 'react-dom/client';
import { getState } from '../core/store.js';
import { loadPageContent } from '../core/pull.js';
import { NewTask } from './NewTask.jsx';
import { usePeople } from './data.js';
import { pageExcerpt } from './task-text.js';

function Host({ space, init, onClose }) {
  const people = usePeople(space);
  return <NewTask space={space} people={people} init={init} onClose={onClose} />;
}

let root = null;
export async function openTaskFromPage(page) {
  if (page.content === undefined) await loadPageContent(page.id).catch(() => {}); // 본문을 아직 안 받은 페이지(트리 우클릭) — 못 받으면 제목만 채운다
  const cur = getState().pages.find((p) => p.id === page.id) ?? page;
  const space = page.space === 'shared' ? 'me' : page.space; // 공유받은 남의 페이지 → 내 할 일로
  if (!root) { const el = document.createElement('div'); document.body.append(el); root = createRoot(el); }
  const init = { title: String(cur.title ?? '').trim().slice(0, 200), note: pageExcerpt(cur.title, cur.content), source: { kind: 'page', page_id: page.id } };
  root.render(<Host key={`${page.id}:${Date.now()}`} space={space} init={init} onClose={() => root.render(null)} />);
}
