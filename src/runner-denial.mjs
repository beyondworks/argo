// 외부 CLI 러너(codex·gemini)의 샌드박스 거부를 Argo의 능력 계층으로 승격한다.
//
// 왜 필요한가 — SDK(Claude Code) 러너는 permission-gate가 도구 호출을 가로채 "켤까요?" 카드를
// 띄운다. 외부 CLI는 그 자리가 없다: 거부가 프로세스 안에서 일어나 `zsh:1: operation not
// permitted: /path` 같은 생 셸 에러로만 흘러나온다. 사장은 카드도 못 보고 안내도 못 받은 채
// "권한을 다 켜놨는데도 쓰기가 차단된다"로 읽는다(실사용 신고 2026-07-26, 재현 확인).
//
// 여기서 그 문자열을 인식해 (a) 능력이 꺼져 있으면 SDK와 같은 카드를 띄우고,
// (b) 이미 켜져 있으면 남은 원인(홈 밖 경로 · macOS 파일 접근 권한)을 짚어준다.
// 러너가 달라도 사장이 보는 것은 같아야 한다 — 그게 이 파일의 목적이다.

/** 파일 쓰기 거부 — macOS seatbelt·리눅스 landlock·Node fs 오류의 공통 표면.
    캡처 그룹 1 = 대상 경로(있으면). 없으면 경로 없이 능력만 안내한다. */
const FS_DENIAL = [
  /operation not permitted:\s*(\S+)/i, // zsh + macOS seatbelt (codex workspace-write의 실제 출력)
  /\b(?:EPERM|EACCES)\b[^\n]*?['"`]?((?:\/|~\/)[^\s'"`,)]+)/,
  /permission denied[^\n]*?['"`]?((?:\/|~\/)[^\s'"`,)]+)/i,
  /read-only file system[^\n]*?['"`]?((?:\/|~\/)[^\s'"`,)]+)/i,
  /((?:\/|~\/)[^\s'"`,:]+)[^\n]*?read-only file system/i, // cp류는 경로가 문구 앞에 온다

  /sandbox[^\n]*?(?:denied|blocked)[^\n]*?['"`]?((?:\/|~\/)[^\s'"`,)]+)/i,
];

/** 네트워크 거부 — codex는 browser 능력이 꺼지면 network_access=false라 DNS부터 막힌다.
    (오프라인이어도 같은 문자열이 나오지만, browser가 꺼진 상태라면 원인 안내로 능력을 먼저 짚는 게 맞다.) */
const NET_DENIAL = [
  /could not resolve host/i,
  /(?:name or service|nodename nor servname) not known/i,
  /nodename nor servname provided/i,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
  /sandbox[^\n]*network[^\n]*(?:denied|blocked|disabled)/i,
];

/** 러너 출력에서 능력 거부를 찾는다(순수) — { cap, path } 또는 null.
    fs를 먼저 본다: 네트워크 문구는 크루가 설명하며 인용하는 경우가 있어 오탐이 더 쉽다. */
export function detectRunnerDenial(text) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const re of FS_DENIAL) {
    const m = s.match(re);
    if (m) return { cap: 'fs', path: m[1] ?? '' };
  }
  for (const re of NET_DENIAL) {
    if (re.test(s)) return { cap: 'browser', path: '' };
  }
  return null;
}

/** 거부 안내문(순수) — 능력이 꺼져 있으면 "켤까요? 카드", 켜져 있으면 남은 원인 두 가지.
    capOn=true인데도 막혔다는 건 Argo 토글 밖의 벽이라는 뜻이다 — 그 경우만 macOS 권한을 짚는다
    (항상 붙이면 정작 토글이 원인일 때 사장을 엉뚱한 설정으로 보낸다). */
export function denialNote({ cap, path = '', capOn, lang = 'ko', outsideHome = false }) {
  const en = lang === 'en';
  const where = path ? (en ? ` (target: ${path})` : ` (대상: ${path})`) : '';

  if (!capOn) {
    return cap === 'browser'
      ? (en
          ? `\n\n---\n⚠ This runner was blocked from reaching the network because **Web browsing** is off. I've put a "turn it on?" card in your chat — approve it and I'll continue from where I stopped.`
          : `\n\n---\n⚠ **웹 브라우징** 능력이 꺼져 있어 이 러너가 네트워크에서 막혔습니다. 대화창에 "켤까요?" 카드를 띄웠습니다 — 승인하시면 멈춘 자리에서 이어서 하겠습니다.`)
      : (en
          ? `\n\n---\n⚠ This runner was blocked from writing outside the company folder because **File system** is off${where}. I've put a "turn it on?" card in your chat — approve it and I'll continue from where I stopped.`
          : `\n\n---\n⚠ **파일 시스템** 능력이 꺼져 있어 회사 폴더 밖 쓰기가 막혔습니다${where}. 대화창에 "켤까요?" 카드를 띄웠습니다 — 승인하시면 멈춘 자리에서 이어서 하겠습니다.`);
  }

  // 능력은 켜져 있는데 막혔다 — Argo 밖의 벽이다. 사장이 "다 켰는데 왜 안 되냐"고 묻는 자리.
  if (cap === 'browser') {
    return en
      ? `\n\n---\n⚠ **Web browsing is already on**, so this looks like an actual network problem (offline, VPN, or a firewall), not an Argo setting.`
      : `\n\n---\n⚠ **웹 브라우징 능력은 이미 켜져 있습니다.** 그러니 이건 Argo 설정이 아니라 실제 네트워크 문제(오프라인·VPN·방화벽)로 보입니다.`;
  }
  const outside = outsideHome
    ? (en
        ? `The target is outside your home folder, which this runner can never write to — move it under your home folder (Documents, Desktop, …) and I'll retry.`
        : `대상이 홈 폴더 밖입니다 — 이 러너는 홈 밖에는 쓸 수 없습니다. 홈 폴더 안(문서·데스크탑 등)으로 옮겨 주시면 다시 시도하겠습니다.`)
    : (en
        ? `The path is inside your home folder, so the block is coming from the operating system, not Argo: **System Settings → Privacy & Security → Files and Folders** (or Full Disk Access) — allow Argo there, then restart the app. On Windows, check that the folder isn't read-only or controlled by folder-access protection.`
        : `경로가 홈 폴더 안인데도 막혔다면 Argo가 아니라 운영체제가 막고 있는 것입니다: **시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더**(또는 전체 디스크 접근 권한)에서 Argo를 허용한 뒤 앱을 다시 켜주세요. 윈도우라면 해당 폴더가 읽기 전용인지, 제어된 폴더 액세스가 걸려 있는지 확인해 주세요.`);
  return en
    ? `\n\n---\n⚠ **File system is already on**${where}, but the write was still blocked. ${outside}`
    : `\n\n---\n⚠ **파일 시스템 능력은 이미 켜져 있는데도** 쓰기가 막혔습니다${where}. ${outside}`;
}
