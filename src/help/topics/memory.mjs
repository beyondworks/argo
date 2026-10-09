// 도움말 — 기억(볼트): 노트·일지·대화·산출물, 노트 작성과 저장 즉시 자동 링크, 기억 그래프와 [[링크]], 백링크, 매일 새벽 정리, 편집 충돌
export default {
  id: 'memory',
  ko: {
    title: '기억 — 노트·일지·기억 그래프',
    keywords: ['기억', '볼트', '노트', '주제 노트', '일지', '산출물', '기억 그래프', '링크', '백링크', '기억 정리', '편집 충돌', '노트 작성'],
    body: `기억은 회사가 쌓아 온 기록이 폴더 단위로 모이는 곳입니다. 에이전트는 일할 때 이 기억을 읽고, 결과를 다시 기억에 남깁니다. 사이드바 "기억"에서 엽니다.

**폴더**
- 노트: 주제별로 정리된 지식 노트(주제 노트). 직접 쓰거나 매일 정리에서 만들어집니다.
- 일지: 에이전트가 일한 기록이 날짜별로 쌓입니다. 회의록도 여기에 남습니다.
- 대화: 대화 기록입니다.
- 산출물: 에이전트가 만든 파일입니다. 문서가 아닌 파일은 크기와 내려받기 링크로 보입니다.

**보기**
- 왼쪽 탐색기에서 문서를 누르면 오른쪽 창에 탭으로 열립니다. ⌘(또는 Alt)를 누른 채 클릭하면 옆 창에 열립니다(창은 최대 2개).
- 문서 위 단추로 이 문서 중심의 "연결 그래프"를 보거나 MD·PDF·DOCX·XLSX·CSV로 내려받습니다.
- 본문의 \`[[링크]]\`를 누르면 그 문서가 열리고, 아래 "이 문서를 참조하는 기억 n건"에 백링크가 모입니다.
- 위쪽 검색칸이나 탐색기의 검색으로 제목·내용을 찾습니다.

**노트 작성**
- 탐색기 툴바의 "노트 작성"을 누르고 제목과 본문을 적어 "기억에 저장"합니다.
- "저장 즉시 자동 링크": 저장하면 내용이 비슷한 주제 노트를 찾아 서로 \`[[링크]]\`로 잇습니다(최대 3개).
- 저장한 내용은 에이전트가 바로 참고합니다.
- 편집·삭제는 노트 폴더의 주제 노트만 됩니다. 일지·대화·산출물은 읽기 전용입니다. 삭제는 노트 제목과 "삭제하겠습니다"를 입력해야 하며, 파일은 휴지통으로 옮겨집니다.
- 편집하는 사이 에이전트나 다른 기기가 같은 문서를 바꿨다면 경고가 뜹니다. "새로 불러오기(내 편집 버리기)" 또는 "내 것으로 덮기"를 고릅니다.

**기억 그래프**
- 탐색기의 "기억 그래프"(또는 데크의 "크게 보기")에서 회사·팀·에이전트·기억을 점으로, \`[[링크]]\`를 선으로 봅니다.
- 끌어서 이동, 휠로 확대, 더블클릭하면 주변만 봅니다. "에이전트 연결"과 "연결 없는 기억" 표시를 켜고 끌 수 있습니다.
- 아무 연결이 없으면 "아직 빈 하늘입니다"가 보입니다. 기억을 \`[[링크]]\`로 이으면 그려집니다.

**매일 새벽 정리**
- 매일 새벽 4시(그 시각에 꺼져 있었다면 다음에 켜졌을 때) 새로 쌓인 일지를 읽어 주제 노트를 만들거나 고칩니다. 연결된 러너로 실행됩니다.
- 탐색기의 번개 단추 "기억 정리"로 지금 바로 실행할 수 있습니다. 결과는 "주제 노트 n건 갱신" 또는 "정리할 새 일지가 없습니다"로 나옵니다.
- 원래 일지는 지우지 않습니다. 정리가 끝난 7일 지난 일지는 주간 요약으로 묶이고 원본은 보관됩니다.

에이전트 카드의 "방식" 탭에 있는 "회사가 아는 사용자 — 기억 카드"도 기억의 일부입니다. 옵시디언 볼트는 설정 → 기기·데이터 → 옵시디언에서 가져오기로 들여옵니다.`,
  },
  en: {
    title: 'Memory — notes, journal and memory graph',
    keywords: ['memory', 'vault', 'notes', 'topic note', 'journal', 'outputs', 'memory graph', 'links', 'backlinks', 'organize memory', 'edit conflict', 'write a note'],
    body: `Memory is where the company's records collect, organized by folder. Agents read it while they work and write results back into it. Open it from "Memory" in the sidebar.

**Folders**
- Notes: knowledge notes organized by topic (topic notes), written by you or produced by the daily organizing.
- Journal: agents' work records, by date. Meeting minutes land here too.
- Conversations: chat records.
- Outputs: files agents produced. Non-document files show their size and a download link.

**Viewing**
- Click a document in the explorer on the left to open it as a tab on the right. ⌘-click (or Alt-click) opens it in the other pane (up to 2 panes).
- Buttons above a document show a "Local graph" around it, or download it as MD, PDF, DOCX, XLSX or CSV.
- Click a \`[[link]]\` in the text to open that document; "{n} memories link here" at the bottom lists backlinks.
- Use the search box at the top or the explorer search to find titles and content.

**Writing a note**
- Click "Write a note" in the explorer toolbar, enter a title and body, and press "Save to memory".
- "Auto-links on save": saving finds similar topic notes and links them both ways with \`[[links]]\` (up to 3).
- Agents can use what you saved right away.
- Only topic notes in the Notes folder can be edited or deleted; journal, conversations and outputs are read only. Deleting requires typing the note title and "delete this", and the file goes to the trash.
- If an agent or another device changed the same document while you were editing, a warning appears. Choose "Reload latest (discard my edits)" or "Overwrite with mine".

**Memory graph**
- "Memory Graph" in the explorer (or "View larger" on the Deck) shows the company, teams, agents and memories as dots and \`[[links]]\` as lines.
- Drag to pan, scroll to zoom, double-click for a local view. Toggle "Agent links" and unlinked memories.
- With no links at all you see "An empty sky, for now"; linking memories with \`[[links]]\` draws it.

**Daily organizing at dawn**
- Every day at 4 a.m. (or the next time the device is on, if it was off then), new journal entries are read and topic notes are created or updated, using a connected runner.
- The lightning button "Organize memory" in the explorer runs it now. The result reads "{n} topic notes updated" or "No new journal entries to organize".
- Journal entries are never deleted. Organized entries older than 7 days are folded into a weekly summary and the originals are archived.

"What the company knows about you" in the agent card's "Working style" tab is part of memory too. Bring in an Obsidian vault with Settings → Devices & data → Import from Obsidian.`,
  },
};
