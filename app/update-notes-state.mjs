import { cmpVersion } from '../src/version-compare.mjs';

export const UPDATE_NOTES_STORAGE_KEY = 'argo-update-notes-version';
export const UPDATE_NOTES = Object.freeze({
  '0.1.89': Object.freeze(['updates.note.models', 'updates.note.effort', 'updates.note.background', 'updates.note.workflow']),
  '0.1.90': Object.freeze(['updates.note.steer', 'updates.note.firstSend']),
  '0.1.91': Object.freeze(['updates.note.sonnet55', 'updates.note.msgrMarker']),
  '0.1.92': Object.freeze(['updates.note.personalCrews', 'updates.note.crewCalendar', 'updates.note.msgrAutoConnect']),
  '0.1.93': Object.freeze(['updates.note.cliBundled', 'updates.note.delegationSwitch', 'updates.note.splash']),
  '0.1.94': Object.freeze(['updates.note.sessionMsg', 'updates.note.inboundCard', 'updates.note.fullAutoScope', 'updates.note.autoAttach', 'updates.note.shipSplash']),
  '0.1.95': Object.freeze(['updates.note.updateWhere', 'updates.note.oneRoomAlerts', 'updates.note.channelRecall', 'updates.note.officeTools', 'updates.note.syncCopies']),
  // 근거 커밋 — agentRename: 322616be(T1)·fdc51cde(T5 이름 호칭) / companyRestore: f3610ff1(F14)·f1f41f80(UM3)·396b1bbd
  // longChat: f0e792b1(B2 네이티브 요약 압축)·c6e8dc6d(B3' CLI·이어받기 예산+누적 요약, 안내 줄) / phoneScreen: 26382ba3(UM1)·eea43dfb(M1)·4ea447ca(UL9)·396b1bbd·e004baa7
  // errorText: 4b642752(F11)·191046c8(UL6)·f9561ac8(UL5)·ad43f7db(M3)·8796a8dd(F3) / msgrCard: d6ce9ab3(CX-12·CX-13)
  '0.1.96': Object.freeze(['updates.note.agentRename', 'updates.note.companyRestore', 'updates.note.longChat',
    'updates.note.phoneScreen', 'updates.note.errorText', 'updates.note.msgrCard']),
  // 근거 PR — cliStandalone: #843(맥·윈도우 단독 설치·argo uninstall)·#845(--version) / msgrCommands: #837 / officeBriefing: #838
  '0.1.97': Object.freeze(['updates.note.cliStandalone', 'updates.note.msgrCommands', 'updates.note.officeBriefing']),
});

export function stableVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

export function updateNotesFor(current, bundleVersion) {
  if (!stableVersion(current) || !stableVersion(bundleVersion) || current !== bundleVersion) return [];
  return Object.hasOwn(UPDATE_NOTES, current) ? UPDATE_NOTES[current] : [];
}

/** 이번 실행에 안내를 꺼낼지(접힌 칩으로 시작). 입력 중(editing)은 조건이 아니다 — 칩은 상단바 안에 있어 아무것도 덮지 않는다.
    대화 화면은 열자마자 입력창에 포커스를 주므로, 입력 중에 미루면 업데이트 뒤 대화 화면으로 다시 열린 앱에서 칩이 입력창을
    떠날 때까지 안 나왔다(0.1.96 rc 실측). 덮을 수 있는 알약·펼친 카드는 updateNotesView가 입력 중에 미룬다. */
export function shouldShowUpdateNotes({ current, bundleVersion, ready, loaded, ackVersion = null,
  dismissed = false, blocked = false, hidden = false, overlay = false }) {
  return !!(ready && loaded && !dismissed && !blocked && !hidden && !overlay
    && updateNotesFor(current, bundleVersion).length
    && (!stableVersion(ackVersion) || cmpVersion(current, ackVersion) > 0));
}

/** 꺼낸 안내를 지금 어떤 모양으로 그릴지 — 'chip'(상단바 자리 있음, 접힘) · 'pill'(자리 없음, 접힘) · 'card'(펼침·오류) · null.
    칩만 입력 중에도 보인다. 알약·카드는 떠 있어 입력창·보내기 버튼을 덮을 수 있어 입력·오버레이·숨김 중에는 그리지 않는다. */
export function updateNotesView({ hasChipHost = false, expanded = false, errorOnly = false, error = '',
  hidden = false, editing = false, overlay = false } = {}) {
  const collapsed = !expanded && !errorOnly && !error;
  if (collapsed && hasChipHost) return 'chip';
  if (hidden || editing || overlay) return null;
  return collapsed ? 'pill' : 'card';
}

/** 이번 업데이트 안내(칩)를 띄우지 않는 때 — 회사 정보를 아직 못 받았거나(받는 중·없음·불러오기 실패), 작업 독·피드백·팀 이름 입력창이 열려 있거나,
    앱 업데이트 확인·설치 중일 때. 실행 중인 턴은 조건이 아니다(UM1): 칩은 아무것도 덮지 않는 상단바 안의 작은 알약인데 턴마다 사라졌다 생기면
    그때마다 상단바 폭이 바뀌어 다른 칩과 검색칸이 흔들렸다. */
export function updateNotesBlocked({ data, tasks, dockOpen, fbOpen, renameTeam, updPhase }) {
  return !data || !!data.missing || !!data.loadError || !tasks || !!dockOpen || !!fbOpen || renameTeam != null || ['checking', 'installing', 'ready'].includes(updPhase);
}

/** 안내 카드가 떠 있는 동안 사용자가 입력을 시작하면 이번 실행에서는 접는다 — 숨겼다가 입력을 마치고(blur) 다시
    그리면 보내기 버튼으로 가는 클릭 사이에 카드가 끼어들어 클릭을 먹었다(UX-A01, 2026-10-05). 저장 중에는 접지 않는다. */
export function shouldAutoDismissUpdateNotes({ visible = false, editing = false, saving = false } = {}) {
  return !!(visible && editing && !saving);
}

/** 펼친 카드 자리 — 회사 화면은 본문 맨 위에 자리(layout.jsx #argo-update-notes-slot)가 있어 카드를 그 안에 흐름대로 놓는다.
    아래 내용을 밀어낼 뿐 어떤 버튼도 덮지 않는다(T6 발견 2026-10-05: 상단바 아래 떠 있던 카드가 데크 '설정에서 연결하기'를 덮었다).
    자리가 없는 화면에서만 떠 있는 카드로 남는다. */
export const UPDATE_NOTES_SLOT_ID = 'argo-update-notes-slot';
export const UPDATE_NOTES_INLINE_STYLE = Object.freeze({
  width: '100%', margin: '0 0 16px', scrollMarginTop: 72, display: 'flex', flexDirection: 'column', overflowWrap: 'anywhere',
  background: 'var(--card)', color: 'var(--fg)',
});
export function updateNotesCardPlacement(slot) {
  return slot ? { inline: true, host: slot } : { inline: false, host: null };
}

/** 입력창을 떠난 뒤 카드를 그리기까지 기다리는 시간 — 입력창 → 버튼으로 포커스가 옮겨지는 그 클릭 도중에 카드가 생기지 않게. */
export const UPDATE_NOTES_BLUR_SETTLE_MS = 1500;

export function isEditingElement(element) {
  return !!element && (/^(INPUT|TEXTAREA)$/i.test(element.tagName ?? '')
    || element.isContentEditable === true);
}

async function nativeInvoke(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

// Native errors must reach the UI, never fall back to a different browser-origin marker.
export async function readUpdateNotesVersion({ isApp, invoke = nativeInvoke, storage } = {}) {
  const value = isApp ? await invoke('read_update_notes_version')
    : (storage ?? globalThis.localStorage).getItem(UPDATE_NOTES_STORAGE_KEY);
  if (isApp && value !== null && !stableVersion(value)) throw new Error('Invalid native acknowledgement');
  return stableVersion(value) ? value : null;
}

export async function acknowledgeUpdateNotesVersion(version, { isApp, invoke = nativeInvoke, storage } = {}) {
  if (!stableVersion(version) || !Object.hasOwn(UPDATE_NOTES, version)) throw new Error('No update notes for this version');
  if (isApp) {
    const saved = await invoke('acknowledge_update_notes_version', { version });
    if (!stableVersion(saved) || cmpVersion(saved, version) < 0) throw new Error('Native acknowledgement was not saved');
  }
  else {
    const target = storage ?? globalThis.localStorage;
    const previous = target.getItem(UPDATE_NOTES_STORAGE_KEY);
    if (!stableVersion(previous) || cmpVersion(version, previous) > 0) target.setItem(UPDATE_NOTES_STORAGE_KEY, version);
  }
}

/** 닫기(×) — 같은 버전에서는 다시 띄우지 않도록 확인 기록을 남긴다(UX-A01: 닫아도 다음 실행에 또 떴다).
    기록이 실패하면 false — 호출부는 이번 실행에서만 접는다(실패를 확인 성공으로 꾸미지 않는다). */
export async function closeUpdateNotes(version, { ack = acknowledgeUpdateNotesVersion, ...options } = {}) {
  try { await ack(version, options); return true; } catch { return false; }
}
