// 공유 링크 사전(15차) — 공개 화면(/f#<토큰>)과 파일 상세의 '공유 링크' 칸. 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한).
export const LINK_DICT = {
  'link.title': ['공유받은 파일', 'Shared file'], 'link.from': ['{org}에서 보낸 파일입니다', 'Shared by {org}'],
  'link.download': ['내려받기', 'Download'], 'link.preparing': ['준비하는 중…', 'Preparing…'],
  'link.until': ['{date}까지 받을 수 있습니다', 'Available until {date}'], 'link.loading': ['불러오는 중…', 'Loading…'],
  'link.noLogin': ['로그인하지 않아도 받을 수 있습니다.', 'No sign-in needed.'],
  'link.gone.title': ['열 수 없는 링크입니다', 'This link can’t be opened'],
  'link.gone.body': ['기간이 지났거나, 보낸 사람이 링크를 끊었거나, 파일이 지워졌습니다. 보낸 사람에게 새 링크를 요청해 주세요.', 'It may have expired, been turned off by the sender, or the file was deleted. Ask the sender for a new link.'],
  'link.err': ['지금은 받을 수 없습니다. 잠시 뒤 다시 눌러 주세요.', 'Can’t download right now. Please try again shortly.'], 'link.retry': ['다시 시도', 'Try again'],
  'link.madeWith': ['Argo Office로 보냄', 'Sent with Argo Office'],
  // 파일 상세의 공유 링크 칸
  'link.head': ['공유 링크', 'Share links'],
  'link.help': ['링크를 받은 사람은 로그인 없이 이 파일만 내려받습니다. {days}일 뒤 저절로 닫힙니다.', 'Anyone with the link can download just this file, no sign-in. It closes by itself after {days} days.'],
  'link.make': ['링크 만들기', 'Create link'], 'link.made': ['링크를 만들었습니다 — 지금 복사해 두세요', 'Link created — copy it now'],
  'link.copy': ['복사', 'Copy'], 'link.copied': ['링크를 복사했습니다', 'Link copied'],
  'link.once': ['링크 주소는 지금 한 번만 보입니다. 잃어버리면 새로 만드세요.', 'The address is shown only now. If you lose it, create a new one.'],
  'link.none': ['열려 있는 링크가 없습니다.', 'No open links.'],
  'link.loadFailed': ['공유 링크를 불러오지 못했습니다.', 'Couldn’t load share links.'],
  'link.row': ['{made} 만듦 · {left}일 남음', 'Made {made} · {left} days left'], 'link.fromMail': ['메일', 'Mail'],
  'link.cutAsk': ['이 링크를 끊을까요?', 'Turn off this link?'], 'link.cutBody': ['이미 링크를 받은 사람도 더는 열 수 없습니다. 다시 보내려면 새 링크를 만들어 전해야 합니다.', 'People who already have the link can no longer open it. To share again, create a new link and send it.'],
  'link.cut': ['링크 끊기', 'Turn off link'], 'link.cutDone': ['링크를 끊었습니다. 이제 그 링크로는 열 수 없습니다.', 'Link turned off. It can no longer be opened.'],
  'link.noRight': ['링크는 파일을 올린 사람이나 관리자만 만들고 끊을 수 있습니다.', 'Only the uploader or an admin can create or turn off links.'],
};
