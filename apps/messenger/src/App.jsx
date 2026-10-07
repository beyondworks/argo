// Argo 메신저 — 조직·채널·메시지·크루·결재 슬립. 데이터는 Supabase 직결(RLS가 경계), 실시간은 private topic org:<id> 방송.
// 룩 = linen v2(apps/messenger/design): 타임라인 척추 · 사람 원/크루 타일 · 2단 다크 독 · 결재 슬립 · 자체 아이콘(icons.jsx).
// Argo 부품은 .shell/.side(테마 토큰 스코프)·.btn·Markdown·imeGuardWith만 쓰고, 나머지는 styles.css의 .msgr-*.
// 1차 범위(MESSENGER-DESIGN.md P1): 로그인 · 조직/초대 · 공개/비공개 채널 · 메시지 · @멘션 · 첨부 · 결재 · 크루 부재중 · 타이핑.
import { Component, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { acceptTyping, typingKey, withoutKey, typingIn as typingInState, roomTopicIds, TYPING_WINDOW_MS, createCrewPostsMemory } from './typing-state.js';
import { awaitingReplies, noteSeen } from './await-reply.mjs';
import { dismissHandlers } from './dismiss.mjs';
import { attachKeyboardDismiss } from './kb-dismiss.mjs';
import { turnCopyText, tailTurns } from './turn-copy.mjs';
import { hasPublicChannel, newChannelKind, stepMarks, newChannelOffer } from './onboard.mjs';
import { Graph3D } from './graph3d.jsx';
import { WorkPanel, missingSchema } from './work-panel.jsx';
import * as Panes from './panes.mjs'; import { GRAPH_TAB, MAX_PANES } from './panes.mjs'; // 창·탭 전이(순수) // 활동 그래프 3D(옵시디언식 구·궤도 회전) — 구성은 @argo/graph2d-core 재사용
import { supabase, configured, q } from './supabase.js';
import { customServer, SB_URL, SB_ANON } from './supabase.js';
import { readProfile, writeProfile, clearProfile, normalizeUrl, hostOf } from './server-profile.mjs';
import { handoff, fetchProviderSettings, providerShown, noProviders, providerErrorKey } from './oauth-handoff.mjs';
import { parseInviteCode, inviteShareText, inviteLink, friendShareText, checkJoinInput, canSubmitJoin } from './invite.mjs';
import { inviteListSync } from './invite-list-sync.mjs';
import { findReusableBot, canReconnect, botDefaultNames } from './bot-reuse.mjs';
import { NODE_ENV_PREFIX } from './node-cmd.mjs';
import { splitInlineCode } from './inline-code.mjs';
import { crewAvailability } from './crew-status.mjs';
import { aiConsentCopy } from './consent-copy.mjs';
import { createInvite, previewInvite, acceptInvite, revokeInvite, discardInvite, inviteStatus, daysLeft, inviteErrorKey, missingFn, currentLink, shownInvites, chipPreview } from './invite-flow.mjs';
import { InviteDialog, InvitePreview } from './invite-dialog.jsx';
import { sortDms, DM_SORTS, sortByCustomOrder } from './dm-sort.mjs';
import { pickStartSpace, needsPersonalProbe } from './start-space.mjs';
import { addableToChannel, kickExcludes, hasChannelRows, searchChannelsByName } from './channel-browse.mjs';
import { resolvePeopleNames, nameForUser, needsNameLookup } from './person-names.mjs';
import { activitySentence } from './activity-sentence.mjs';
import { dmEmptyKey, roomTabEmptyKey } from './empty-state.mjs';
import { railRooms } from './rail-rooms.mjs'; // 넓은 화면 레일의 '즐겨찾기'·'채팅' 두 절 — 즐겨찾기한 방이 어느 절에도 없게 되지 않게(2026-10-08)
import { nodeIndicator } from './node-indicator.mjs';
import { duplicateNameHints } from './crew-hints.mjs';
import { pendingCrewLabel } from './crew-label.mjs';
import { UpdateBar } from './update.jsx';
import { MobileUpdateBar } from './mobile-update.jsx';
import { useLongPress, longPressHandlers } from './long-press.js';
import { groupFlags } from './msg-group.mjs';
import { t as tm } from './i18n.js';
import { plainField, approvalPlainFields, orgDocTitle, approvalOneLineSummary, approvalGrade, approvalSummaryKey, approvalPageItems, approvalDecider, phoneApprovalDecider, decidableApprovals, approvalOnlyKey, approvalDenied, approvalCmdMode, decideApproval, readRoomJoinRequests, singleFlight } from './approval-display.js';
import { agentRowState, AGENT_FILTERS, AGENT_FAV_KEY, groupAgents, rowForSpace, agentRoomTarget, agentStateRow, personalRoomFor, personalRoomKnown, agentDmRedirect, agentDmRoute, earlierAgentDms, earlierLines, earlierLineLabel, archivedRoomFor, archivedReadStep, clearEarlierUnread, saveAgentLook, fillAgentLooks, ownRowsReader, loadUntilListed, spaceMoveNotice, spaceMoveBack, MOVE_NOTICE_MS, agentSections, groupIsFav, favChanges, readAgentFav } from './agent-groups.mjs'; // 폰 에이전트 탭 — 같은 에이전트 한 줄·상단 메뉴·즐겨찾기(유건 2026-10-02), 1:1은 개인 방 하나(2026-10-03)
import { toggleId, foldAll, allFolded } from './collapse-set.mjs';
import { useLang } from '@argo/i18n';
import { useTheme, THEMES } from '@argo/theme';
import { Markdown, imeGuardWith, ConfirmModal, DangerModal } from '@argo/ui';
import { EMOJI_GROUPS, bumpEmoji, topEmoji, searchEmoji } from './emoji.js';
import { Sprite, I, STAR_D } from './icons.jsx';
import { version as APP_VERSION } from '../package.json'; // 설정에 보이는 앱 버전(UXM-26) — 발행 때 tauri 설정과 같이 올린다
import { inTauri, isMobilePlatform, isMobileNative, isDesktopTauri, isIos, isAndroid } from './platform.js';
import { createIconBadge, unreadSignature } from './app-badge.mjs'; // 폰 아이콘 숫자 = 서버 배지(msgr_my_badge)
import { getMobileAuthSnapshot, subscribeMobileAuth, startMobileSignIn, cancelMobileSignIn, mountMobileAuth } from './mobile-auth-runtime.js';
import { useMobileViewport } from './mobile-viewport.js';
import { useIsPhone, useEdgeSwipeBack } from './use-phone.js';
import { bindRowSwipe, bindSwipeReply } from './row-swipe.js';
import { PHONE_TABS, isPhoneRoot, spaceForTab, pickChannelOrg, startTab, tabBadges, badgeText, roomTraits, chatVisible, chatUnreadTotal, roomRow, sortRooms, tabSearch, CHAT_FILTERS, memoryGroups, memSnippet, agentCardAction, orgCardStep, personalCardLocks, orgMenuItems, savedOrgAfter, withoutHidden, hiddenGroups, settingsOrgRows, orgScreen, joinReqKey, maskedPreview, tabBodyQuery, emptyPersonalDm, personalDmWith } from './phone-shell.mjs'; // 폰 셸 v2(친구·채팅·채널·에이전트·기억, 유건 확정 2026-10-01) — 판단은 이 모듈 한 곳
import { canDeleteRoom } from './room-delete.mjs';
import { canReportMessage } from './report-target.mjs';
import { bindPullRefresh, enteredReady } from './pull-refresh.mjs';
import { haptic } from './haptics.js';
import { refreshMessageWindow, mergeRefreshedMessages, readMissed, createCatchUp } from './refresh-messages.mjs';
import { createLinkWatch, orgSubscriptionKey, roomSignal } from './realtime-link.mjs';
import { createReadCursor, unreadWorthy, createCoalescer } from './read-sync.mjs'; // 읽음 커서 다시 쓰기·안 읽음 숫자 묶음(MSG-05·08) // 끊김 → 다시 붙음 짝(rt_down·rt_up)·목록 다시 읽기 판정
import { writeScreenSnapshot, consumeScreenSnapshot } from './phone-screen-snapshot.mjs';
import { mentionCandidates, mentionsFromBody, ambiguousMentions, ALL_RE, outsideCrewMentions, canInstructCrew, crewOrder, withoutCopies, outsideAddDone, outsideRowView } from './mention-candidates.mjs';
import { OutsideRow } from './outside-row.mjs';
import { dmMentionCrews, mentionPopupCrews, setDmRecipient, dmDeliveryMentions, dmUnavailableRecipients, relayCaptionKey, relayToLabel, relayToNames, relayNoticeView } from './dm-delivery.mjs';
import { acceptFiles, withoutFile } from './attach-files.mjs';
import { MediaAttachments, LinkCard, linkify, onLinkClick } from './media.jsx'; // 첨부 말풍선·크게 보기·링크 카드(2026-10-02)
import { slashCandidates, slashInsert, rolePickCandidates, ROLE_PICK_RE } from './slash-commands.mjs';
import { getComposerSession, bindComposerSession, clearComposerSessions, composerTransport, setDeliveryReporter } from './composer-delivery.mjs';
import { fetchSearchRows } from './search-rows.mjs';
import { memberRows, memberPerms, MEMBER_CHIPS } from './phone-members.mjs';
import { Seg } from './seg.mjs'; // 세그먼트 토글 하나(5차 피드백 3)
import { searchView } from './search-view.mjs';
import { deliveryCardView } from './delivery-card.mjs';
import { friendlyErr, toastError } from './error-toast.mjs'; // 아는 서버 코드 → 문구, 토스트는 원문을 거른다(UXM-05)
import { messageShape } from './attach-only.mjs';
import { appBackStack, rootBackAction } from './back-stack.mjs'; import { useBackClose } from './use-back-close.js'; // Android 뒤로 — 열린 시트·팝업부터 닫기(MSG-10) // 첨부만 보낸 글 — 올리는 중 자리표시·거둔 글 숨김(MSG-06)
import { watchOnline } from './connection.mjs';
import { selfMember, personalSelfName } from './self-member.mjs';
import { crewRowMenuKeys, crewOpeners, creatorTagVisible } from './crew-row-menu.mjs';
import { crewAwayNotice } from './crew-dm-notice.mjs';
import { crewListEmptyKey } from './crews-empty.mjs';
import { runnerOptions, RUNNER_INSTALL } from './runner-sheet.mjs';
import { seenWithin, stampFetched, markSeen } from './presence-clock.mjs'; // 접속 판정 = 받아 온 때 기준(기능 점검 D2) // '실행기 연결' 시트(아르고 패밀리 구조, 2026-10-02)
import { shortcutLabel } from './shortcut.mjs';
import { koJosa } from './ko-josa.mjs';
import { reconcilePending, messageEvent, broadcastEvent, onForeground } from './instant-delivery.mjs';
import { loadSpaceTotals, readableForNotify, seenOnce, badgeTotal, spaceKey, joinWithBackoff } from './cross-space.mjs'; // 다른 공간의 새 글 — 안 읽음 합계·알림 판단
import { splitAwayNote, plainPreview } from './msg-text.mjs';
import { containsProfanity, readProfanityFilterOn, writeProfanityFilterOn, PROFANITY_FILTER_EVENT } from './profanity-filter.mjs';
import { notifyPermission, requestNotifyPermission, askNotifyOnce, sendNotify, setBadge, clearTray, SOUNDS, getSound, setSound, playChime } from './notify.js';
import { startPresence } from './presence.mjs';
import { observeMobileResume } from './mobile-lifecycle.mjs';
import { registerPush, activatePush, deactivatePush, detachPush, mountPush } from './push.js';
import { pushDiag, readDiag, clearDiag } from './diag.jsx';
setDeliveryReporter((kind, message) => pushDiag(kind, message)); // 전송 실패의 영어 원문은 카드에 보이지 않고 진단 기록(설정 > 진단)으로만 간다(검수 E, 2026-10-01)
import { docSlug, insertWithFreePath, isPathTaken } from './doc-path.mjs';
import { authErrorText } from './auth-errors.mjs';
import { sessionTransition } from './session-notice.mjs';
import { createNativeSessionApplier, mountNativeRealtime, mountNativeNotificationTaps, updateNativeRealtimeContext } from './native-realtime.mjs';
import { createSessionRecovery, waitingView } from './session-recovery.mjs';
import { createNavInbox, decideNav } from './notif-nav.mjs';
import { authCleanupState, authStorageKey, hasStoredAuthSession } from './auth-storage.mjs';
import { createRealtimeScope } from './realtime-scope.mjs';
import { createRequestGate, createPreferenceQueue, reorderFavorites } from './rail-state.mjs';
import { typingSummary, typingLabelParams, shouldGroupTypingBubbles, typingBubbleFaces } from './typing-summary.mjs';
import { unreadOpenScrollTarget, channelOnScreen } from './unread-open-scroll.mjs';
import { fmtDmWhen } from './list-when.mjs';
import { markAppReady } from './splash.js';
import { dropBeforeIdAtY, reorderVisibleInFull } from './drag-reorder.mjs';
import { dmApprovalState, dmNeedsApproval } from './dm-approval.js';
import { twinRelink, twinLeftOrg, twinPaused, twinOrgLabel, crewAddable, crewSeenAt } from './personal-bots.mjs';
import { scrollLeftToCenter } from './nav-scroll.mjs';
import { toastPlace, toastMaxWidth } from './toast-place.mjs';
import { FLASH_MS, flashKey, splitFavs, cleanGroupName, groupNameTaken, sortGroups, channelMenu, resolveMenu, menuChannels, menuTalks, groupOfChannel, linkChange, groupDiff, nextGroupPos, searchMenu, toastMs, createGroupFlow } from './phone-lists.mjs';
import { faceOf, faceFromStored, faceInner, agentLooks, agentLook, agentFace, crewFaceState, nextDoneIn, nextSurpriseIn, nextErrorIn, failedCrewsInFetch, FACE_COLORS, FACE_SHAPES, faceToStore } from './crew-face.mjs';
import { faceGestures } from './face-gestures.mjs';
import { coverScale, clampOffset, cropRect, clampZoom, ZOOM_MAX } from './avatar-crop.mjs';
const realtimeScope = createRealtimeScope();
const LEGAL = { privacy: 'https://argo.ceo/privacy', terms: 'https://argo.ceo/terms', download: 'https://argo.ceo/download', contact: 'mailto:lean8kim@gmail.com' }; // App Store 5.1.1(i): 앱 안에서 닿는 개인정보처리방침·약관. download = 가격·결제 버튼 없는 전용 페이지(총괄 지시 2026-09-26, 랜딩 배포 전이라 지금은 404 — 배포는 총괄이 앱 발행 전에 함). contact = 1.5 지원 이메일 직행(검수 M5 — 결제 링크가 있는 홈 #contact 대신, 라이브 curl로 확인한 실주소)
const openExternal = async (url) => { try { if (inTauri()) await (await import('@tauri-apps/plugin-opener')).openUrl(url); else window.open(url, '_blank', 'noopener'); } catch { /* 브라우저가 막으면 조용히 */ } };
const LegalLinks = ({ t, className = '', agree = false }) => (
  <p className={`msgr-legal ${className}`.trim()}>
    {agree && <span style={{ display: 'block', marginBottom: 4 }}>{t('legal.agree')}</span>}{/* App Store 1.2: 가입 시 약관 동의 + 부적절 콘텐츠·악성 사용자 무관용 고지 */}
    <button type="button" className="linkbtn" onClick={() => openExternal(LEGAL.privacy)}>{t('legal.privacy')}</button>
    <span aria-hidden="true"> · </span>
    <button type="button" className="linkbtn" onClick={() => openExternal(LEGAL.terms)}>{t('legal.terms')}</button>
    <span aria-hidden="true"> · </span>
    <button type="button" className="linkbtn" onClick={() => openExternal(LEGAL.contact)}>{t('legal.contact')}</button>{/* App Store 1.5: 개발자 연락처 */}
  </p>
);
const SignOutContext = createContext({ signOut: () => {}, signingOut: false, accountDeleted: () => {} });

// Installation + signed-in owner scope prevents another PC's identically named agent being rotated.
export const externalAgentId = (installation, owner, kind, id) => {
  if (!installation || !owner || !kind || !id) throw new Error('Agent identity unavailable');
  return `v2:${[installation, owner, kind, id].map(encodeURIComponent).join(':')}`;
};

const AWAY_MS = 90_000;
// 에이전트가 꺼져 있나(상주·봇 하트비트 90초 끊김, 한 번도 안 켜짐 포함) — 주인만 보던 색 점을 모두가 읽는 글자로 드러낸다(D23·D24)
// 1-b(2026-09-29): 외부 에이전트 연결 도구의 최신 버전 — 보고가 없거나(0.3.0 이전) 더 낮으면 "업데이트 필요". 설정은 강제하지 않고 보여 준다.
const ADAPTER_LATEST = { hermes: '0.3.3', openclaw: '0.3.2' }; // 0.3.2 = 파일 보내기, hermes 0.3.3 = 표지만 있는 답 처리(2026-09-30)
const semverLess = (a, b) => { const x = String(a).split('.').map((n) => parseInt(n, 10) || 0), y = String(b).split('.').map((n) => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); } return false; };
const adapterOutdated = (b) => !!ADAPTER_LATEST[b.kind] && (!b.state?.adapter_version || semverLess(b.state.adapter_version, ADAPTER_LATEST[b.kind]));
// 승인 방식: 사람에게 묻는다(ask) / 보조 AI가 판단해 스스로 승인(ai) / 묻지 않고 실행(none) / 모름(unknown). Hermes manual·smart·off, OpenClaw ask·allowlist·deny·auto·full
const approvalLevel = (mode) => ({ manual: 'ask', ask: 'ask', allowlist: 'ask', deny: 'ask', smart: 'ai', auto: 'ai', off: 'none', full: 'none' })[String(mode ?? '').toLowerCase()] ?? 'unknown';
const APPROVAL_FIX = { hermes: 'hermes config set approvals.mode manual', openclaw: 'openclaw config set tools.exec.mode ask' };
const crewAway = (c) => !seenWithin(c, AWAY_MS); // 받아 온 때 기준(presence-clock.mjs)
/** 개인 공간을 뜻하는 orgId 상수. null은 "조직 없음(EmptyOrg)"이므로 센티넬로 구분한다. */
export const PERSONAL = '__personal__';
// 알림 탭·카드·초대에서 온 "이 채널 열기" 요청 — 셸 밖(앱 수준)에 둔다. 셸이 연결 대기 화면 등으로 내려갔다 올라와도 요청이 남고,
// 셸이 실제로 열었거나 일부러 버릴 때만 비운다(notif-nav.mjs, 유건 요청 2026-10-01). shellLink = 앱 수준 리스너가 보는 지금 셸(탭 진단의 page·org, 전경 푸시 카드).
const navInbox = createNavInbox();
const shellLink = { mounted: false, page: null, orgId: null, onForeground: null };
/** 크루 등급(부록 I·K) — 서버 함수 msgr_crew_tier와 같은 규칙: 조직 서비스 계정이 소유하고 상주 노드에서 돌면 회사 크루, 그 외는 개인(파견) 크루. 화면 표시용이며 판정 정본은 서버. */
// 이 채널이 개인 에이전트의 지시를 막는가 — 보기만(read_only)뿐(서버 msgr_instruct_check와 같다). 방장 승인·못 데려옴은 들어오는 방식만 정하고,
// 이미 있는 에이전트는 그대로 일한다(유건 2026-09-16: 못 데려옴으로 바꿔도 퇴장시키지 않는다).
export const limitsPersonal = (channel) => channel?.personal_crews === 'read_only';
export const crewTier = (crew, org) => (org?.service_user_id && crew?.owner_user_id === org.service_user_id && crew?.hosting === 'resident') ? 'company' : 'personal'; // 외부 에이전트(봇)도 개인 등급 — Argo 에이전트처럼 소유자가 초대한 곳에서만(유건 2026-09-24). 서버 msgr_crew_tier와 같은 규칙
const PAGE = 100;
const CATCHUP_PAGES = 5; // 따라잡기 상한 — 이보다 많이 밀렸으면 최신 쪽으로 옮긴다(MSG-02, readMissed)
const ATTACH_MAX = 25 * 1024 * 1024; // 브리지 ATTACH_MAX(src/gateway/msgr.mjs)와 같은 값 — 받는 쪽에서만 거절하면 보낸 사람은 이유를 모른다
const fmtTs = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
// 데스크톱: 마우스를 올린 글이 속한 턴의 마지막 행에 data-turn-hover를 단다 — 턴 끝 아이콘 줄은 이 표시가 있을 때만 보인다(유건 2026-10-02).
// 턴 = notail로 이어진 행들. 말풍선 사이 틈(척추 자체)에 올라가면 표시를 그대로 두어 깜빡이지 않게 하고, 척추를 벗어날 때만 지운다.
const markTurnHover = (e) => {
  const spine = e.currentTarget;
  const row = e.type === 'pointerleave' ? null : e.target.closest?.('.msgr-row, .msgr-mine');
  if (e.type !== 'pointerleave' && !row) return;
  let tail = row;
  while (tail?.classList.contains('notail')) tail = tail.nextElementSibling;
  const cur = spine.querySelector(':scope > [data-turn-hover]');
  if (cur === tail) return;
  cur?.removeAttribute('data-turn-hover');
  if (tail?.matches('.msgr-row, .msgr-mine')) tail.setAttribute('data-turn-hover', '');
};
const dayKey = (iso) => new Date(iso).toDateString();
/** 서버 거절 원문 → 사람 문구(검수 M-5: RLS·check 제약 원문이 그대로 뜨던 자리들의 공통 매핑). 모르는 오류는 원문 유지(정직). */
// 에이전트 넣기(msgr_crew_join) 오류 — 방 설정창·레일 파견·방 밖 안내·개인 그룹이 같이 쓴다(검수 #826 LOW-5: 방 밖 안내는 서버 코드 원문이 보였다).
const joinErr = (msg, t) => /msgr_channel_personal_blocked/.test(msg) ? t('err.channelPersonalBlocked') : /msgr_request_recently_rejected/.test(msg) ? t('ch.crew.join.cooldown') : /msgr_forbidden/.test(msg) ? t('err.denied') : /msgr_bad_member/.test(msg) ? t('err.crewUnavailable') : friendlyErr(msg, t);
// 크루 작업 중단 전용 오류 매핑(재검수 2026-09-26 L-c) — friendlyErr을 그대로 넓히면 다른 화면의 msgr_not_allowed·미배포 함수
// 오류 표시까지 바뀐다. requestStop 호출부에서만 쓴다: msgr_not_allowed는 권한 문구로, 마이그레이션 미적용으로 RPC 자체가
// 없을 때(Could not find the function 등, PostgREST 스키마 캐시 오류)는 Postgres 원문 대신 일반 안내로 가린다(분리 검수 L-4).
const stopErr = (msg, t) => /msgr_not_allowed/.test(msg) ? t('err.denied') : /Could not find the function|schema cache|function .* does not exist|PGRST20[0-9]/i.test(msg) ? t('err.generic') : friendlyErr(msg, t);
/** 오늘이면 시각만, 아니면 날짜+시각 — 초대 만료(7일 뒤)·노드 마지막 응답·기록처럼 며칠 전후일 수 있는 시각용(시간만 보이면 "오늘 02:31"로 읽힌다 — I-4 실측) */
const fmtWhen = (iso, lang) => { const d = new Date(iso); const time = fmtTs(iso, lang); if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(lang === 'en' ? 'en-US' : 'ko-KR', { month: 'short', day: 'numeric' })} ${time}`; };
const fmtDate = (iso, lang) => new Date(iso).toLocaleDateString(lang === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'short', day: 'numeric' }); // 항상 날짜(오늘이어도 시각만 보이지 않게)
const fmtDay = (iso, lang) => { const d = new Date(iso); return lang === 'en'
  ? [d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), d.toLocaleDateString('en-US', { weekday: 'long' })]
  : [d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }), d.toLocaleDateString('ko-KR', { weekday: 'long' })]; };

/** 메신저 사전 t — 언어 상태는 Argo LanguageProvider(cmd+/ 전환·localStorage argo-lang)를 그대로 쓴다. */
function useT() { const { lang, setLang, t: ta } = useLang(); return { lang, setLang, ta, t: (k, vars) => tm(k, lang, vars) }; }

/** 아바타 — 사람은 원, 크루는 둥근 사각 타일 + 옐로 별(시안 v2 모티프 ②). */
const SafetyCtx = createContext({ blocked: new Set(), block: null, mutedCrewIds: new Set(), muteCrew: null, hiddenUserIds: null, hideUser: null, unhideUser: null, profanityFilterOn: true, aiConsented: false, aiConsentAt: null, setAiConsent: null, onNote: () => {} }); // UGC 신고·차단(App Store 1.2, 2026-09-21) — 차단한 사람의 글은 대화·답글 인용·알림함·검색·DM 미리보기에서 가리고, 푸시는 서버(msgr_push_recipients)가 막는다
// mutedCrewIds — 2026-09-26: 사람뿐 아니라 크루(AI 에이전트)·봇도 사용자 쪽에서 숨길 수 있다(msgr_user_blocks.blocked_crew). 서버 강제가 아니라 그 사람 화면에서만 접힌다.
// profanityFilterOn — 2026-09-26: 받는 메시지의 명백한 욕설·혐오 표현을 가린다(기본 켜짐, 설정에서 끌 수 있다). window 이벤트로 설정 화면과 즉시 동기화(profanity-filter.mjs).
function useProfanityFilterOn() {
  const [on, setOn] = useState(() => readProfanityFilterOn());
  useEffect(() => { const h = (e) => setOn(e.detail); window.addEventListener(PROFANITY_FILTER_EVENT, h); return () => window.removeEventListener(PROFANITY_FILTER_EVENT, h); }, []);
  return on;
}
const AvatarCtx = createContext({ users: {}, crews: {}, looks: null, faceState: () => 'idle', faceFor: (id) => faceOf(id) }); // 프로필 이미지 조회(사람 = msgr_avatars RPC, 에이전트 = msgr_crews.avatar_url, 내 에이전트는 같은 에이전트의 대표 사진) — Av가 userId/crewId로 찾는다. faceState = 사진 없는 크루의 얼굴 표정, faceFor = 그릴 얼굴(crew-face.mjs agentFace — 같은 에이전트는 공간이 달라도 같은 얼굴, 유건 2026-10-05), looks = 내 크루 얼굴 지도(agentLooks)
/** 얼굴 그림 하나(유건 확정 시안 2026-10-01) — 그림은 crew-face.mjs faceInner(상수로만 만든 SVG 문자열, 오피스와 같은 함수).
 *  motionKey가 있으면 앱 전체 몸짓 스케줄러(face-gestures.mjs — 타이머 하나, 화면에 보이는 얼굴만)에 등록해 쉴 때 2~5초마다 몸짓을 한다. px = 그릴 크기(작은 배치·선 굵기 결정). */
function FaceSvg({ face, state = 'idle', px, motionKey = null, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; const g = motionKey != null ? faceGestures() : null; if (!el || !g) return; g.watch(el, motionKey); return () => g.unwatch(el); }, [motionKey]);
  return <svg ref={ref} className={`msgr-face s-${state}${className ? ` ${className}` : ''}`} viewBox="0 0 100 100" aria-hidden="true" dangerouslySetInnerHTML={{ __html: faceInner(face, { state, px }) }} />;
}
/** 에이전트 얼굴 — 도형 12종·색 12색·표정(입 있음). 상태 = 쉼(몸짓)·답변 준비 중·결재 대기·놀람(멘션·수신 1초)·오류·완료·오프라인(crew-face.mjs crewFaceState). */
function CrewFace({ id, name, ctx, px }) {
  const key = id ?? name ?? '?';
  return <FaceSvg face={id ? ctx.faceFor(id) : faceOf(key)} state={id ? ctx.faceState(id) : 'idle'} px={px} motionKey={key} />;
}
const AV_PX = { xs: 20, sm: 22, lg: 40, kk: 48 }; // .msgr-av 크기 클래스의 px(기본 28) — 얼굴의 작은 배치·선 굵기를 고른다. 폰 화면이 24~44px로 키워도 44px 이하라 같은 배치다
function Av({ name, crew, size, company = false, userId = null, crewId = null, src = null }) { // company: 회사 크루(조직 배지 — 별 대신 각진 해시), 그 외 크루는 별 배지(부록 I·K 등급 표시)
  const ctx = useContext(AvatarCtx);
  const url = src ?? (userId ? ctx.users[userId] : crewId ? ctx.crews[crewId] : null);
  return <span className={`msgr-av${crew ? ' crew' : ''}${company ? ' company' : ''}${size ? ` ${size}` : ''}${url ? ' img' : crew ? ' face' : ''}`}>{url ? <img src={url} alt="" draggable={false} /> : crew ? <CrewFace id={crewId} name={name} ctx={ctx} px={AV_PX[size] ?? 28} /> : (name || '?').slice(0, 1)}{crew && <span className="star">{company ? <I name="hash" size={8} /> : <svg viewBox="0 0 16 16"><path d={STAR_D} /></svg>}</span>}</span>;
}
/** 프로필 이미지 정규화 — 가운데 정사각형으로 잘라 256px JPEG로(업로드 전 클라이언트에서). */
async function squareImage(file, size = 256) {
  const bmp = await createImageBitmap(file);
  if (bmp.width === size && bmp.height === size && file.type === 'image/jpeg') return file; // 자르기 화면이 이미 256 정사각 JPEG로 만들었다 — 다시 압축하지 않는다
  const s = Math.min(bmp.width, bmp.height); const c = document.createElement('canvas'); c.width = size; c.height = size;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('image'))), 'image/jpeg', 0.88));
}
/** 아바타 업로드 — 공개 버킷 msgr-avatars, 자기 폴더(avatars/<uid>/…)만 쓸 수 있다(RLS). 반환 = 공개 URL(캐시 무효화 쿼리 포함). */
async function uploadAvatar(uid, key, file) {
  const blob = await squareImage(file);
  const path = `avatars/${uid}/${key}-${Date.now()}.jpg`;
  const up = await supabase.storage.from('msgr-avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (up.error) throw new Error(up.error.message);
  return supabase.storage.from('msgr-avatars').getPublicUrl(path).data.publicUrl;
}
/** 아바타 편집 줄 — 현재 이미지 + 올리기·지우기(내 계정·에이전트 시트 공용). 사진을 고르면 자르기 화면(AvatarCrop)이 열린다(유건 피드백 4 — 폰·데스크톱 같은 화면). */
function AvatarEdit({ name, crew = false, crewId = null, url, onUpload, onRemove, busy, t }) {
  const ref = useRef(null);
  const [pick, setPick] = useState(null); // 고른 원본 파일 — 자르기 화면이 떠 있는 동안
  return (
    <div className="msgr-avatar-edit">
      <Av name={name} crew={crew} crewId={crewId} size="lg" src={url} />
      <div className="acts">
        <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPick(f); }} />
        <button type="button" className="btn sm" disabled={busy} onClick={() => ref.current?.click()}><I name="plus" size={13} />{t(url ? 'profile.avatar.change' : 'profile.avatar.upload')}</button>
        {url && <button type="button" className="btn sm" disabled={busy} onClick={onRemove}><I name="x" size={13} />{t('profile.avatar.remove')}</button>}
      </div>
      {pick && <AvatarCrop file={pick} t={t} onCancel={() => setPick(null)} onSave={(blob) => { setPick(null); onUpload(blob); }} onError={() => { setPick(null); onUpload(pick); }} />}
    </div>
  );
}
/* 사진 자르기 — 정사각형 틀 안에서 끌어 위치를 옮기고, 두 손가락(핀치)·휠·슬라이더로 확대·축소한 뒤 저장. 새 라이브러리 없이 canvas.
   저장 결과는 지금과 같은 256×256 JPEG(품질 0.88). 계산은 avatar-crop.mjs. 사진을 못 읽으면 종전처럼 가운데 자르기로 올린다(onError). */
function AvatarCrop({ file, t, onCancel, onSave, onError }) {
  const [img, setImg] = useState(null); const [zoom, setZoom] = useState(1); const [off, setOff] = useState({ x: 0, y: 0 }); const [busy, setBusy] = useState(false);
  const frame = Math.max(200, Math.min(300, (typeof window !== 'undefined' ? window.innerWidth : 360) - 72));
  const pts = useRef(new Map()); const pinch = useRef(null); const live = useRef({}); live.current = { img, zoom, off };
  useEffect(() => { const u = URL.createObjectURL(file); const im = new Image(); im.onload = () => setImg({ url: u, w: im.naturalWidth, h: im.naturalHeight, el: im }); im.onerror = () => onError?.(); im.src = u; return () => URL.revokeObjectURL(u); }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onCancel(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onCancel]);
  const apply = (z, x, y) => { const cur = live.current.img; if (!cur) return; const nz = clampZoom(z); setZoom(nz); setOff(clampOffset({ w: cur.w, h: cur.h, frame, zoom: nz, x, y })); };
  const down = (e) => { e.currentTarget.setPointerCapture?.(e.pointerId); pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.current.size === 2) { const [a, b] = [...pts.current.values()]; pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: live.current.zoom }; } };
  const move = (e) => {
    const p = pts.current.get(e.pointerId); if (!p) return;
    const nx = e.clientX; const ny = e.clientY; const dx = nx - p.x; const dy = ny - p.y; pts.current.set(e.pointerId, { x: nx, y: ny });
    const { zoom: z, off: o } = live.current;
    if (pts.current.size >= 2 && pinch.current) { const [a, b] = [...pts.current.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); apply(pinch.current.z * (d / Math.max(1, pinch.current.d)), o.x, o.y); return; }
    apply(z, o.x + dx, o.y + dy);
  };
  const up = (e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; };
  const wheel = (e) => { e.preventDefault(); const { zoom: z, off: o } = live.current; apply(z * Math.exp(-e.deltaY * 0.002), o.x, o.y); };
  const frameRef = useRef(null);
  useEffect(() => { const el = frameRef.current; if (!el) return undefined; el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel); }); // 휠은 페이지 스크롤을 막아야 해 passive:false로 직접 단다
  const save = async () => {
    if (!img) return; setBusy(true);
    try {
      const r = cropRect({ w: img.w, h: img.h, frame, zoom, x: off.x, y: off.y });
      const c = document.createElement('canvas'); c.width = 256; c.height = 256;
      c.getContext('2d').drawImage(img.el, r.sx, r.sy, r.size, r.size, 0, 0, 256, 256);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('image'))), 'image/jpeg', 0.88));
      onSave(blob);
    } catch { onError?.(); } finally { setBusy(false); }
  };
  const s = img ? coverScale(img.w, img.h, frame) * zoom : 1;
  return createPortal(<div className="shell msgr-crop-layer" style={{ display: 'contents' }}>
    <div className="msgr-crop-scrim" onClick={onCancel} role="presentation" />
    <section className="msgr-crop" role="dialog" aria-modal="true" aria-label={t('avatar.crop.title')}>
      <h2>{t('avatar.crop.title')}</h2>
      <p className="note">{t('avatar.crop.hint')}</p>
      <div ref={frameRef} className="msgr-crop-frame" style={{ width: frame, height: frame }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label={t('avatar.crop.frame')} role="img">
        {img ? <img src={img.url} alt="" draggable={false} style={{ width: img.w * s, height: img.h * s, left: frame / 2 + off.x - (img.w * s) / 2, top: frame / 2 + off.y - (img.h * s) / 2 }} /> : <span className="note" role="status">{t('ui.loading')}</span>}
      </div>
      <label className="msgr-crop-zoom"><I name="search" size={14} /><span className="sr">{t('avatar.crop.zoom')}</span><input type="range" min="1" max={ZOOM_MAX} step="0.01" value={zoom} disabled={!img} onChange={(e) => apply(Number(e.target.value), off.x, off.y)} aria-label={t('avatar.crop.zoom')} /></label>
      <div className="acts"><button type="button" className="btn" onClick={onCancel} disabled={busy}>{t('ui.cancel')}</button><button type="button" className="btn btn-primary" onClick={save} disabled={!img || busy}><I name="check" size={14} />{t('ui.save')}</button></div>
    </section>
  </div>, document.body);
}
const faceEq = (a, b) => !!a && !!b && a.shape === b.shape && a.color === b.color;
const faceCol = { missingAt: 0 }; // msgr_crews.face 열이 없다고 판정한 시각(옛 서버 폴백). 10분만 기억 — 앱이 라이브 적용보다 먼저 켜져도 재시작 없이 face를 다시 읽는다(재검수 #704)
/** 에이전트 얼굴 고르기 — 소유자만. 도형 12·색 12 중에서 고르면 msgr_crews.face에 {v:2, shape, color}로 저장돼 조직 전원이 같은 얼굴을 본다(유건 확정 시안 2026-10-01).
 *  옛 저장값(키 v 없음)은 대응표로 바꿔 보여 준다 — 바꾸지 않으면 다시 쓰지 않는다. 사진이 있으면 목록·대화에는 사진이 우선(Av)이지만, 사진을 지우면 바로 이 얼굴이 나오도록 고르기는 항상 켜져 있다. */
function FacePicker({ crew, onSave, busy, t }) {
  const look = agentLook(crew.id, useContext(AvatarCtx).looks, crew.face); // 같은 에이전트의 대표 기준(유건 2026-10-05) — 목록·대화와 같은 얼굴에서 고르기 시작한다
  const stored = faceFromStored(look.face);
  const rand = faceOf(look.seed, look.face); // 목록과 같은 계산(저장값 → 없으면 대표 행 id 무작위)
  const [draft, setDraft] = useState(rand);
  const storedKey = `${look.seed}|${stored ? `${stored.shape},${stored.color}` : ''}`;
  useEffect(() => { setDraft(rand); }, [crew.id, storedKey]); // eslint-disable-line react-hooks/exhaustive-deps -- 저장·되돌리기 뒤 새로 읽은 값으로 미리보기를 맞춘다(검수 #704 L-1)
  const pick = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = !faceEq(rand, draft); // rand = 저장값(없으면 id 무작위) — 되돌린 직후 저장 버튼이 켜진 채 남지 않게(검수 #704 L-1)
  return (
    <div className="msgr-facepicker">
      <FaceSvg face={draft} px={64} motionKey={`picker:${crew.id}`} className="preview" />
      <div className="row" role="group" aria-label={t('crew.face.shape')}>
        <span className="msgr-klabel">{t('crew.face.shape')}</span>
        <div className="chips">{FACE_SHAPES.map((s, i) => (
          <button key={s.k} type="button" className="chip" aria-pressed={draft.shape === i} disabled={busy} onClick={() => pick('shape', i)} aria-label={t('crew.face.shape.n', { n: i + 1 })}>
            <FaceSvg face={{ shape: i, color: draft.color }} px={30} />
          </button>
        ))}</div>
      </div>
      <div className="row" role="group" aria-label={t('crew.face.color')}>
        <span className="msgr-klabel">{t('crew.face.color')}</span>
        <div className="chips">{FACE_COLORS.map((c, i) => (
          <button key={c} type="button" className="chip swatch" aria-pressed={draft.color === i} disabled={busy} style={{ background: c }} onClick={() => pick('color', i)} aria-label={t('crew.face.color.n', { n: i + 1 })} />
        ))}</div>
      </div>
      <div className="acts">
        <button type="button" className="btn sm btn-primary" disabled={busy || !dirty} onClick={() => onSave(faceToStore(draft))}>{t('crew.face.save')}</button>
        {stored && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onSave(null)}>{t('crew.face.reset')}</button>}
      </div>
    </div>
  );
}
/** 본문 속 @멘션을 굵게·줄바꿈 금지로(평가 1차: @와 이름 사이 줄바꿈). */
/** 조용한 시간 판정 — from>to면 자정을 넘는 구간(22~7). */
function inQuiet(qh) { if (!qh) return false; const h = new Date().getHours(); return qh.from <= qh.to ? (h >= qh.from && h < qh.to) : (h >= qh.from || h < qh.to); }
function Body({ text }) {
  // 링크는 누르면 외부 브라우저(linkify — 글자로만 그린다). 링크 밖 글자에서 앞이 문자열 시작/공백일 때만 멘션(이메일의 @domain은 제외 — 검수 M4)
  return linkify(text, (seg) => seg.split(/((?:^|(?<=\s))@[^\s@]+)/g).map((p, i) => p.startsWith('@') ? <span key={i} className="msgr-mention">{p}</span> : p));
}

export default function App() {
  const { t, lang } = useT();
  const authKey = authStorageKey(SB_URL);
  const [session, setSession] = useState(undefined);
  const [sessionWaiting, setSessionWaiting] = useState(false);
  const [sessionRecoveryError, setSessionRecoveryError] = useState('');
  const [logoutNotice, setLogoutNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [cleanupEpoch, setCleanupEpoch] = useState(0);
  const logoutPending = useRef(false); const sessionOwner = useRef(null); const deletingAccount = useRef(false); const recoveryRef = useRef(null);
  const cleanupCommitWaiters = useRef([]);
  const applySession = useCallback((next) => {
    const uid = next?.user?.id ?? null;
    if (!uid || (sessionOwner.current && sessionOwner.current !== uid)) navInbox.clear(); // 로그아웃·계정 전환 — 앞 계정의 알림 탭 요청을 다음 계정 셸이 열지 않게(반대 검토 2026-10-01)
    if (sessionOwner.current !== uid) {
      clearComposerSessions(undefined, sessionOwner.current ? {} : { keepUser: uid }); // 첫 적용(앱 시작·새로고침)은 지금 계정의 저장 초안만 남기고, 로그아웃·계정 전환은 전부 지운다
      if (sessionOwner.current) deactivatePush(supabase, sessionOwner.current);
      sessionOwner.current = uid;
    }
    // 누르지 않은 로그아웃(만료·서버에서 끊김) → 로그인 화면에 이유를 적는다(D10). 다시 들어오면 그 안내만 지운다(로그인 뒤 토스트로 남지 않게)
    const tr = sessionTransition(globalThis.localStorage, next, { pending: logoutPending.current, deleting: deletingAccount.current });
    if (tr === 'expired') setLogoutNotice('auth.sessionExpired');
    else if (tr === 'signedIn') setLogoutNotice((v) => (v === 'auth.sessionExpired' ? '' : v));
    setSession(next);
  }, []);
  useEffect(() => {
    if (!cleanupEpoch) return;
    const waiters = cleanupCommitWaiters.current.splice(0);
    Promise.resolve().then(() => realtimeScope.wait()).then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    );
  }, [cleanupEpoch]);
  const signOut = async () => {
    if (logoutPending.current || !session?.user?.id) return;
    logoutPending.current = true; setSigningOut(true); setLogoutNotice('');
    const restorePush = async () => {
      setLogoutNotice('push.logout.failed');
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (data.session?.user?.id !== session.user.id) return;
        activatePush(supabase, session.user.id);
        const result = await registerPush(supabase);
        if (result !== 'registered' && result !== 'unsupported' && result !== 'cancelled') setLogoutNotice('push.logout.restoreFailed');
      } catch { setLogoutNotice('push.logout.restoreFailed'); }
    };
    try {
      const { warning } = await detachPush(supabase, session.user.id);
      if (warning) setLogoutNotice('push.logout.detachFailed');
      const { error } = await recoveryRef.current.restartSignIn();
      if (error) await restorePush();
    } catch { await restorePush(); }
    finally { logoutPending.current = false; setSigningOut(false); }
  };
  useMobileViewport();
  useEffect(() => mountMobileAuth(), []);
  // 알림 탭은 셸 밖(앱 수준)에서 받는다 — 셸이 연결 대기 화면 등으로 내려가 있는 동안 온 탭도 대기함에 남는다(유건 요청 2026-10-01).
  // 푸시 플러그인은 첫 리스너가 붙을 때 보관하던 탭을 한 번 다시 보내고 그 뒤로는 보관하지 않아, 셸 안 리스너가 떨어진 사이의 탭이 사라졌다.
  // 기기 토큰 등록(registerPush)은 계정이 정해진 셸에 그대로 둔다 — 여기서는 듣기만 한다(등록이 두 번 돌지 않는다).
  const sessionRef = useRef(session); sessionRef.current = session;
  useEffect(() => {
    let disposed = false; let detachMac = () => {};
    const offer = (channelId, source) => {
      const signedOut = sessionRef.current === null; // 로그인 화면에서 누른 옛 알림은 다음에 들어오는 계정이 열지 않는다
      pushDiag('tap', `channel ${channelId ?? '-'}`, `src=${source} page=${shellLink.page ?? '-'} org=${shellLink.orgId ?? '-'} shell=${shellLink.mounted ? 'on' : 'off'}${signedOut ? ' signed-out' : ''}`);
      if (channelId && !signedOut) navInbox.offer({ channelId, source, owner: sessionRef.current?.user?.id ?? null });
    };
    const offPush = isMobilePlatform ? mountPush({ onTap: ({ channel_id }) => offer(channel_id, 'push'), onForeground: (p) => shellLink.onForeground?.(p) }) : () => {};
    mountNativeNotificationTaps({ enabled: import.meta.env.TAURI_ENV_PLATFORM === 'darwin' && isDesktopTauri(), onTap: ({ channelId }) => { if (!disposed) offer(channelId, 'mac'); } })
      .then((stop) => { if (disposed) stop(); else detachMac = stop; }).catch(() => {});
    return () => { disposed = true; offPush(); detachMac(); };
  }, []);
  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    const native = mountNativeRealtime({ enabled: import.meta.env.TAURI_ENV_PLATFORM === 'darwin' && isDesktopTauri(), auth: supabase.auth, supabaseUrl: SB_URL, anonKey: SB_ANON, lang }).catch(() => null);
    const sessionApplier = createNativeSessionApplier({ native, applySession });
    const recovery = createSessionRecovery({ auth: supabase.auth, cleanupState: authCleanupState(authKey), hasStoredSession: () => hasStoredAuthSession(authKey), applySession: sessionApplier.apply, setWaiting: setSessionWaiting,
      onCleanupPending: async () => {
        await sessionApplier.apply(null);
        await new Promise((resolve, reject) => {
          cleanupCommitWaiters.current.push({ resolve, reject });
          setSessionWaiting(true);
          setCleanupEpoch((value) => value + 1);
        });
      },
      setFailure: (error, phase) => setSessionRecoveryError(error ? (phase === 'signout' ? 'auth.signInAgainFailed' : 'auth.sessionCheckFailed') : '') });
    recoveryRef.current = recovery;
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => recovery.onAuthStateChange(event, next));
    recovery.start();
    const stopResume = isMobilePlatform ? observeMobileResume(() => recovery.retryNow()) : () => {};
    return () => { sessionApplier.dispose(); if (recoveryRef.current === recovery) recoveryRef.current = null; recovery.stop(); stopResume(); sub.subscription.unsubscribe(); native.then((runtime) => runtime?.stop()); };
  }, [applySession, authKey, lang]);
  const restartSignIn = async () => {
    if (signingOut) return;
    logoutPending.current = true; setSigningOut(true);
    try { await recoveryRef.current?.restartSignIn(); }
    finally { logoutPending.current = false; setSigningOut(false); }
  };
  // 스플래시 준비 신호 — 로그인 화면·연결 대기·설정 없음 화면이 뜨면 준비된 것(조직 로딩 끝은 Shell에서)
  useEffect(() => { if (!configured || sessionWaiting || session === null) markAppReady(); }, [configured, sessionWaiting, session]);
  let body;
  if (!configured) body = <div className="msgr-auth"><div className="msgr-card"><div className="body"><p style={{ color: 'var(--danger)' }}>{t('auth.notConfigured')}</p><ServerRow t={t} open /></div></div></div>;
  else if (sessionWaiting) body = <ConnectionWaiting t={t} onRetry={() => recoveryRef.current?.retryNow()} onSignIn={restartSignIn} error={sessionRecoveryError} busy={signingOut} />;
  else if (session === undefined) body = <div className="msgr-auth"><span className="msgr-klabel">{t('ui.loading')}</span></div>;
  else if (!session) body = <Auth logoutNotice={logoutNotice} />;
  else body = <Shell key={session.user.id} session={session} />;
  const accountDeleted = async () => { deletingAccount.current = true; try { await detachPush(supabase, session?.user?.id); } catch { /* 서버 토큰 행은 이미 없다 */ } try { await recoveryRef.current?.restartSignIn(); } catch { /* 서버 세션은 이미 없다 — 로컬만 비운다 */ } setLogoutNotice('auth.deleted'); deletingAccount.current = false; };
  return <SignOutContext.Provider value={{ signOut, signingOut, accountDeleted }}><Sprite /><UpdateBar t={t} /><MobileUpdateBar t={t} />{session && logoutNotice && <button type="button" className="msgr-toast err" role="alert" onClick={() => setLogoutNotice('')}>{t(logoutNotice)}</button>}{body}</SignOutContext.Provider>;
}

function ConnectionWaiting({ t, onRetry, onSignIn, error, busy }) {
  // 연결 대기(UXM-07) — 진행 표시를 두고, 주 단추는 '지금 다시 연결'(저장된 로그인 그대로). 저장된 로그인을 지우는 다시 로그인은 낮춘 단추로 — 안내 문구('저장된 로그인은 그대로')와 반대 결과였다.
  // 로그아웃 정리가 실패해 멈춘 동안은 다시 연결을 숨기고 로그아웃이 주 단추(화면 검수 UM4 — waitingView). 다시 연결은 바로 실패해도 1초는 '연결하는 중…'(눌렀는데 아무 변화가 없었다)
  const [retrying, setRetrying] = useState(false);
  const retry = async () => { if (retrying) return; setRetrying(true); try { await Promise.all([Promise.resolve().then(() => onRetry?.()).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]); } finally { setRetrying(false); } };
  const v = waitingView({ error, retrying, busy });
  const signOutBtn = <button type="button" className={`btn ${v.primary === 'signout' ? 'btn-primary' : 'ghost'}`} onClick={onSignIn} disabled={busy}>{busy ? t('ui.loading') : t('auth.signOutAndIn')}</button>;
  return <div className="msgr-auth"><div className="msgr-card"><div className="band"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO<span className="tag">{t('auth.tag')}</span></div><div className="body">
    <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{v.spin && <span className="msgr-spin" aria-hidden="true" />}{t(v.title)}</h1>
    <span className="msgr-sr" role="status">{t(v.status)}</span>{/* 상태 알림은 제목과 따로 — h1에 role=status를 주면 제목 역할이 덮였다(UM4) */}
    <p>{t(v.desc)}</p>
    {v.error && <p role="alert" style={{ color: 'var(--danger)' }}>{t(v.error)}</p>}
    {v.primary === 'signout' ? signOutBtn : <>
      <button type="button" className="btn btn-primary" onClick={retry} disabled={retrying || busy} aria-busy={retrying || undefined}>{t(retrying ? 'auth.reconnecting' : 'auth.reconnect')}</button>
      {signOutBtn}
    </>}
  </div></div></div>;
}

/* ─── 서버 선택(부록 L): 기본 Argo 클라우드 / 회사 서버(셀프호스트 Supabase) — 프로필은 이 기기에만, 저장 뒤 새로고침 ─── */
function ServerRow({ t, open = false }) {
  const cur = readProfile(localStorage);
  const [edit, setEdit] = useState(open);
  const [url, setUrl] = useState(cur?.url ?? ''); const [anon, setAnon] = useState(cur?.anon ?? ''); const [bad, setBad] = useState(false);
  const save = () => { if (!normalizeUrl(url) || !anon.trim()) { setBad(true); return; } writeProfile(localStorage, { url, anon }); location.reload(); };
  const reset = () => { clearProfile(localStorage); location.reload(); };
  return (
    <details className="msgr-server" open={edit} onToggle={(e) => setEdit(e.currentTarget.open)}>
      <summary><I name="hash" size={12} />{customServer ? t('auth.server.custom', { host: hostOf(SB_URL) }) : t('auth.server.cloud')}<span className="msgr-klabel">{t('auth.server')}</span></summary>
      <div className="msgr-server-body">{/* details의 내용은 슬롯(블록)으로 들어가 details의 grid·gap이 안 닿는다 — 간격은 이 상자가 준다(LA-08) */}
        <p>{t('auth.server.desc')}</p>
        <label className="msgr-field"><I name="at" /><input placeholder="https://supabase.company.com" value={url} onChange={(e) => { setUrl(e.target.value); setBad(false); }} spellCheck={false} /></label>
        <label className="msgr-field"><I name="lock" /><input placeholder={t('auth.server.key')} value={anon} onChange={(e) => { setAnon(e.target.value); setBad(false); }} spellCheck={false} /></label>
        {bad && <p style={{ color: 'var(--danger)' }}>{t('auth.server.bad')}</p>}
        <div className="row"><button type="button" className="btn sm btn-primary" onClick={save} disabled={!url || !anon}>{t('auth.server.save')}</button>{customServer && <button type="button" className="btn sm ghost" onClick={reset}>{t('auth.server.reset')}</button>}</div>
      </div>
    </details>
  );
}

// Refresh data in place: never remount the shell, composer or current conversation.
function usePullToRefresh(enabled, onRefresh, onError) {
  const [node, setNode] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [pulse, setPulse] = useState(0); // 임계를 넘어 ready/refreshing으로 막 들어설 때마다 +1 — Argo 별의 튐(scale pulse)을 한 번씩만 다시 튼다
  const phaseRef = useRef('idle');
  const callbacks = useRef({ onRefresh, onError });
  callbacks.current = { onRefresh, onError };
  const setPhaseWithPulse = (next) => { if (enteredReady(phaseRef.current, next)) { setPulse((n) => n + 1); haptic('light'); /* 기준선을 넘는 순간 가벼운 진동 */ } phaseRef.current = next; setPhase(next); };
  useEffect(() => {
    if (!enabled || !node) { phaseRef.current = 'idle'; setPhase('idle'); return undefined; }
    return bindPullRefresh(node, {
      refresh: () => callbacks.current.onRefresh(),
      phase: setPhaseWithPulse,
      error: (e) => callbacks.current.onError?.(e.message),
    });
  }, [enabled, node]);
  return { setRef: setNode, phase, pulse };
}
function PullIndicator({ phase, pulse = 0, t }) {
  // 쉬는 동안(idle)에도 붙여 둔다 — 손을 떼거나 새로고침이 끝날 때 띠가 한 번에 사라지지 않고 접히게(높이 전환, 2026-09-29 점검)
  const idle = phase === 'idle';
  const ready = phase === 'ready' || phase === 'refreshing';
  const spinning = phase === 'refreshing';
  return <div className={`msgr-pullrefresh${idle ? ' idle' : ''}${ready ? ' ready' : ''}${spinning ? ' spinning' : ''}`} role="status" aria-live="polite">
    <svg key={pulse} className="star" viewBox="0 0 16 16" aria-hidden="true"><path d={STAR_D} /></svg>
    {!idle && <span className="lb">{t(phase === 'refreshing' ? 'refresh.refreshing' : ready ? 'refresh.release' : 'refresh.pull')}</span>}
  </div>;
}

/* ─── 레일 섹션(채널·1:1·내 크루) — 네이티브 details로 접고 펼친다(유건 지시 2026-09-08). 접힘 상태는 이 브라우저에만(localStorage argo-msgr-rail-fold).
   summary 안의 버튼(새 채널 +)은 클릭 기본 동작을 막아 접힘을 건드리지 않는다. ─── */
const FOLD_KEY = 'argo-msgr-rail-fold';
const readFold = () => { try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
function RailSection({ id, label, right = null, forceOpen = false, children }) { // forceOpen: 폰 DM 탭 — 홈에서 접어 둔 상태를 따르지 않는다(유건 제보 2026-09-15: 홈에서 접으면 DM 화면이 비었다)
  const phone = useIsPhone(); // 폰 구역 헤더 아이콘(슬랙 18px) — 데스크톱은 그리지 않는다
  const [open, setOpen] = useState(() => readFold()[id] !== true ? true : false); // 기본 펼침 — 저장된 값이 '접힘'일 때만 접는다
  const onToggle = (e) => { if (forceOpen) { if (!e.currentTarget.open) e.currentTarget.open = true; return; } const next = e.currentTarget.open; setOpen(next); try { localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFold(), [id]: !next })); } catch { /* 저장 못 해도 동작 */ } };
  return (
    <details className="msgr-sec" data-sec={id} open={forceOpen || open} onToggle={onToggle}>
      <summary className="msgr-group">{phone && <I name={{ fav: 'star', channels: 'hash', dms: 'at', dmpin: 'at', mine: 'star', people: 'at', agents: 'node', friends: 'person', start: 'home' }[id] ?? 'hash'} size={18} className="sec-ic" />}<span className="lbl">{label}</span>{right && <span className="right" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>{right}</span>}</summary>
      {children}
    </details>
  );
}

/* 구역 안의 작은 묶음 — 에이전트를 '내 에이전트 / 외부 / 회사'로 접었다 편다(유건 2026-09-16). 접힘은 구역과 같은 저장소에 남는다. */
function RailFold({ id, label, count, children }) {
  const [open, setOpen] = useState(() => readFold()[id] !== true);
  const onToggle = (e) => { const next = e.currentTarget.open; setOpen(next); try { localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFold(), [id]: !next })); } catch { /* 저장 못 해도 동작 */ } };
  return (
    <details className="msgr-fold" open={open} onToggle={onToggle}>
      <summary className="msgr-folderhead"><span className="lbl">{label}</span><span className="msgr-klabel">{count}</span></summary>
      <div className="msgr-folder">{children}</div>
    </details>
  );
}

/* ─── 상단 내비 버튼 — 데스크톱은 햄버거(레일 열기), 폰은 뒤로가기(홈 페이지로). 마크업은 데스크톱 쪽이 기존과 동일하다. ─── */
// 작은 팝오버 닫기 한 벌(D18) — 바깥을 누르면 닫고, Escape는 닫고 연 버튼으로 초점을 돌려준다(K7).
// inside: 팝오버와 연 버튼을 모두 덮는 선택자(연 버튼을 다시 누르면 그 버튼의 토글이 닫는다), trigger: 초점을 돌려줄 버튼
function useDismiss(open, close, inside, trigger, swallow = false) { // swallow(폰): 바깥 누름은 닫기만 — 아래 대화 행이 열리지 않게(dismiss.mjs)
  useEffect(() => {
    if (!open) return undefined;
    const { down, key } = dismissHandlers({ inside, close, swallow, focusTrigger: () => document.querySelector(trigger)?.focus() });
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

// 조직별 마지막으로 연 채널(S27) — 새로고침 뒤에도 보던 채널로. 이 기기에만 둔다
const SEARCH_LIMIT = 60; // 메시지 검색 한 번에 가져오는 수 — 이만큼 오면 더 있을 수 있다(S22)
const LAST_CH_KEY = 'argo-msgr-last-ch';
const readLastCh = (org) => { try { return JSON.parse(localStorage.getItem(LAST_CH_KEY) || '{}')[org] ?? null; } catch { return null; } };
const PHONE_ORG_KEY = 'argo-msgr-phone-org'; // 폰 채널·기억 탭이 고른 조직(개인 공간은 채팅 탭이라 따로 기억한다)
const LAST_ORG_KEY = 'argo-msgr-last-org'; // 마지막 공간(조직·개인) — 앱을 다시 켜도 거기서 연다(#654 총괄: 설치본 재실행 때 다른 조직 첫 채널로 열림)
const readLastOrg = () => { try { return localStorage.getItem(LAST_ORG_KEY); } catch { return null; } };
const writeLastOrg = (org) => { try { if (localStorage.getItem(LAST_ORG_KEY) !== org) localStorage.setItem(LAST_ORG_KEY, org); } catch { /* 저장 못 해도 이번 세션은 그대로 */ } };
const writeLastCh = (org, ch) => { try { const m = JSON.parse(localStorage.getItem(LAST_CH_KEY) || '{}'); if (m[org] !== ch) localStorage.setItem(LAST_CH_KEY, JSON.stringify({ ...m, [org]: ch })); } catch { /* 저장 못 해도 이번 세션은 그대로 */ } };

// 아직 방이 없는 친구와의 1:1 초안(기능 점검 D13) — 머리·안내·입력창만. 첫 글을 보내면 onSend가 방을 만들고 그 방으로 바꾼다.
// 첨부·멘션은 방이 생긴 뒤의 입력창이 맡는다(첫 글은 글자만).
function DmDraft({ userId, name, initialText = '', onSend, onMenu }) {
  const { t } = useT();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const go = async () => { const body = text.trim(); if (!body || busy) return; setBusy(true); try { await onSend(body); } finally { setBusy(false); } };
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey && !isMobilePlatform) { e.preventDefault(); go(); } };
  return (<>
    <div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{name}</span></div>
    <div className="msgr-thread msgr-dmdraft"><p className="msgr-hint">{t('dm.draft.hint', { name })}</p></div>
    <div className="msgr-dock"><div>
      <form className="msgr-composer" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <textarea rows={1} maxLength={20000} value={text} autoFocus aria-label={t('dm.draft.hint', { name })} onChange={(e) => setText(e.target.value)} {...imeGuardWith(onKey)} />
        <div className="msgr-tools"><button className="send" disabled={busy || !text.trim()} aria-label={t('msg.send')} title={t('msg.send')}><I name="up" size={16} /></button></div>
      </form>
    </div></div>
  </>);
}

function NavButton({ onMenu }) {
  const { t } = useT();
  const phone = useIsPhone();
  return <button type="button" className="msgr-menu" onClick={onMenu} aria-controls={phone ? undefined : 'msgr-navigation'} aria-label={t(phone ? 'phone.back' : 'ui.menu')}><I name={phone ? 'back' : 'menu'} size={phone ? 20 : 16} /></button>;
}

/* ─── 폰 아래 탭 바(유건 확정 2026-10-01): 친구 / 채팅 / 채널 / 에이전트 / 기억. 폰 폭에서만 그린다(데스크톱 트리는 그대로).
   떠 있던 검색 원·+ 버튼과 알림함 탭은 없앴다 — 검색·추가는 각 탭 머리 오른쪽 아이콘으로, 안 읽음은 탭 아이콘 위 숫자로.
   모양(유건 결정 10/1 밤): 다섯 탭 모두 같은 크기의 아이콘 원, 선택된 탭은 강조색으로 채운 원만. 이름 글자는 바에 없다 — 영어에서 늘어난 이름이 잘렸다('Frie').
   어느 탭인지는 화면 위 큰 제목이 말하고, 스크린리더는 aria-label·aria-selected로 듣는다. ─── */
const PHONE_TAB_ICONS = { friends: 'person', chats: 'chat', channels: 'hash', agents: 'memory', memory: 'folder' }; // 에이전트 = 반짝이 별(지금 쓰는 표지), 기억 = 폴더(유건 지시)
function PhoneTabs({ active, onPick, badges = {} }) {
  const { t } = useT();
  return (
    <nav className="msgr-tabbar" aria-label={t('phone.tabs')}>
      <div className="msgr-island" role="tablist">
        {PHONE_TABS.map((k) => { const n = badges[k] || 0; const label = t(`phone.tab.${k}`); return (
          <button key={k} type="button" role="tab" aria-selected={active === k} className={active === k ? 'on' : ''} onClick={() => onPick(k)} aria-label={n > 0 ? t(`phone.tab.badge.${k}`, { tab: label, n: badgeText(n) }) : label}>
            <span className="ic"><I name={PHONE_TAB_ICONS[k]} size={22} filled={active === k} /></span>{n > 0 && <span className="msgr-tabn" aria-hidden="true">{badgeText(n)}</span>}
          </button>
        ); })}
      </div>
    </nav>
  );
}

/* 폰 탭 머리 — 왼쪽 제목(또는 채널·기억 탭의 '조직 이름 ▾'), 오른쪽 아이콘(카톡처럼 탭마다 그 탭의 일만). 아이콘마다 이름(aria-label)이 있다 */
/* 조직 고르기 메뉴 카드 — 채널·기억 탭 제목과 설정 조직 화면이 같은 카드를 쓴다(폭·여백·그림자 하나, 항목만 children으로 다르게. 유건 4차 피드백 2026-10-02) */
function OrgMenuCard({ orgs = [], current, onPick, onClose, badge = null, children = null }) {
  const { t } = useT();
  return (<>
    <div className="msgr-scrim clear ph-scrim" onClick={onClose} role="presentation" />
    <div className="msgr-menu-pop ph-pop ph-orgpop" role="menu" aria-label={t('phone.org.switch')}>
      {orgs.map((o) => <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === current} className={o.id === current ? 'on' : ''} onClick={() => { onClose(); onPick(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t(`role.${o.role}`)}</span>{badge?.(o)}</button>)}
      {children}
    </div>
  </>);
}

/* 설정 조직 화면 맨 위 '조직 이름 ▾' — 고르면 앱 전체의 고른 조직(채널·기억 탭)도 같이 바뀐다. 조직이 하나면 이름만 */
function SetOrgPick({ orgs = [], org, multi, onPick }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return undefined; const on = (e) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [open]);
  if (!org) return null;
  return (<div className="ph-setorg">
    {multi
      ? <button type="button" className="ph-orgtitle" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label={t('phone.org.switchNamed', { name: org.name })}><span className="name">{org.name}</span><I name="caret" size={18} className="caret" /></button>
      : <span className="ph-orgtitle"><span className="name">{org.name}</span></span>}
    {open && <OrgMenuCard orgs={orgs} current={org.id} onPick={(o) => onPick?.(o.id)} onClose={() => setOpen(false)} />}
  </div>);
}

function PhoneHead({ title, left = null, actions = [], children = null }) {
  return (
    <header className="ph-head">
      <div className="ph-head-l">{left ?? <h1 className="ph-title">{title}</h1>}</div>
      <div className="ph-head-r">
        {actions.filter(Boolean).map((a) => (
          <button key={a.key} type="button" className={`ph-hbtn${a.on ? ' on' : ''}`} onClick={a.run} aria-label={a.label} title={a.label} aria-haspopup={a.menu ? 'menu' : undefined} aria-expanded={a.menu ? !!a.on : undefined}><I name={a.icon} size={22} /></button>
        ))}
      </div>
      {children}
    </header>
  );
}

/* ─── 로그인: 머리띠 카드 + 브라우저 핸드오프(Google·GitHub — Argo 앱과 같은 계정·같은 방식). 개발 빌드에서는 비밀번호 로그인도(로컬 스택엔 OAuth가 없다). ─── */
function Auth({ logoutNotice = '' }) {
  const { t, lang, setLang } = useT();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [waiting, setWaiting] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [mobileAuth, setMobileAuth] = useState(getMobileAuthSnapshot);
  useEffect(() => subscribeMobileAuth(setMobileAuth), []);
  // 서버가 켠 제공자만 보인다(검수 #528 HIGH-2: 제공자 설정 전·셀프호스트 서버에서 Apple 버튼이 죽은 채 보였다).
  // 조회 실패와 조회 중을 분리한다. 실패 이유·수동 재시도를 표시하며 서버 제한을 자동 재시도로 두드리지 않는다.
  const [providerState, setProviderState] = useState({ enabled: null, error: null, loading: true });
  const [providerAttempt, setProviderAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    fetchProviderSettings(SB_URL, globalThis.fetch, SB_ANON, { signal: controller.signal }).then((result) => {
      if (alive) setProviderState({ ...result, loading: false });
    });
    return () => { alive = false; controller.abort(); };
  }, [providerAttempt]);
  const enabled = providerState.enabled;
  const show = (p) => providerShown(enabled, p);
  const pending = providerState.loading || !!providerState.error;
  const retryProviders = () => {
    if (providerState.loading) return;
    setProviderState({ enabled: null, error: null, loading: true });
    setProviderAttempt((n) => n + 1);
  };
  const authWaiting = isMobileNative ? mobileAuth.waiting : waiting;
  const mobileError = mobileAuth.error ? t(({ expired: 'auth.err.expired', open_failed: 'auth.err.open', provider_denied: 'auth.err.denied', exchange_failed: 'auth.err.exchange' })[mobileAuth.error] || 'auth.err.start') : '';
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(authErrorText(e.message, t)); } finally { setBusy(false); } }; // 서버 영어 원문 → 사전(D9), 모르는 문구는 원문
  // 앱 웹뷰는 provider 창을 못 띄운다 → 셸이 루프백 브리지를 열고 진짜 브라우저에서 로그인, pairing code로 세션 회수(oauth-handoff.mjs·src-tauri/src/pair.rs).
  // 브라우저(dev·vite preview)에서는 셸이 없어 버튼이 정직하게 안내한다(auth.err.notApp) — 로컬 스택 실측은 dev 비밀번호 로그인으로.
  const viaBrowser = (provider) => run(async () => {
    if (isMobileNative) { await startMobileSignIn(provider); return; }
    setWaiting(provider);
    try {
      const deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now };
      if (inTauri()) { deps.invoke = (await import('@tauri-apps/api/core')).invoke; deps.openUrl = (await import('@tauri-apps/plugin-opener')).openUrl; }
      const tokens = await handoff({ supabaseUrl: SB_URL, provider }, deps);
      await q(supabase.auth.setSession(tokens)); // 세션 단일 소유자 = 이 앱(브라우저 탭은 파싱만 하고 버린다)
      try { if (inTauri()) (await import('@tauri-apps/api/window')).getCurrentWindow().setFocus(); } catch { /* 포커스는 장식 */ }
    } catch (e) {
      const k = { not_app: 'auth.err.notApp', start_failed: 'auth.err.start', open_failed: 'auth.err.open', timeout: 'auth.err.timeout', expired: 'auth.err.expired' }[e.message];
      throw new Error(k ? t(k) : authErrorText(e.message, t)); // setSession 등이 던지는 GoTrue 원문도 같은 표로
    } finally { setWaiting(''); }
  });
  return (
    <div className="msgr-auth"><form className="msgr-card" onSubmit={(e) => e.preventDefault()}>
      <div className="band"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO<span className="tag">{t('auth.tag')}</span></div>
      <div className="body">
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.desc')}</p>
        {logoutNotice && <p role={logoutNotice === 'auth.deleted' ? 'status' : 'alert'} style={{ color: logoutNotice === 'auth.deleted' ? 'var(--fg-2)' : 'var(--danger)' }}>{t(logoutNotice)}</p>}
        {authWaiting ? (
          <p className="msgr-wait"><span className="msgr-klabel">{t('auth.waiting')}</span><button type="button" className="btn sm ghost" disabled={mobileAuth.exchanging} onClick={() => isMobileNative ? cancelMobileSignIn() : location.reload()}>{t('auth.cancel')}</button></p>
        ) : (<>
          {providerState.loading && <p role="status">{t('auth.providers.loading')}</p>}
          {providerState.error && <div role="alert">
            <p>{t(providerErrorKey(providerState.error, { custom: customServer }))}</p>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={retryProviders}>{t('auth.providers.retry')}</button>
          </div>}
          {show('apple') && <button type="button" className="btn btn-apple" disabled={busy || pending} onClick={() => viaBrowser('apple')}><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.37 12.7c.02 2.5 2.2 3.33 2.22 3.34-.02.06-.35 1.2-1.15 2.37-.69 1.01-1.41 2.02-2.54 2.04-1.11.02-1.47-.66-2.74-.66s-1.67.64-2.72.68c-1.09.04-1.92-1.1-2.62-2.1C5.4 16.3 4.3 12.55 5.77 10.02c.73-1.25 2.03-2.05 3.44-2.07 1.07-.02 2.08.72 2.74.72.65 0 1.88-.89 3.17-.76.54.02 2.06.22 3.03 1.65-.08.05-1.81 1.06-1.78 3.14M14.3 6.5c.58-.7.97-1.68.86-2.65-.83.03-1.84.55-2.44 1.25-.54.62-1.01 1.61-.88 2.56.93.07 1.88-.47 2.46-1.16"/></svg>{t('auth.apple')}</button>}
          {show('google') && <button type="button" className="btn btn-primary" disabled={busy || pending} onClick={() => viaBrowser('google')}>{t('auth.google')}</button>}
          {show('github') && <button type="button" className="btn" disabled={busy || pending} onClick={() => viaBrowser('github')}>{t('auth.github')}</button>}
          <LegalLinks t={t} agree />
          {noProviders(enabled) ? <p role="alert" className="msgr-klabel same-method no-providers">{t('auth.noProviders')}</p>
            : <p className="msgr-klabel same-method">{t('auth.sameMethod')}</p>}{/* 버튼이 하나도 없으면 "이전 방법으로" 안내는 모순 — 상태 알림만(검수 #530 N-1) */}
        </>)}
        {(import.meta.env.DEV || import.meta.env.VITE_DEV_LOGIN === '1') && (<> {/* VITE_DEV_LOGIN=1: 로컬 스택을 보는 검수용 번들에서만(OAuth가 없다) — 발행 빌드엔 넣지 않는다 */}
          <span className="msgr-klabel devsep">{t('auth.devOnly')}</span>
          <label className="msgr-field"><I name="at" /><input type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="msgr-field"><I name="lock" /><input type="password" placeholder={t('auth.password')} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <button className="btn" disabled={busy || !email || !pw} onClick={() => run(async () => { await q(supabase.auth.signInWithPassword({ email, password: pw })); })}>{t('auth.verify')} (dev)</button>
        </>)}
        {(mobileError || err) && <p role="alert" style={{ color: 'var(--danger)' }}>{mobileError || err}</p>}
        <ServerRow t={t} />
        <div className="foot"><I name="lock" size={13} /><span style={{ flex: 1 }}>{t('auth.foot')}</span><button type="button" className="btn sm" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}>{t('ui.lang')}</button></div>
      </div>
    </form></div>
  );
}

/* ─── 셸: 레일(조직·채널 칩·크루 카드·멤버 스택) + 본문 ─── */
/* ─── 우클릭 메뉴(유건 지시 2026-09-12 "우클릭으로 할 수 있는 기능이 한 개도 없다"): 커서 자리에, 화면 밖으로 안 나가게. 항목은 이미 있는 동작만 잇는다. ─── */
function CtxMenu({ at, items, onClose }) {
  const ref = useRef(null); const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const place = () => { const viewport = window.visualViewport; const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0; const width = viewport?.width ?? window.innerWidth; const height = viewport?.height ?? window.innerHeight; el.style.maxHeight = `${Math.max(44, Math.min(440, height - 16))}px`; /* 긴 메뉴도 440px에서 멈추고 스크롤(유건 제보 2026-09-16) */ el.style.maxWidth = `${Math.max(44, width - 16)}px`; const r = el.getBoundingClientRect(); setPos({ left: Math.max(left + 8, Math.min(at.x, left + width - r.width - 8)), top: Math.max(top + 8, Math.min(at.y, top + height - r.height - 8)) }); };
    place(); const touch = window.matchMedia?.('(pointer: coarse)').matches; const previous = touch ? null : (at.returnFocus ?? document.activeElement); if (!touch) el.querySelector('button:not(:disabled)')?.focus(); // 터치 기기에선 포커스를 옮기지 않는다 — iOS가 프로그램 포커스에 링을 그려 첫 항목 테두리·닫힌 뒤 행에 선이 남았다(유건 캡처 2026-09-15)
    window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => { window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place); if (previous?.isConnected) previous.focus(); };
  }, [at]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const navigate = (e) => { const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]; const i = buttons.indexOf(document.activeElement); let next; if (e.key === 'ArrowDown') next = (i + 1) % buttons.length; else if (e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length; else if (e.key === 'Home') next = 0; else if (e.key === 'End') next = buttons.length - 1; else if (e.key === 'Tab') { e.preventDefault(); onClose(); return; } if (next !== undefined && buttons.length) { e.preventDefault(); buttons[next].focus(); } };
  const list = items.filter(Boolean); if (!list.length) return null;
  return createPortal(<><div className="msgr-menubg" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
    <div ref={ref} className="msgr-rowmenu msgr-ctxmenu" role="menu" onKeyDown={navigate} style={pos}>{list.map((it, i) => <button key={i} type="button" role="menuitem" tabIndex={-1} className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={(e) => { e.stopPropagation(); onClose(); it.run(); }}><I name={it.icon} size={13} />{it.label}</button>)}</div></>, document.body);
}
// 당겨서 새로고침이 실제로 발동할 수 있는 화면만(그 외 화면엔 당김 손잡이 자체가 없다) — 복원 스냅샷의 page 값을 이 범위로만 신뢰한다.
const PULL_RESTORE_PAGES = new Set([...PHONE_TABS, 'chat']);
function Shell({ session }) {
  const { signOut, signingOut } = useContext(SignOutContext);
  const { t, lang } = useT();
  const isPhone = useIsPhone(); // 폰 셸(홈 전체화면 + 하단 탭) — 데스크톱은 false라 기존 트리 그대로
  const isPhoneRef = useRef(isPhone); isPhoneRef.current = isPhone; // 구독 핸들러(deps에 isPhone 없음)가 최신 값을 보게(재검수 L-2)
  // 당겨서 새로고침 → 화면 복원(유건 제보 2026-09-26: "마지막 보던 페이지에서 이루어지게"). 부팅 시 1회만 소비 —
  // 콜드 스타트(진짜 새 실행)에는 이 값이 없어 기존 기본 동작(홈 탭) 그대로다. page·dmFilter의 초기 state가 이 값을 쓴다.
  const [initialSnap] = useState(() => { try { return consumeScreenSnapshot(window.sessionStorage); } catch { return null; } });
  const pageRef = useRef(null); // saveScreenSnapshot이 참조 — page state(아래)보다 먼저 정의돼야 해 ref로 최신값을 따로 든다
  const dmFilterRef = useRef('all');
  const saveScreenSnapshot = useCallback(() => {
    const page = pageRef.current;
    writeScreenSnapshot(isPhoneRef.current ? window.sessionStorage : null, { page, dmFilter: dmFilterRef.current });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- ref로만 읽는다(당겨서 새로고침 시점의 최신값)
  const pullList = usePullToRefresh(isPhone, async () => {
    const id = activeOrg.current;
    await Promise.all([loadOrgs(), id === PERSONAL ? loadPersonal() : loadOrg(id), loadUnread()]);
  }, (message) => setErr(friendlyErr(message, t)));
  const uid = session.user.id;
  const [orgs, setOrgs] = useState(null); const [orgId, setOrgId] = useState(null);
  const [channels, setChannels] = useState([]); const [chId, setChId] = useState(null);
  // 참여하지 않은 공개 채널 — 목록에는 없지만 알림·검색·링크로 열면 읽기 미리보기로 보여 준다(슬랙식, 유건 검수 2026-09-16)
  const [previewChannels, setPreviewChannels] = useState([]);
  const isPersonal = orgId === PERSONAL;
  const activeOrg = useRef(orgId); activeOrg.current = orgId;
  const loadedOrg = useRef(null);
  const activeChannel = useRef(chId); activeChannel.current = chId;
  // 보관한 옛 조직 1:1을 읽기로 연 방(유건 결정 2026-10-08 1-②) — { orgId, channel: 채널 행, crewId }. 조직 목록(보관 제외)에 없어 이 행으로 그린다(archivedRoomFor)
  const [earlierRoom, setEarlierRoom] = useState(null); const earlierRoomRef = useRef(null); earlierRoomRef.current = earlierRoom;
  const orgRequests = useRef(createRequestGate(() => activeOrg.current));
  const memberRequests = useRef(createRequestGate(() => `${activeOrg.current}:${activeChannel.current}`));
  const unreadRequests = useRef(createRequestGate(() => activeOrg.current));
  const prefQueue = useRef(createPreferenceQueue());
  const [avatars, setAvatars] = useState({}); // user_id → avatar_url(같은 조직 사람만, RPC)
  const [members, setMembers] = useState([]); const [crews, setCrews] = useState([]); const [myAvailable, setMyAvailable] = useState([]); // 부록 M: 내 파견 전 크루(status available — 아르고 브리지가 미러)
  const [chMembers, setChMembers] = useState([]); // 현재 채널의 msgr_channel_members(비공개·DM)
  const [ent, setEnt] = useState(null); const [policy, setPolicy] = useState(null);
  const orgLocked = ent?.ls_status === 'past_due' || ent?.ls_status === 'unpaid'; // J-2: 결제 문제 = 읽기 전용(서버 msgr_org_locked가 최종) // msgr_org_entitlements(plan·seats) — 좌석 표시·한도 안내
  const [dmMembers, setDmMembers] = useState({}); // dm 채널 id → 멤버 행(레일 라벨용: 나 아닌 참가자)
  const [err, setErr] = useState(''); const [note, setNoteState] = useState('');
  const setNote = useCallback((v) => { if (v) setErr(''); setNoteState(v); }, []); // 성공 안내가 오면 같은 자리의 앞 오류 토스트를 지운다 — 끊기 실패 뒤 다시 해 성공해도 앞 오류가 8초 남아 안내를 가렸다(화면 검수 UL9)
  useEffect(() => { if (err && toastError(err, { t, phone: isPhone }) !== err) pushDiag('toast', String(err).slice(0, 300)); }, [err]); // eslint-disable-line react-hooks/exhaustive-deps -- 토스트가 원문 대신 문구를 보이면 원문은 진단 기록(설정 → 진단)에
  const [pushCard, setPushCard] = useState(null); // 전경 푸시 카드(폰) — 다른 채널 메시지만, 탭하면 그 채널로(유건 2026-09-12)
  // "이 채널 열기" 요청(알림 탭·전경 카드·초대) — 대기함(navInbox)은 셸 밖에 있어 셸이 다시 마운트돼도 남는다. 다음 한 걸음은 decideNav가 정하고
  // 여기서는 그 걸음만 실행한다: 열기 / 공간 전환 / 채널 조회 / 같은 공간 목록 한 번 다시 읽기 / 버리기. 콜드 스타트 때 chId만 세우면 channel이 없어
  // Channel이 죽었다(시뮬 재현 2026-09-12) — 그래서 목록에 실제로 있을 때만 연다. 조회는 요청 하나당 1회(실패하면 최대 3회), 다시 읽기도 1회.
  const [navReq, setNavReq] = useState(() => navInbox.get());
  useEffect(() => { const off = navInbox.subscribe(setNavReq); setNavReq(navInbox.get()); return off; }, []); // 구독 직후 한 번 더 읽는다 — 첫 렌더와 구독 사이에 들어온 탭을 놓치지 않게(#788 검수 LOW-1)
  const requestNav = useCallback((channelId, source) => { navInbox.offer({ channelId, source, owner: uid }); }, [uid]);
  const navProg = useRef(null); // 지금 요청의 진행 { seq, row, fails, refreshed, orgsRefreshed, busy } — 이 셸 안에서만(셸이 바뀌면 처음부터 다시 판단)
  const [navStep, setNavStep] = useState(0); // 조회·다시 읽기가 끝나면 판단을 다시 돌린다
  useEffect(() => {
    if (!navReq) return;
    if (navProg.current?.seq !== navReq.seq) navProg.current = { seq: navReq.seq, row: undefined, fails: 0, refreshed: false, orgsRefreshed: false, switched: false, busy: false };
    const prog = navProg.current;
    if (prog.busy) return;
    const act = decideNav({ target: navReq.channelId, owner: navReq.owner, uid, orgs, orgId, personalId: PERSONAL, loaded: loadedOrg.current === orgId, channels, previewChannels, row: prog.row, fails: prog.fails, refreshed: prog.refreshed, orgsRefreshed: prog.orgsRefreshed, switched: prog.switched });
    const diag = (step) => pushDiag('nav', `${step} ${String(navReq.channelId).slice(0, 8)}`, `src=${navReq.source} page=${pageRef.current ?? '-'} org=${orgId ?? '-'}`);
    const run = (work) => { // 비동기 한 걸음 — 끝날 때까지 같은 요청에 다른 걸음을 겹쳐 보내지 않는다(15초 재조회로 효과가 다시 돌아도 조회가 늘지 않게)
      prog.busy = true; diag(act.do);
      Promise.resolve().then(work).catch(async () => { prog.fails += 1; await new Promise((r) => setTimeout(r, 1500 * prog.fails)); })
        .finally(() => { prog.busy = false; if (navProg.current === prog) setNavStep((x) => x + 1); });
    };
    if (act.do === 'wait') return;
    if (act.do === 'report') { diag('report'); setSettingsTab(isPhoneRef.current ? 'reports' : 'me'); setPage('settings'); setRail(false); setSheet(null); navInbox.done(navReq); return; } // 신고 접수 알림(msgr-push reportPush) → 운영 신고함
    if (act.do === 'open') { diag('open'); navInbox.done(navReq); if (openAgentDmInstead(navReq.channelId, navReq.source)) return; setChId(navReq.channelId); setPage('chat'); setRail(false); setSheet(null); return; } // 알림 탭·푸시·전경 카드는 그 방의 글을 가리킨다 — 옛 조직 1:1이어도 그 방을 연다(agentDmRoute, 분리 검수 2026-10-05 #1)
    if (act.do === 'drop') { diag(`drop:${act.reason}`); navInbox.done(navReq); if (act.tell) setNote(t(act.tell === 'offline' ? 'push.nav.offline' : 'push.nav.unavailable')); return; }
    if (act.do === 'switch') { diag(`switch:${act.orgId === PERSONAL ? 'personal' : String(act.orgId).slice(0, 8)}`); prog.switched = true; setOrgId(act.orgId); return; } // 목록이 바뀌면 다시 판단해 연다
    if (act.do === 'lookup') run(async () => { prog.row = (await q(supabase.from('msgr_channels').select('org_id').eq('id', navReq.channelId).maybeSingle())) ?? null; });
    else if (act.do === 'refresh') run(async () => { const list = await (orgId === PERSONAL ? loadPersonal() : loadOrg(orgId)); if (!Array.isArray(list)) throw new Error('superseded'); prog.refreshed = true; }); // 다른 재조회에 밀려 이번 결과가 버려졌으면 다시 읽은 것으로 치지 않는다
    else if (act.do === 'refresh-orgs') run(async () => { await loadOrgs(); prog.orgsRefreshed = true; });
  }, [navReq, navStep, channels, previewChannels, orgs, orgId, uid]); // eslint-disable-line react-hooks/exhaustive-deps
  // 앱 수준 리스너(App)가 보는 지금 셸 — 전경 푸시 카드(폰: 다른 채널 메시지만, 탭하면 그 채널로 — 유건 2026-09-12). page·org는 page 선언 아래에서 적는다
  useEffect(() => {
    const onForeground = ({ title, body, data }) => { if (!title && !body) return; if (data?.channel_id && data.channel_id === notifyRef.current.chId && notifyRef.current.page === 'chat') return; setPushCard({ title, body, channel_id: data?.channel_id, at: Date.now() }); };
    shellLink.mounted = true; shellLink.onForeground = onForeground;
    return () => { if (shellLink.onForeground === onForeground) { shellLink.mounted = false; shellLink.onForeground = null; } }; // page·org는 마지막 값을 남긴다(진단의 shell=off와 같이 읽는다)
  }, []);
  useEffect(() => { if (chId && channels.length && !channels.some((c) => c.id === chId) && !previewChannels.some((c) => c.id === chId) && !archivedRoomFor(earlierRoom, { orgId, chId })) setChId(null); }, [channels, previewChannels, chId, earlierRoom, orgId]); // 사라진 채널(보관·삭제·조직 전환) — 빈 상태로. 참여 전 미리보기 채널·읽기로 연 보관 방(이전 대화 보기)은 사라진 것이 아니다
  useEffect(() => { if (!pushCard) return; const id = setTimeout(() => setPushCard(null), 6000); return () => clearTimeout(id); }, [pushCard]);
  // 폰 즐겨찾기·알림 끄기 토스트(유건 요청 2026-10-02) — 같은 토스트를 쓰되 짧게(FLASH_MS). 같은 문구를 다시 띄워도 시간이 처음부터 다시 간다(noteSeq)
  // 짧은 시간은 flash가 띄운 그 문구에만 붙는다(flashed = { text, ms }) — 그 사이 다른 안내가 뜨면 그 안내는 종전 4초(분리 검수 L-5: 남은 시간이 다른 안내까지 2.5초에 지웠다)
  const flashed = useRef(null); const [noteSeq, bumpNote] = useReducer((x) => x + 1, 0);
  const flash = (key, vars) => { if (!isPhoneRef.current) return; const text = t(key, vars); flashed.current = { text, ms: FLASH_MS }; setErr(''); setNote(text); bumpNote(); }; // 데스크톱은 종전대로(띄우지 않는다)
  // 공간 전환 안내(유건 2026-10-04) — 같은 토스트에 6초(문구별 시간 flashed). 그 문구가 떠 있는 동안 누르면 직전 조직·채널로 돌아간다(tapToast → spaceMoveBack). 다른 안내가 덮으면 누르기는 닫기만
  const [moveNote, setMoveNote] = useState(null); // { text, backTo, backCh }
  const showMoveNotice = (n) => { const text = (lang === 'en' ? (x) => x : koJosa)(t('personal.moved', { name: n.name, org: n.org })); flashed.current = { text, ms: MOVE_NOTICE_MS }; setMoveNote({ text, backTo: n.backTo, backCh: n.backCh }); setErr(''); setNote(text); bumpNote(); };
  const clearToast = () => { flashed.current = null; setErr(''); setNote(''); setMoveNote(null); };
  useEffect(() => { if (!err && !note) return; const id = setTimeout(clearToast, toastMs({ err, note, flashed: flashed.current })); return () => clearTimeout(id); }, [err, note, noteSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  // 토스트 자리 — 아래쪽에 깔린 것(탭 바·새 대화 단추·입력창 받침)의 윗선 바로 위, 가로는 입력창 열(폰은 화면) 가운데. 화면마다 머리 높이가 달라 위쪽 고정은 머리·제목·시트를 가렸다(#801 재검수)
  const toastRef = useRef(null);
  useLayoutEffect(() => {
    const el = toastRef.current; if (!el) return undefined;
    const boxes = (q) => [...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const place = () => {
      // 토스트 아래·옆에 있으면 눌러야 할 것들 — 탭 바·새 대화 단추·입력창 받침·'맨 아래로'·열린 팝업(멘션·슬래시·역할·이모지). 이 중 가장 높은 윗선 바로 위에 놓는다
      const low = boxes('.msgr-tabbar, .msgr-fab, .msgr-dock, .msgr-tobottom .btn, .msgr-pop, .msgr-emojipop'); const viewW = document.documentElement.clientWidth; const viewH = window.innerHeight;
      const col = isPhoneRef.current ? null : (boxes('.msgr-dock > div')[0] ?? boxes('.msgr-main')[0]);
      const colLeft = col?.left ?? 0; const colRight = col?.right ?? viewW;
      el.style.maxWidth = `${toastMaxWidth({ viewW, colLeft, colRight })}px`; // 열이 좁으면(시트 열림) 상자도 그 안에서 줄바꿈 — 시트 쪽으로 삐져나가지 않는다
      const p = toastPlace({ viewW, viewH, boxW: el.offsetWidth, anchorTop: low.length ? Math.min(...low.map((r) => r.top)) : viewH, colLeft, colRight });
      Object.assign(el.style, { left: `${p.left}px`, right: 'auto', marginInline: '0', top: 'auto', bottom: `${p.bottom}px` });
    };
    place();
    // 떠 있는 동안 자리가 바뀌는 것 — 입력창이 여러 줄로 커짐(받침 크기), 키보드, 창 크기, '맨 아래로'·팝업의 등장/사라짐. 토스트가 닫히면 전부 해제한다
    let raf = 0; const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    const dock = document.querySelector('.msgr-dock'); const ro = dock && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(again) : null; if (dock) ro?.observe(dock);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(again) : null; mo?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    const vv = window.visualViewport; window.addEventListener('resize', again); vv?.addEventListener('resize', again); vv?.addEventListener('scroll', again);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); mo?.disconnect(); window.removeEventListener('resize', again); vv?.removeEventListener('resize', again); vv?.removeEventListener('scroll', again); };
  }, [err, note]);
  const [tick, setTick] = useState(0); // 화면 다시 그리기 시계 — 네트워크 효과는 여기에 묶지 않는다(유휴 요청 0, 기능 점검 D2 2026-10-02)
  const [prefsEpoch, bumpPrefs] = useReducer((x) => x + 1, 0); // 내가 쓴 설정(음소거·고정·즐겨찾기)을 다시 읽는 신호
  const [friendsEpoch, bumpFriends] = useReducer((x) => x + 1, 0); // 친구 목록 다시 읽기 — 친구 방송(u:)·친구 화면에 들어갈 때
  const [membersEpoch, bumpMembers] = useReducer((x) => x + 1, 0); // 열린 방 구성원 다시 읽기 — 그 방의 시스템 글·넣기 요청 방송
  const [inboxEpoch, bumpInbox] = useReducer((x) => x + 1, 0); // 알림함 다시 모으기 — 나를 부른 글·DM·크루 답글·결재 방송
  const [syncEpoch, bumpSync] = useReducer((x) => x + 1, 0); // 방송이 없는 값(친구·차단·설정·목록)을 다시 읽는 때 — 모바일 복귀·데스크톱 창 복귀(30초 이상 가려진 뒤)·실시간 재연결
  useEffect(() => { // 모바일 푸시(유건 제보 2026-09-12): 로그인 뒤 토큰 등록. 알림 탭·전경 수신은 앱 수준 리스너(App)가 받아 대기함·shellLink로 넘긴다(2026-10-01)
    if (!isMobilePlatform) return;
    activatePush(supabase, uid);
    const reg = () => registerPush(supabase).then((r) => { if (r.startsWith('error:')) console.warn('[push]', r); });
    reg(); const stopResume = observeMobileResume(reg); // 토큰은 회전한다 — 앱 재개마다 다시 등록
    return () => { deactivatePush(supabase, uid); stopResume(); };
  }, [uid]);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  // 아이콘 배지 재동기화(유건 제보 2026-09-15: 다 읽어도 폰 배지가 남음) — 배지는 서버가 읽음 커서 변경 때만 푸시로 내려보내는데, 토큰이 바뀌거나(앱 재설치)
  // 푸시를 놓치면 폰 숫자가 굳는다. 앱이 앞으로 올 때·알림함을 열거나 다 읽을 때 서버에 재계산·재전송을 요청한다(iOS 토큰 없는 사용자는 서버가 no-op). 3초 한 번.
  // 폰(2026-10-01, 유건 제보 "다 읽어도 아이콘 '1'이 남는다"): iOS는 앱이 앞에 있을 때 받은 푸시의 배지를 적용하지 않는다(플러그인 willPresent → [],
  // 시뮬레이터 실측). 그래서 위 재전송 푸시는 앞에 있는 폰에서 버려지고, 아이콘에는 앱이 쓴 숫자(예전엔 모든 채널 합계 — 서버와 다른 셈법)가 남았다.
  // → 폰은 서버 배지(msgr_my_badge, 푸시와 같은 정의)를 읽어 앱이 직접 쓴다. 읽기 RPC뿐 — 서버 쓰기·pg_net·APNs 호출이 없다(재전송 RPC는 데스크톱만).
  // Android는 아이콘 숫자가 트레이 알림 수라서 다 읽은 채널의 알림만 지운다 — 남길 목록은 안 읽은 글이 있는 모든 채널(msgr_my_badge의 unread, 배지 n이 아니다).
  const legacyBadge = useRef(null); // 서버 함수가 아직 없을 때(라이브 적용 전) 쓸 예전 숫자 — 아래 렌더에서 갱신
  const iconBadge = useMemo(() => (isMobileNative ? createIconBadge({
    fetchRows: async () => { const { data, error } = await supabase.rpc('msgr_my_badge'); if (error) throw error; return data ?? []; },
    setIcon: (n) => { setBadge(n); },
    clearTray: isAndroid ? ({ keep }) => { clearTray(keep); } : null,
    fallback: () => legacyBadge.current,
  }) : null), [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => iconBadge?.stop(), [iconBadge]);
  const badgeSyncAt = useRef(0);
  const resyncBadge = useCallback(() => { if (iconBadge) { iconBadge.resume(); return; } const now = Date.now(); if (now - badgeSyncAt.current < 3000) return; badgeSyncAt.current = now; supabase.rpc('msgr_push_badge_resync').then(() => {}, () => {}); }, [iconBadge]);
  // 지금 이 화면을 보고 있는 기기를 서버에 알린다 — PC를 보는 동안에는 폰 푸시를 건너뛴다(유건 2026-09-16).
  // 판정은 서버의 msgr_push_recipients가 한다. 창을 떠나면 심박이 멎어 2분 안에 폰 알림이 되살아난다.
  useEffect(() => {
    if (!uid) return undefined;
    return startPresence({ supabase, source: isMobileNative ? 'mobile' : (isDesktopTauri() ? 'desktop' : 'web') });
  }, [uid]);
  useEffect(() => { if (!uid) return; resyncBadge(); const onVis = () => { if (document.visibilityState === 'visible') resyncBadge(); }; document.addEventListener('visibilitychange', onVis); return () => document.removeEventListener('visibilitychange', onVis); }, [uid, resyncBadge]); // 콜드 스타트(푸시 탭 포함)에도 1회 — 검수 M-2
  const [rail, setRail] = useState(false); // 폰 폭: 메뉴 버튼으로 레일 열기
  const [page, setPage] = useState(() => (isPhone && PULL_RESTORE_PAGES.has(initialSnap?.page) ? initialSnap.page : (isPhone ? startTab({ last: readLastOrg(), personal: PERSONAL, orgIds: [readLastOrg()].filter(Boolean) }) : 'chat'))); // 폰 첫 화면: 마지막 공간이 조직이면 채널 탭, 아니면 채팅 탭(조직이 사라졌으면 아래 공간 맞추기가 바로잡는다)
  pageRef.current = page; // saveScreenSnapshot(위)이 최신 page를 보게 — page state 선언이 그 콜백보다 늦어 ref로 연결
  shellLink.page = page; shellLink.orgId = orgId; // 탭 진단(App의 앱 수준 리스너)이 지금 화면·공간을 적게 — 종전 tap 줄의 org는 늘 '-'였다
  useEffect(() => { pushDiag('shell', `page=${page} chId=${chId ?? '-'} org=${orgId ?? '-'}`); }, [page, chId, orgId]); // 진단(설정 → 진단) — 화면 이동만 기록 // 폰은 홈에서 시작(유건 2026-09-10) · 'chat' | 'settings' | 'docs' — 언어·테마·계정은 설정 페이지(유건 실검수 2026-09-03), 문서 = 조직 문서(G-1)
  // ── 폰 화면 스택 = 브라우저 history(유건 제보 2026-09-15: DM 탭에서 대화를 열고 뒤로 가면 홈으로 갔다) ──
  // 루트(아래 탭 5개 — phone-shell.mjs PHONE_TABS)는 replaceState, 그 위에 여는 화면(대화·설정·검색)은 pushState. 상단 뒤로 버튼·iOS 가장자리 스와이프·
  // Android 하드웨어 뒤로(WryActivity가 webView.goBack → popstate)가 전부 같은 스택을 타서 "그 전 화면"으로 돌아간다. 데스크톱은 무관.
  const ROOT_PAGES = useMemo(() => new Set(PHONE_TABS), []);
  const navPrev = useRef(page); const navPopping = useRef(false); const navCollapse = useRef(null); const navBackPending = useRef(false); const navBackTicket = useRef(0); const lastRoot = useRef(isPhoneRoot(page) ? page : 'chats'); // lastRoot = 스와이프 뒤로가기 밑에 깔 실제 이전 루트 탭 // navCollapse = 루트 탭으로 갈 때 접는 중인 목적지
  useEffect(() => { // popstate 구독은 폰일 때 한 번. 루트 항목 시딩은 state가 없을 때만(폭 전환으로 다시 돌아도 깊이를 지우지 않는다 — 검수 M-4)
    if (!isPhone) return;
    const onPop = (e) => {
      const to = navCollapse.current;
      if (to) { navCollapse.current = null; navPopping.current = false; try { history.replaceState({ page: to, chId: null, depth: 0 }, ''); } catch { /* */ } return; } // 접기 완료 — page는 이미 루트
      const st = e.state; if (!st?.page) return; navBackTicket.current += 1; navBackPending.current = false; navPopping.current = true; if (st.chId) setChId(st.chId); setPage(st.page);
    };
    window.addEventListener('popstate', onPop);
    try { if (!history.state?.page) history.replaceState({ page, chId, depth: 0 }, ''); } catch { /* 일부 웹뷰는 replaceState를 막는다 — 스택 없이 홈으로 */ }
    return () => window.removeEventListener('popstate', onPop);
  }, [isPhone]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { // 탭 전환 도착 순간 레일 스크롤을 맨 위로(그리기 전에). 이전 탭의 스크롤 위치가 새 목록 범위를 넘으면 iOS가 고무줄처럼 튕겨 되돌린다 — "도착하면 탄성이 떨린다"(유건 2026-09-15). 뒤로(pop)는 위치를 지킨다
    if (!isPhone) return; const prev = navPrev.current; if (prev === page || !ROOT_PAGES.has(prev) || !ROOT_PAGES.has(page)) return;
    const el = document.querySelector('.msgr-side .msgr-railbody'); if (el) el.scrollTop = 0;
  }, [page, isPhone, ROOT_PAGES]);
  useEffect(() => {
    if (!isPhone) return;
    const prev = navPrev.current; const same = prev === page; navPrev.current = page; if (ROOT_PAGES.has(page)) lastRoot.current = page;
    if (!same) { // 전환 애니메이션: 루트↔루트 = tab(페이드), 루트→하위 = push(오른쪽에서), 하위→루트 = pop(페이드; 스와이프로 온 경우는 스와이프가 이미 움직였으므로 없음)
      const kind = ROOT_PAGES.has(prev) && ROOT_PAGES.has(page) ? (ROOT_ORDER.indexOf(page) > ROOT_ORDER.indexOf(prev) ? 'tab-left' : 'tab-right') : ROOT_PAGES.has(page) ? (swipeTo ? null : 'pop') : ROOT_PAGES.has(prev) ? 'push' : 'tab-left'; // tab-left = 오른쪽 탭으로 가니 새 화면이 오른쪽에서 들어온다
      if (kind) { const n = ++animSeq.current; setPageAnim(`${kind}-${n % 2 ? 'a' : 'b'}`); clearTimeout(animTimer.current); animTimer.current = setTimeout(() => setPageAnim(null), 340); } // push 300ms보다 뒤에 해제
    }
    if (navPopping.current) { navPopping.current = false; return; }
    // depth = 우리 스택 깊이(루트 0). history.length로 판단하면 앱 밖 이전 문서(빈 탭·로그인 왕복)로 나가 버린다(실측 2026-09-15).
    const depth = history.state?.depth ?? 0;
    try {
      if (ROOT_PAGES.has(page)) {
        if (depth > 0 && !same) { navCollapse.current = page; navPopping.current = true; history.go(-depth); setTimeout(() => { if (navCollapse.current) { navCollapse.current = null; navPopping.current = false; } }, 500); return; } // 루트 탭 = 스택 접기(안드로이드 하드웨어 뒤로가 옛 대화로 내려가지 않게 — 검수 M-3). go가 no-op이면 가드를 500ms 뒤 푼다(N-5)
        history.replaceState({ page, chId, depth: 0 }, '');
      } else if (same) history.replaceState({ page, chId, depth }, ''); // 같은 화면 안의 전환(대화에서 다른 채널) — 스택을 쌓지 않는다: 뒤로는 루트로(슬랙과 같은 얕은 스택, 의도)
      else history.pushState({ page, chId, depth: depth + 1 }, '');
    } catch { /* 위와 같음 */ }
  }, [page, chId, isPhone, ROOT_PAGES]); // eslint-disable-line react-hooks/exhaustive-deps
  const goBack = useCallback(() => {
    if (!isPhone || (history.state?.depth ?? 0) === 0) { setPage(isPhone ? lastRoot.current : 'chat'); return; } // 루트(깊이 0)에서는 history.back을 부르지 않는다 — 마지막 탭으로
    // popstate가 오기 전 연타하면 history가 두 칸 이상 이동해 앱 밖으로 나갈 수 있다. 한 번의 뒤로 이동이 도착할 때까지만 막는다.
    if (navBackPending.current) return;
    navBackPending.current = true;
    const ticket = ++navBackTicket.current;
    history.back();
    window.setTimeout(() => { if (navBackTicket.current === ticket) navBackPending.current = false; }, 500); // 일부 웹뷰가 popstate를 놓친 경우 다음 뒤로 시도는 막지 않는다.
  }, [isPhone]);
  useEffect(() => {
    if (!isMobileNative) return undefined;
    let disposed = false; let listener = null;
    const onNativeBack = () => {
      if (appBackStack.closeTop()) return; // 열린 시트·팝업부터(MSG-10 — 시트를 연 채 뒤로를 누르면 앱이 꺼지거나 아래 화면이 닫혔다)
      if ((history.state?.depth ?? 0) > 0) { goBack(); return; }
      const b = backRoot.current; const act = rootBackAction({ page: b.page, home: b.isPhone ? 'chats' : b.page, lastAt: b.warnedAt, now: Date.now() });
      if (act === 'home') { b.toHome(); return; } // 다른 아래 탭이면 홈(채팅) 탭으로
      if (act === 'warn') { b.warnedAt = Date.now(); b.note(); return; } // 한 번 더 누르면 닫는다고 알린다(입력하던 내용이 실수로 사라지지 않게)
      import('@tauri-apps/api/core').then(({ invoke }) => invoke('plugin:app|exit')).catch(() => {});
    };
    import('@tauri-apps/api/app').then(({ onBackButtonPress }) => onBackButtonPress(onNativeBack)).then((next) => {
      if (disposed) next.unregister(); else listener = next;
    }).catch(() => {});
    return () => { disposed = true; listener?.unregister(); };
  }, [goBack]);
  const backRoot = useRef({ warnedAt: 0 }); Object.assign(backRoot.current, { page, isPhone, toHome: () => pickRoot('chats'), note: () => setNote(t('back.exitHint')) }); // Android 뒤로가 지금 화면·탭 이동·안내를 보게(리스너는 한 번만 단다)
  const openNav = () => { if (isPhone) goBack(); else setRail(true); }; // 폰: 뒤로(그 전 화면) / 데스크톱: 레일 서랍
  const backFromPage = () => { if (isPhone) goBack(); else setPage('chat'); }; // 설정·검색·알림함·기억 화면의 뒤로
  const ROOT_ORDER = PHONE_TABS; // 아래 탭 순서 — 전환 애니메이션 방향의 기준
  const pickRoot = (k) => { setTabQ(null); setOrgMenu(false); setChPlus(false); setPage(k); }; // 아래 탭 선택 — 탭 안 검색·머리 메뉴는 탭을 옮기면 닫는다(기억 탭 메뉴가 채널 탭 메뉴로 바뀌어 남지 않게). 공간(개인·조직)은 아래 '탭별 공간 맞추기'가 맞춘다
  const [pageAnim, setPageAnim] = useState(null); const animSeq = useRef(0); const animTimer = useRef(null); // 연속 전환마다 새 값·a/b 변형으로 CSS 애니메이션이 재시작(검수 M-2) // 폰 화면 전환 애니메이션 종류(push·pop·tab, 260ms 뒤 해제 — 유건 2026-09-15 "탭 이동도 부드럽게")
  const [swipeTo, setSwipeTo] = useState(null); // 스와이프 뒤로가기 중 밑에 깔 루트 — DM이면 레일을 미리 DM 탭 모양으로 그린다(깜빡임 제보 2026-09-15)
  const edgeEnabled = isPhone && !isPhoneRoot(page);
  useEffect(() => { if (!edgeEnabled) setSwipeTo(null); }, [edgeEnabled]); // 제스처 도중 핸들러가 떨어지면 onEnd가 안 오므로 여기서 해제(검수 L-5)
  const edgeBack = useEdgeSwipeBack(goBack, edgeEnabled, { underlay: () => lastRoot.current, onStart: (to) => setSwipeTo(to), onEnd: () => setSwipeTo(null) }); // 폰: 왼쪽 가장자리 스와이프 = 뒤로(그 전 화면)
  const [orgMenu, setOrgMenu] = useState(false);
  const [runnerOpen, setRunnerOpen] = useState(false); // '실행기 연결' 시트
  const openRunner = useCallback(() => setRunnerOpen(true), []);
  const [chPlus, setChPlus] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState(null);
  const [personalCard, setPersonalCard] = useState(null); // 개인 에이전트 카드(크루 id)
  const [profileName, setProfileName] = useState(null); const [profileTick, setProfileTick] = useState(0); // 폰 설정 '개인' 줄의 내 이름 — 설정 목록을 열 때만 1건 읽는다(프로필 저장 뒤 다시) // 폰 설정을 열 때 바로 보일 묶음('agents'|'memory')
  const [memSort, setMemSort] = useState(readMemSort); // 기억 폴더 정렬(설정 > 기억)
  const pickMemSort = (v) => { setMemSort(v); try { localStorage.setItem(MEM_SORT_KEY, v); } catch { /* 이번 세션만 */ } };
  const [agentFilter, setAgentFilter] = useState('all'); // 폰 에이전트 탭 상단 메뉴(전체·즐겨찾기·내 에이전트·외부 에이전트)
  const [memDoc, setMemDoc] = useState(null); // 폰 기억 탭에서 연 문서 { doc, label } — 읽기 전용 보기(page 'memdoc') // 폰 친구 탭 '받은 친구 요청 N' 펼침 // 폰 채널 탭 머리의 + 메뉴(새 채널 만들기 / 채널 찾아보기)
  const [chCount, setChCount] = useState({}); // 채널 id → 참여 인원(폰 채널 줄의 인원 수)
  const [sheet, setSheet] = useState(null); // 크루 시트(크루 id) — 허용 범위·소유자·접속
  const [chSheet, setChSheet] = useState(false); // 채널 시트 — 이름·주제·기억·멤버·보관
  const [chSheetAdd, setChSheetAdd] = useState(null); // 시트를 열 때 바로 펼칠 패널('crew') — 상단 "크루" 버튼(유건 지적 2026-09-08: 크루를 채널에 넣는 UI가 안 보임)
  const [mentionReq, setMentionReq] = useState(null); // 시트 "@로 부르기" → 작성창에 멘션 삽입
  const [inboxKind, setInboxKind] = useState('all'); // 알림함을 열 때 미리 고를 거르개
  const [inboxNet, setInboxNet] = useState([]); /* 알림함 서버 조회분(멘션·답글·DM·결재·참여 요청·공지) — 친구 요청·차단·숨김은 아래 useMemo가 조회 없이 합친다 */ const [inboxSeen, setInboxSeen] = useState(() => readInboxSeen()); const [inboxPrev, setInboxPrev] = useState(0); // 알림함 v1
  const [railSort, setRailSort] = useState(() => { try { const v = localStorage.getItem('argo-msgr-rail-sort'); return v === 'added' || v === 'custom' ? v : 'name'; } catch { return 'name'; } }); // 내 에이전트 정렬: name(이름순) | added(추가순) | custom(직접 배치, 2026-09-29) — 소속별·그룹은 뺐다(유건 결정 2026-09-09: 평평한 목록)
  const pickSort = (v) => { setRailSort(v); try { localStorage.setItem('argo-msgr-rail-sort', v); } catch {} };
  const [meMenu, setMeMenu] = useState(false);
  const [settingsTab, setSettingsTab] = useState(null); // 알림함·프로필 메뉴에서 설정의 특정 탭으로
  // 폰: 옛 경로(설정 탭 이름 + 'settings' 페이지)를 새 화면으로 바꾼다 — 신고 알림·조직 시작 단계·초대 관리 등이 그대로 동작하게
  const phoneSettingsPage = (tab) => (tab === 'crews' ? (orgId && orgId !== PERSONAL ? 'set-server' : 'settings') : ({ me: 'set-profile', friends: 'set-friends', reports: 'set-privacy', org: 'orgsettings', members: 'orgsettings' })[tab] ?? 'settings');
  useEffect(() => { if (!isPhone || page !== 'settings' || !settingsTab) return; const m = phoneSettingsPage(settingsTab); if (m === 'settings') return; if (m !== 'orgsettings') setSettingsTab(null); setPage(m); }, [isPhone, page, settingsTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isPhone || page !== 'settings' || !uid) return; let live = true; q(supabase.rpc('msgr_people_names', { ids: [uid] })).then((rows) => { if (live) setProfileName((rows ?? []).find((r) => r.user_id === uid)?.name || null); }).catch(() => {}); return () => { live = false; }; }, [isPhone, page === 'settings', uid, profileTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dmDraft, setDmDraft] = useState(null); // { userId, text } — 아직 방이 없는 친구와의 1:1(기능 점검 D13). 첫 글을 보낼 때 방을 만든다
  useEffect(() => { if (page !== 'chat' || orgId !== PERSONAL) setDmDraft(null); }, [page, orgId]); // 대화 화면을 떠나거나 공간을 바꾸면 초안을 닫는다
  const [jump, setJump] = useState(null); // 검색 결과에서 고른 메시지 { ch, mid } — 그 채널이 열리면 그 글까지 불러와 가운데로 스크롤·강조(D11)
  const [searchQ, setSearchQ] = useState(''); const [searchRes, setSearchRes] = useState(null); const [searchBusy, setSearchBusy] = useState(false); const searchSeq = useRef(0); const searchRef = useRef(null); // 앱 내 검색(유건 지시 2026-09-09): 메시지 본문·사람·에이전트, ⌘K
  const [online, setOnline] = useState(true); useEffect(() => watchOnline(setOnline), []); // 연결 끊김 막대 — 브라우저가 아는 연결 상태(online/offline 이벤트). 다시 연결되면 사라진다
  useEffect(() => { const on = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setRail(true); searchRef.current?.focus(); } }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, []);
  // 새로고침(⌘R/Ctrl+R/F5) — 입력창에 초점이 있어도 동작. 로그인은 유지(location.reload만, 세션 초기화 아님).
  useEffect(() => { const onKey = (e) => { const k = e.key.toLowerCase(); if (k === 'f5' || ((e.metaKey || e.ctrlKey) && (k === 'r' || e.code === 'KeyR'))) { e.preventDefault(); saveScreenSnapshot(); location.reload(); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  const leaveSearch = () => { setSearchQ(''); setSearchRes(null); setSearchBusy(false); searchSeq.current++; if (page === 'search') setPage('chat'); }; // 지우기 버튼·Esc가 같은 일(D18 S101: 결과 화면에서 Esc면 대화로)
  useEffect(() => { // 결과 화면에서 칸 밖에 초점이 있어도 Esc면 대화로 — 입력칸·열린 창이 먼저 받는다
    if (page !== 'search') return undefined;
    const on = (e) => { if (e.key !== 'Escape' || e.defaultPrevented || e.target.closest?.('input, textarea, [role="dialog"], [role="menu"]')) return; leaveSearch(); };
    window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const runSearch = async (raw) => {
    const qs = raw.trim(); if (!qs || !org) { setSearchRes(null); return; }
    setPage('search'); setRail(false); setSearchRes(null); setSearchBusy(true); const seq = ++searchSeq.current; // 조회 중에는 옛 결과·첫 안내문 대신 '찾는 중'(검수 E: 연결이 끊기면 20초 가까이 첫 안내문이 그대로였다)
    const like = `%${qs.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    // 개인 공간의 글은 org가 없다 — 가상 org id로 조회하면 서버가 uuid로 못 읽어 결과가 늘 빈다(RLS가 내 방으로 이미 좁힌다).
    const sel = supabase.from('msgr_messages').select('id, channel_id, author_kind, author_user_id, crew_id, body, created_at');
    const base = blockedIds.size ? sel.or(`author_user_id.is.null,author_user_id.not.in.(${[...blockedIds].join(',')})`) : sel; // 차단한 사람의 글은 조회에서 뺀다 — '더 있음' 판정도 걸러진 결과 기준
    const scoped = isPersonal ? base.is('org_id', null) : base.eq('org_id', org.id);
    const { msgs, more, failed } = await fetchSearchRows(() => q(scoped.is('deleted_at', null).ilike('body', like).order('id', { ascending: false }).limit(SEARCH_LIMIT + 1)), SEARCH_LIMIT, (e) => pushDiag('search', e?.message ?? e)); // 실패를 빈 결과로 삼키지 않는다 — failed면 결과 위에 '일부만 보입니다'(검수 E, 2026-10-01)
    if (seq !== searchSeq.current) return; setSearchBusy(false);
    if (activeOrg.current !== org.id) return;
    const lc = qs.toLowerCase();
    setSearchRes({ q: qs, msgs, more, failed, people: members.filter((m) => (m.display_name || '').toLowerCase().includes(lc)), agents: crews.filter((c) => (c.owner_user_id === uid || crewTier(c, org) === 'company') && (c.display_name.toLowerCase().includes(lc) || (c.role_text || '').toLowerCase().includes(lc))) /* 남의 에이전트는 검색에도 없다(유건 2026-09-24) */, channels: searchChannelsByName(channels, previewChannels, lc) /* 참여 전 공개 채널도 찾는다 — 눌러 미리보기로 열고 참여(점검 A·B #2) */ });
  }; // 하단 프로필(이름) 클릭 → 메뉴(내 계정·로그아웃) — 로그아웃 버튼은 여기로(유건 지시 2026-09-09)
  const [friends, setFriends] = useState([]); // 친구·요청(msgr_my_friends) — 레일 '친구' 절·알림함·설정 카드가 같이 쓴다
  const loadFriends = useCallback(async () => { setFriends(await q(supabase.rpc('msgr_my_friends')).catch(() => [])); }, []);
  useEffect(() => { if (uid) loadFriends(); }, [uid, loadFriends, syncEpoch, friendsEpoch]); // 주기 없음 — 시작·복귀·친구 방송(u: friend, 서버 20261002115000)·친구 화면 진입
  const friendsScreen = isPhone ? page === 'friends' || page === 'set-friends' : page === 'settings';
  useEffect(() => { if (friendsScreen) bumpFriends(); }, [friendsScreen]); // 친구 화면에 들어갈 때 한 번(방송이 막혀 있던 동안의 변화를 따라잡는다)
  // 친구 숨김(4차 피드백 2026-10-02, msgr_user_hides) — 내 목록·새 채팅·초대 후보에서만 뺀다(친구 관계·대화·알림은 그대로).
  // 숨김은 나만 바꾸므로 시작·모바일 복귀 때만 읽는다(15초 tick에 묶지 않는다): 기기당 시작 1회 + 복귀마다 1회, 유휴 0.
  const [hiddenUserIds, setHiddenUserIds] = useState(null);
  useEffect(() => { if (!uid) return undefined; let live = true; q(supabase.rpc('msgr_my_hidden_users')).then((rows) => { if (live) setHiddenUserIds(new Set((rows ?? []).map((r) => r.user_id))); }).catch(() => {}); return () => { live = false; }; }, [uid, resumeEpoch]);
  const hideUser = useCallback(async (id) => { await q(supabase.rpc('msgr_hide_user', { target: id })); setHiddenUserIds((p) => new Set([...(p ?? []), id])); setNote(t('fm.hidden.done')); }, [t]);
  const unhideUser = useCallback(async (id) => { await q(supabase.rpc('msgr_unhide_user', { target: id })); setHiddenUserIds((p) => { const n = new Set(p ?? []); n.delete(id); return n; }); setNote(t('fm.unhidden.done')); }, [t]);
  const [blockedIds, setBlockedIds] = useState(() => new Set()); // 서버 차단은 개인 1:1·친구만 막는다 — 조직 채널의 글은 화면에서 가린다
  const loadBlocked = useCallback(async () => { const rows = await q(supabase.rpc('msgr_my_blocked')).catch(() => null); if (!rows) return; const next = new Set(rows.map((r) => r.user_id)); setBlockedIds((cur) => (cur.size === next.size && [...next].every((id) => cur.has(id)) ? cur : next)); }, []); // 같은 목록이면 같은 Set 유지 — 15초 폴마다 알림함 재조회·전체 메시지 재렌더가 두 번씩 돌던 것(검수 #683)
  useEffect(() => { if (uid) loadBlocked(); }, [uid, loadBlocked, syncEpoch]); // 차단은 내가 바꿀 때 onFriendsChanged가 다시 읽는다
  const onFriendsChanged = useCallback(() => Promise.all([loadFriends(), loadBlocked()]), [loadFriends, loadBlocked]);
  const blockUser = useCallback(async (id) => { await q(supabase.rpc('msgr_friend_remove', { other: id, block: true })); await onFriendsChanged(); setNote(t('friends.blocked')); }, [onFriendsChanged, t]);
  const [mutedCrewIds, setMutedCrewIds] = useState(() => new Set()); // 크루·봇 숨기기(App Store 1.2, 2026-09-26) — 사람 차단과 같은 표(msgr_user_blocks)를 재사용
  const loadMutedCrews = useCallback(async () => { const rows = await q(supabase.rpc('msgr_my_muted_crews')).catch(() => null); if (!rows) return; const next = new Set(rows.map((r) => r.crew_id)); setMutedCrewIds((cur) => (cur.size === next.size && [...next].every((id) => cur.has(id)) ? cur : next)); }, []);
  // 3차 검수 L-2(2026-09-27) — 값은 본인이 바꿀 때만 달라진다. 15초 tick(다른 화면 새로고침용 공용 심박)에 얹혀
  // 같이 돌던 것을 빼고, 처음 불러올 때·본인이 바꿀 때(muteCrew·unmuteCrew가 직접 다시 부른다)·포그라운드
  // 복귀(resumeEpoch)로만 좁힌다.
  useEffect(() => { if (uid) loadMutedCrews(); }, [uid, resumeEpoch, loadMutedCrews]);
  const muteCrew = useCallback(async (crewId) => { await q(supabase.rpc('msgr_mute_crew', { crew: crewId })); await loadMutedCrews(); setNote(t('crew.muted')); }, [loadMutedCrews, t]);
  const unmuteCrew = useCallback(async (crewId) => { await q(supabase.rpc('msgr_unmute_crew', { crew: crewId })); await loadMutedCrews(); setNote(t('crew.unmuted')); }, [loadMutedCrews, t]);
  const profanityFilterOn = useProfanityFilterOn();
  // App Store 5.1.2 재설계(2026-09-27, 유건 결정 "처음 한 번 필수 동의") — 로그인 뒤(기존 사용자는 업데이트 뒤 첫 실행)
  // 조직 공간에 들어가기 전 한 번 동의 화면. aiConsent: undefined=아직 모름(로딩 중), null=미동의(거부했거나 아직
  // 답하지 않음), string=동의 시각. 거부하면 조직 공간은 막고 개인 공간만 쓴다.
  const [aiConsent, setAiConsentState] = useState(undefined);
  // 3차 검수 L-3(2026-09-27) — 조회 중엔 조직 화면이 아니라 로딩 표시를 보여준다(orgConsentLoading). 조회가
  // 실패하면(예: 옛 서버·일시 장애) fail-open — aiConsentFailOpen이 로딩을 끝내고 게이트도 걸지 않는다.
  const [aiConsentFailOpen, setAiConsentFailOpen] = useState(false);
  const loadAiConsent = useCallback(async () => {
    try { setAiConsentState((await q(supabase.rpc('msgr_my_ai_consent'))) ?? null); setAiConsentFailOpen(false); }
    catch (e) { console.error('[argo] AI 동의 조회 실패 — 이 세션은 열어 둔다(fail-open):', e?.message ?? e); setAiConsentFailOpen(true); }
  }, []);
  // 3차 검수 L-2(2026-09-27) — 위와 같은 이유로 15초 tick에서 뺀다. 본인이 바꿀 때는 setAiConsent가 RPC 응답을
  // 바로 상태에 반영하므로 재조회가 필요 없다(처음 불러올 때·포그라운드 복귀만 남긴다).
  useEffect(() => { if (uid) loadAiConsent(); }, [uid, resumeEpoch, loadAiConsent]);
  const setAiConsent = useCallback(async (consent) => { const at = await q(supabase.rpc('msgr_set_ai_consent', { consent })); setAiConsentState(at ?? null); return at ?? null; }, []);
  const aiConsented = !!aiConsent; // 로딩 중(undefined)도 false — 동의 화면은 aiConsent!==undefined로 따로 가른다(로딩 깜빡임 방지)
  const safetyCtx = useMemo(() => ({ blocked: blockedIds, block: blockUser, mutedCrewIds, muteCrew, unmuteCrew, hiddenUserIds, hideUser, unhideUser, profanityFilterOn, aiConsented, aiConsentAt: aiConsent ?? null, aiConsentKnown: aiConsent !== undefined || aiConsentFailOpen, setAiConsent, onNote: setNote }), [aiConsentFailOpen, blockedIds, blockUser, mutedCrewIds, muteCrew, unmuteCrew, hiddenUserIds, hideUser, unhideUser, profanityFilterOn, aiConsented, aiConsent, setAiConsent]);
  const [botKinds, setBotKinds] = useState([]); // 내 에이전트 출처(헤르메스·오픈클로) — 훅은 조기 return보다 앞에(실측: 순서 오류로 빈 화면)
  useEffect(() => { if (!orgId || orgId === PERSONAL) { setBotKinds([]); return; } if (restoredSpace.current?.space === orgId) return; let live = true; q(supabase.from('msgr_bots').select('crew_id, kind').eq('org_id', orgId).is('revoked_at', null)).then((rows) => { if (live && activeOrg.current === orgId) setBotKinds(rows); }).catch(() => { if (live && activeOrg.current === orgId) setBotKinds([]); }); return () => { live = false; }; }, [orgId, syncEpoch]); // eslint-disable-line react-hooks/exhaustive-deps -- 봇 종류는 연결할 때 바뀐다 — 복귀·재연결 때만(15초 tick에서 뺐다, 기능 점검 D2)
  // 내가 참여한 채널(공개 포함) — 목록 필터의 근거. 조직 전환과 무관하게 계정 단위라 한 번만 읽는다.
  const joinedRef = useRef(new Set());
  const loadJoined = useCallback(async () => {
    if (!uid) return;
    const rows = await q(supabase.from('msgr_channel_members').select('channel_id').eq('member_kind', 'user').eq('member_id', uid)).catch(() => null);
    if (rows) joinedRef.current = new Set(rows.map((r) => r.channel_id));
  }, [uid]);
  useEffect(() => { if (uid) loadJoined().then(() => setTick((x) => x + 1)); }, [uid, loadJoined]); // 읽고 나서 목록을 한 번 다시 만든다
  const rt = useRef(null);
  const loadOrgs = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug, owner_user_id, service_user_id, node_seen_at, pending_owner_user_id, successor_user_id, auto_join_domain, auto_join_role, deleted_at, node_info)').eq('user_id', uid).is('removed_at', null));
    const list = rows.filter((r) => r.msgr_orgs && !r.msgr_orgs.deleted_at).map((r) => ({ id: r.org_id, role: r.role, ...r.msgr_orgs }));
    setOrgs(list);
    // 조직이 없고 마지막 공간 기록도 없는 사용자 — 개인 공간에 대화·친구가 있으면 거기서 시작한다(점검 A·B #1: 빈 조직 화면이 첫 화면이었다).
    // 그 확인 조회는 이 한 경우에만 한다. 아무 기록도 없는 새 사용자는 종전처럼 "새 조직·초대 코드" 안내(null)를 본다.
    const orgIds = list.map((o) => o.id);
    const personalHasContent = needsPersonalProbe({ personal: PERSONAL, cur: activeOrg.current, orgIds, last: readLastOrg() })
      && (await Promise.all([q(supabase.rpc('msgr_dm_personal_list', { include_groups: true })), q(supabase.rpc('msgr_my_friends'))]).then(([rows, fr]) => rows.length > 0 || fr.some((f) => f.status === 'accepted'), () => false));
    setOrgId((cur) => pickStartSpace({ personal: PERSONAL, cur, orgIds, last: readLastOrg(), personalHasContent }));
    setJoinable(await q(supabase.rpc('msgr_joinable_orgs')).catch(() => [])); // J-3: 내 이메일 도메인으로 들어갈 수 있는 조직(서버가 판정)
    setDeletedOrgs(await q(supabase.rpc('msgr_my_deleted_orgs')).catch(() => [])); // J-5: 내가 소유한 삭제 예정 조직(30일 안 복구 가능)
  }, [uid]);
  const restoreOrg = async (o) => {
    try { await q(supabase.rpc('msgr_restore_org', { org: o.id })); setNote(t('org.restore.done', { name: o.name })); await loadOrgs(); setOrgId(o.id); }
    catch (e) { setErr(/msgr_restore_expired/.test(e.message) ? t('org.restore.expired') : e.message); }
  };
  const joinDomain = async (o) => {
    try { await q(supabase.rpc('msgr_join_by_domain', { org: o.id })); setNote(t('org.joined')); await loadOrgs(); setOrgId(o.id); }
    catch (e) { setErr(/msgr_seat_limit/.test(e.message) ? t('seat.limit') : e.message); }
  };
  useEffect(() => { // 초대 링크 수락(?invite=code)
    const code = new URLSearchParams(location.search).get('invite');
    (async () => {
      try {
        await loadOrgs();
        if (code) { history.replaceState(history.state, '', location.pathname); const hint = await joinByCode(code); if (hint) setErr(t(hint)); } // 붙여 넣기와 같은 길 — 미리보기 → 참여 → 첫 채널(서버에 미리보기가 없으면 바로 수락)
      } catch (e) { setErr(/msgr_seat_limit/.test(e.message) ? t('seat.limit') : e.message); await loadOrgs().catch(() => {}); }
    })();
  }, [loadOrgs]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadOrg = useCallback(async (id) => {
    if (!id || id !== activeOrg.current) return;
    const current = orgRequests.current.begin(id);
    try {
    const [allChs, mems, allCrews, e, pol, joined] = await Promise.all([
      q(supabase.from('msgr_channels').select('id, kind, name, topic, crew_memory, personal_crews, created_by, admin_user_ids, excluded_user_ids, excluded_crew_ids').eq('org_id', id).is('archived_at', null).order('created_at')),
      q(supabase.from('msgr_org_members').select('user_id, role, display_name, expires_at').eq('org_id', id).is('removed_at', null)),
      // 크루 목록 — face(얼굴 고르기, 2026-09-24)는 옛 서버(열 없음)에 없을 수 있다. 없다는 오류(스키마 캐시에 없음·열 없음)면 그 열만 빼고 다시 읽어(다른 열은 이미 옛 서버에서도 됐다) 목록이 통째로 비지 않게 한다.
      (async () => {
        const cols = 'id, owner_user_id, slug, display_name, role_text, hosting, status, allow, allow_users, last_seen_at, folder, created_at, avatar_url, bio, commands';
        if (Date.now() - faceCol.missingAt > 600_000) try { const rows = await q(supabase.from('msgr_crews').select(`${cols}, face`).eq('org_id', id).in('status', ['active', 'available'])); return rows.map((r) => ('face' in r ? r : { ...r, face: null })); }
        catch (err) { const msg = err?.message ?? ''; if (!/face/i.test(msg) || !/schema cache|does not exist|could not find/i.test(msg)) throw err; faceCol.missingAt = Date.now(); } // 한 번 확인하면 기억 — 15초 재조회마다 실패할 요청을 다시 보내지 않는다(검수 #704 L-3, DB 위생)
        const rows = await q(supabase.from('msgr_crews').select(cols).eq('org_id', id).in('status', ['active', 'available'])); return rows.map((r) => ({ ...r, face: null }));
      })(),
      supabase.from('msgr_org_entitlements').select('plan, seats, ls_status, trial_ends_at, paid_until').eq('org_id', id).maybeSingle().then((r) => r.data ?? null),
      supabase.from('msgr_org_policies').select('allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by, approver_user_ids, crew_create, crew_runner, crew_model, guest_seats').eq('org_id', id).maybeSingle().then((r) => r.data ?? null), // H-0 조직 정책(없으면 null = 잠금 없음),
      // 내가 참여한 채널 — 15초 재조회·조직 전환·코드 가입 때마다 새로 읽는다(한 번만 읽어 남이 나를 공개 채널에 넣거나 초대로 들어와도 새로고침 전까지 사이드바에 안 뜨던 것, 검수 재현 2026-09-18). 같은 Promise.all이라 조직 전환 경쟁에 await를 더하지 않는다
      uid ? q(supabase.from('msgr_channel_members').select('channel_id').eq('member_kind', 'user').eq('member_id', uid)).catch(() => null) : null
    ]);
    if (!current()) return;
    if (joined) joinedRef.current = new Set(joined.map((r) => r.channel_id)); // 늦게 온 옛 요청은 위 current()가 이미 버렸다 — 참여 버튼의 낙관적 추가를 덮지 않는다
    loadedOrg.current = id;
    const fetchedCrews = stampFetched(withoutCopies(allCrews)); // 충돌 사본은 크루 목록에 넣지 않는다(mention-candidates.mjs withoutCopies) // 접속 판정 기준 시각(presence-clock.mjs)
    setMyAvailable(fetchedCrews.filter((r) => r.status === 'available' && r.owner_user_id === uid).sort((x, y) => x.display_name.localeCompare(y.display_name, 'ko')));
    const crs = fetchedCrews.filter((r) => r.status === 'active');
    const orgRow = orgs.find((o) => o.id === id);
    crs.sort(crewOrder((c) => crewTier(c, orgRow) === 'company')); // 순서 고정: 회사 크루 먼저, 이름순(QA: 화면마다 순서가 달랐다), 같은 이름이면 충돌 사본을 뒤로(mention-candidates.mjs)
    // 조직에 들어왔다고 모든 채널이 열리지 않는다(유건 2026-09-16, 슬랙식) — 사이드바는 **참여한 채널**만.
    // 공개 채널은 서버가 열람은 허용하지만(찾아보기·미리보기), 들어가기 전에는 목록에도 알림에도 없다.
    // 참여 목록은 위 Promise.all에서 같이 읽는다 — 따로 await를 더하면 조직 전환 경쟁(늦게 온 A 데이터 무시)이 흐트러진다.
    const chs = allChs.filter((c) => c.kind !== 'public' || joinedRef.current.has(c.id));
    const preview = allChs.filter((c) => c.kind === 'public' && !joinedRef.current.has(c.id));
    setChannels(chs); setPreviewChannels(preview); setMembers(mems); setCrews(crs); setEnt(e); setPolicy(pol);
    // 미리보기로 연 채널도 유지한다 — 15초마다 다시 읽을 때 첫 채널로 튕기지 않게
    setChId((cur) => { const has = (x) => x && (chs.some((c) => c.id === x) || preview.some((c) => c.id === x) || !!archivedRoomFor(earlierRoomRef.current, { orgId: id, chId: x })); if (has(cur)) return cur; const last = readLastCh(id); return has(last) ? last : (chs[0]?.id ?? null); }); // 라벨용 보조 조회보다 먼저(검수 2R LOW-1: 보조 조회가 던지면 채널 선택이 안 됐다)
    const dmIds = chs.filter((c) => c.kind === 'dm').map((c) => c.id);
    if (dmIds.length) { try { const rows = await q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id, added_at').in('channel_id', dmIds)); const map = {}; for (const r of rows) (map[r.channel_id] ??= []).push(r); if (current()) setDmMembers(map); } catch { if (current()) setDmMembers({}); } } else setDmMembers({});
    return chs; // 호출한 쪽이 방금 새로 생긴 채널을 즉시 찾을 수 있게(state 반영을 기다리지 않는다)
    } catch (error) { if (current()) throw error; }
  }, [orgs, uid]);
  // ── 개인 공간 로더: 친구와의 개인 1:1 목록을 조직 로더와 같은 모양(channels·members 상태)으로 채운다 ──
  const loadPersonal = useCallback(async () => {
    if (activeOrg.current !== PERSONAL) return;
    const current = orgRequests.current.begin(PERSONAL);
    try {
      const rows = await q(supabase.rpc('msgr_dm_personal_list', { include_groups: true })); // 인자 없는 옛 앱은 1:1만 받는다 — 그룹을 가짜 1:1로 그리지 않게(검수 MEDIUM-4)
      if (!current()) return;
      const friendsList = await q(supabase.rpc('msgr_my_friends')).catch(() => []);
      if (!current()) return;
      // 개인 공간 에이전트(2026-09-30): 내 개인 크루 + 내가 든 개인 방의 크루(친구 것 포함 — 표시용 열만). 옛 서버(함수 없음)면 크루 없이 종전대로.
      const roomCrewsAll = stampFetched((await q(supabase.rpc('msgr_personal_room_crews')).catch(() => [])).filter((c) => c.status === 'active'));
      const roomCrews = withoutCopies(roomCrewsAll); // 고르기·멘션 후보에서만 사본을 뺀다 — 방 이름은 사본이어도 그 이름으로('?'가 됐다, 재검수 #826 NEW-2)
      if (!current()) return;
      const accepted = friendsList.filter((f) => f.status === 'accepted');
      const chs = rows.map((r) => ({ // 그룹 방(친구 여럿, 유건 2026-09-17)은 members가 셋 이상 — 이름은 dmName이 구성원으로 짓는다
        id: r.channel_id, kind: 'dm', name: r.crew_dm ? `dm:${roomCrewsAll.find((c) => c.id === r.crew_dm)?.display_name || '?'}` : r.is_group && r.name ? r.name : `dm:${accepted.find((f) => f.user_id === r.other_user_id)?.display_name || r.other_user_id?.slice(0, 8) || '?'}`,
        org_id: null, created_by: r.is_group ? (r.created_by ?? uid) : uid, /* 1:1은 종전대로 나(두 사람 모두 관리 — 에이전트 넣기 결재자는 서버 msgr_dm_approver) */ _personal_group: !!r.is_group, _personal_crew: r.crew_dm ?? null, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: 'approval', // 개인 방도 내 에이전트를 넣는다(2026-09-30) — 방을 연 사람은 바로, 다른 사람은 요청(서버 msgr_crew_join)
        _personal_other: r.other_user_id, _personal_last_at: r.last_at, _personal_last_body: r.last_body,
      }));
      const mems = accepted.map((f) => ({ user_id: f.user_id, role: 'friend', display_name: f.display_name || f.handle || f.user_id.slice(0, 8) }));
      const dmMem = {};
      const names = {};
      for (const [i, ch] of chs.entries()) {
        const ms = rows[i].members; // 옛 서버(구성원 열 없음)는 나와 상대 한 명으로 본다
        dmMem[ch.id] = [...(ms ?? [{ id: uid }, { id: ch._personal_other }]).map((m) => { if (m.name) names[m.id] = m.name; return { channel_id: ch.id, member_kind: 'user', member_id: m.id }; }),
          ...(rows[i].crews ?? []).map((c) => ({ channel_id: ch.id, member_kind: 'crew', member_id: c.id }))]; // 방에 든 에이전트(개인 공간 2026-09-30)
      }
      loadedOrg.current = PERSONAL;
      setChannels(chs); setPreviewChannels([]); setMembers(mems); setCrews(roomCrews); setEnt(null); setPolicy(null);
      setMyAvailable([]); setDmMembers(dmMem); setOtherNames(names);
      setChId((cur) => { const has = (x) => x && chs.some((c) => c.id === x); if (has(cur)) return cur; const last = readLastCh(PERSONAL); return has(last) ? last : (chs[0]?.id ?? null); });
      setFriends(friendsList);
      // 차단한 사람이 구성원인 방만 마지막 글의 작성자를 읽는다 — 목록 RPC는 본문만 줘서 미리보기를 가릴 수 없었다(D7). 그런 방이 없으면 요청 0.
      const blockedNow = notifyRef.current.blocked ?? new Set();
      const risky = chs.filter((ch, i) => (rows[i].members ?? []).some((m) => blockedNow.has(m.id))).map((ch) => ch.id);
      if (risky.length) {
        const last = await q(supabase.from('msgr_messages').select('id, channel_id, body, author_user_id, crew_id, created_at').in('channel_id', risky).is('deleted_at', null).order('id', { ascending: false }).limit(Math.min(200, risky.length * 20))).catch(() => []);
        if (current()) { const lm = {}; for (const m of last) if (!lm[m.channel_id]) lm[m.channel_id] = { body: plainPreview(m.body), mine: m.author_user_id === uid, userId: m.author_user_id ?? null, crewId: m.crew_id ?? null, at: Date.parse(m.created_at) }; setLastMsg((cur) => ({ ...cur, ...lm })); }
      }
      return chs;
    } catch (error) { if (current()) throw error; }
  }, [uid]);
  useEffect(() => { if (restoredSpace.current?.space === orgId) return; if (isPersonal) loadPersonal().catch((e) => setErr(e.message)); else loadOrg(orgId).catch((e) => setErr(e.message)); }, [orgId, isPersonal, loadOrg, loadPersonal]); // 저장 목록으로 연 공간은 다시 읽지 않는다(D3)
  // 목록에 없는 방의 글(새 1:1·그룹·비공개 채널의 첫 글, D4) — 그 방 하나만 불러와 목록에 넣는다. 개인 공간은 목록 RPC가 한 번에 주므로 그 목록을 다시 읽는다.
  // 같은 방은 한 번만 묻는다(공개 채널·보관 채널처럼 넣지 않는 방이 방송마다 조회를 부르지 않게). 복귀·재연결 때 비운다.
  // 물어봤음(roomAsked)은 조회가 끝난 뒤에 적는다 — 조회가 실패한 새 방의 다음 글이 다시 묻고 안 읽음 재집계에도 들어가게(검수 L7). 묻는 중(roomAsking)은 겹쳐 묻지 않게
  const roomAsked = useRef(new Set()); const roomAsking = useRef(new Set());
  const addRoom = useRef(async () => {});
  addRoom.current = async (cid) => {
    if (roomAsked.current.has(cid) || roomAsking.current.has(cid)) return;
    const space = activeOrg.current;
    roomAsking.current.add(cid); let row;
    try {
      if (space === PERSONAL) { await loadPersonal(); roomAsked.current.add(cid); return; }
      row = await q(supabase.from('msgr_channels').select('id, kind, name, topic, crew_memory, personal_crews, created_by, admin_user_ids, excluded_user_ids, excluded_crew_ids, org_id, archived_at').eq('id', cid).maybeSingle());
      roomAsked.current.add(cid);
    } catch { return; } finally { roomAsking.current.delete(cid); }
    if (!row || row.archived_at || row.org_id !== space || row.kind === 'public' || activeOrg.current !== space) return; // 공개 채널은 참여 전엔 목록에 없다
    const mem = row.kind === 'dm' ? await q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id, added_at').eq('channel_id', cid)).catch(() => []) : null;
    if (activeOrg.current !== space) return;
    const { org_id: _o, archived_at: _a, ...ch } = row;
    setChannels((cur) => (cur.some((c) => c.id === cid) ? cur : [...cur, ch]));
    if (mem) setDmMembers((m) => ({ ...m, [cid]: mem }));
  };
  useEffect(() => {
    if (!isMobilePlatform) return;
    return observeMobileResume(() => { setOnline(navigator.onLine !== false); setResumeEpoch((x) => x + 1); linkRef.current.watch?.resumed(); bumpSync(); setTick((x) => x + 1); resyncBadge(); }); // 목록 다시 읽기는 아래 syncEpoch 효과가 한 번(끊겼던 구독이 다시 붙어도 또 읽지 않게 resumed)
  }, [orgId, isPersonal, loadOrg, loadPersonal]);
  useEffect(() => { // 데스크톱: 30초 넘게 가려졌다가 돌아오면 방송이 없는 값을 한 번 다시 읽는다(주기 없음 — 기능 점검 D2)
    if (isMobilePlatform) return undefined;
    let hiddenAt = 0;
    const on = () => { if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; } if (hiddenAt && Date.now() - hiddenAt >= 30_000) bumpSync(); hiddenAt = 0; };
    document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => { if (syncEpoch) (isPersonal ? loadPersonal() : loadOrg(orgId)).catch((e) => setErr(e.message)); }, [syncEpoch]); // eslint-disable-line react-hooks/exhaustive-deps -- 복귀·재연결 때 지금 공간 목록 한 번
  // 부록 M: 그 자리 파견 — available → active → 채널 멤버(+소유자 동반). 채널 없이 부르면 조직에만 파견.
  // available은 소유자가 파견을 해제한 상태(20260908140000)라 다시 파견은 복귀다 — 허용 범위는 건드리지 않는다(D31: 「모두」가 조용히
  // 조직 기본값으로 바뀌었다). 잠금 정책이면 서버 게이트(msgr_crew_policy_gate)와 잠글 때의 일괄 맞춤이 기본값을 보장한다.
  const dispatchCrew = useCallback(async (crew, channelId = null) => {
    const up = await supabase.from('msgr_crews').update({ status: 'active' }).eq('id', crew.id).select('id');
    if (up.error) throw new Error(up.error.message);
    // 채널에 넣는 것은 서버 규칙 한 곳(msgr_crew_join)으로 — 방장이면 바로, 참여자는 채널 정책대로(바로/방장 승인), 채팅은 결재자면 바로·아니면 요청.
    let joined = null;
    if (channelId) {
      const res = await supabase.rpc('msgr_crew_join', { ch: channelId, crew: crew.id });
      if (res.error) throw new Error(joinErr(res.error.message, t));
      joined = res.data;
    }
    await loadOrg(orgId);
    return joined; // 'joined' | 'requested' | 'already' | null(조직에만 파견)
  }, [uid, orgId, loadOrg, t]);
  const loadChMembers = useCallback(async (id) => { if (id !== activeChannel.current) return; const current = memberRequests.current.begin(`${activeOrg.current}:${id}`); if (!id) { setChMembers([]); return; } try { const rows = await q(supabase.from('msgr_channel_members').select('member_kind, member_id, added_by').eq('channel_id', id)); if (current()) setChMembers(rows); } catch { if (current()) setChMembers([]); } }, []);
  const chMembersWanted = !isPhone || page === 'chat'; // 폰 목록 뒤에는 대화방을 그리지 않는다 — 구성원도 방을 열 때 읽는다(기능 점검 D3)
  useEffect(() => { if (!chMembersWanted) return; loadChMembers(chId).catch(() => setChMembers([])); }, [chId, loadChMembers, syncEpoch, membersEpoch, chMembersWanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sheetReqTick, setSheetReqTick] = useState(0); // 열린 설정창의 참여 요청을 다시 읽게
  const sheetAfterNav = useRef(false); // 알림함의 에이전트 참여 요청 → 그 채널로 가서 설정을 연다
  useEffect(() => { setChSheet(sheetAfterNav.current); sheetAfterNav.current = false; }, [chId]); // 채널을 바꿀 때만 닫는다(검수 HIGH-1: tick 의존이면 15초마다 시트가 닫혔다)
  const [unread, setUnread] = useState({}); const [muted, setMuted] = useState(() => new Set()); const [pinned, setPinned] = useState(() => new Set()); /* 즐겨찾기(고정) — msgr_channel_prefs.pinned(유건 2026-09-12) */ const [pinPos, setPinPos] = useState(() => new Map()); /* 즐겨찾기 순서(pin_pos, 2026-09-12). 채널 그룹(folder)은 뺐다 — 유건 2026-09-16, 라이브 사용 0명 */ const [quiet, setQuiet] = useState(null); // P0(2026-09-09): 채널별 안 읽음·음소거·조용한 시간
  const [unreadSpace, setUnreadSpace] = useState(null); // unread가 어느 공간의 셈인가 — 공간을 막 바꿔 아직 못 읽었으면 탭 뱃지는 서버 합계로(phone-shell.mjs tabBadges)
  const [dmSortPos, setDmSortPos] = useState(() => ({})); // DM 탭 '직접 배치' 순서(msgr_channel_prefs.sort_pos, 유건 확정 2026-09-29) — 즐겨찾기 pin_pos와 별개
  // 안 읽음 — org=null이면 개인 공간(조직 밖 1:1)을 센다(검수 L-1)
  const readCursor = useMemo(() => createReadCursor(), [uid]); // 이 기기의 읽음 커서 저장(read-sync.mjs) — 실패한 위치는 다음 기회에 다시 쓴다(MSG-05)
  const loadUnread = useCallback(async () => { if (!orgId || orgId !== activeOrg.current) return; const current = unreadRequests.current.begin(orgId); const since = Date.now(); const rows = await q(supabase.rpc('msgr_unread', { org: orgId === PERSONAL ? null : orgId })).catch(() => null); if (rows && current()) { setUnread(readCursor.unreadFrom(rows, since, activeChannel.current)); setUnreadSpace(orgId); } }, [orgId, readCursor]); // 물은 뒤 이 기기가 읽음으로 저장한 방은 0(열린 방 배지 경합)
  // 새 글 방송 → 안 읽음 다시 세기는 1.5초 창에 한 번(MSG-08 — 글마다 RPC 1건이던 것). 기기 N대 × 분당 글 M건이 분당 N×M건 → 기기당 분당 최대 40건, 몰아 온 글은 1건.
  // 내 글·참여하지 않은 공개 채널 글은 세지 않는다(unreadWorthy). 공간을 바꾸면 예약을 버린다(새 공간은 위 효과가 센다)
  const loadUnreadRef = useRef(loadUnread); loadUnreadRef.current = loadUnread;
  const unreadSoon = useMemo(() => createCoalescer(() => { loadUnreadRef.current().catch(() => {}); }), []);
  useEffect(() => () => unreadSoon.cancel(), [orgId, unreadSoon]);
  useEffect(() => { const r = restoredSpace.current; if (r?.space === orgId && r.sync === syncEpoch) return; loadUnread(); }, [loadUnread, syncEpoch]); // eslint-disable-line react-hooks/exhaustive-deps -- 새 글 방송은 아래 event 효과가 다시 센다. 저장본으로 연 공간은 건너뛴다(D3)
  useEffect(() => { if (!uid) return; let live = true; const revision = prefQueue.current.revision; q(supabase.from('msgr_channel_prefs').select('channel_id, muted, pinned, pin_pos, sort_pos').eq('user_id', uid)).then((rows) => { if (!live || prefQueue.current.busy || revision !== prefQueue.current.revision) return; setMuted(new Set(rows.filter((r) => r.muted).map((r) => r.channel_id))); setPinned(new Set(rows.filter((r) => r.pinned).map((r) => r.channel_id))); setPinPos(new Map(rows.filter((r) => r.pin_pos != null).map((r) => [r.channel_id, r.pin_pos]))); setDmSortPos(Object.fromEntries(rows.filter((r) => r.sort_pos != null).map((r) => [r.channel_id, r.sort_pos]))); }).catch(() => {}); q(supabase.from('msgr_profiles').select('quiet_from, quiet_to').eq('user_id', uid).maybeSingle()).then((p) => { if (live) setQuiet(p && p.quiet_from != null && p.quiet_to != null ? { from: p.quiet_from, to: p.quiet_to } : null); }).catch(() => {}); return () => { live = false; }; }, [uid, prefsEpoch, syncEpoch]);
  const savePrefs = async (patches) => {
    if (!patches.length) return;
    try { await prefQueue.current.enqueue(() => q(supabase.from('msgr_channel_prefs').upsert(patches.map((patch) => ({ ...patch, user_id: uid, updated_at: new Date().toISOString() }))))); }
    finally { bumpPrefs(); }
  };
  const toggleMute = async (c) => { const on = !muted.has(c.id); setMuted((s) => { const n = new Set(s); if (on) n.add(c.id); else n.delete(c.id); return n; }); flash(flashKey('mute', on)); try { await savePrefs([{ channel_id: c.id, muted: on }]); } catch (e) { setErr(e.message); } }; // 폰은 누르는 즉시 토스트(유건 2026-10-02 "눌러도 아무 표시가 없음") — 화면 상태와 같이 바로, 저장이 실패하면 오류 토스트가 덮는다
  const togglePin = async (c) => { const on = !pinned.has(c.id); setPinned((st) => { const n = new Set(st); if (on) n.add(c.id); else n.delete(c.id); return n; }); flash(flashKey('fav', on)); try { await savePrefs([{ channel_id: c.id, pinned: on }]); } catch (e) { setErr(e.message); } };
  // 내가 쓸 때(bumpPrefs)·복귀 때만 읽는다 — 주기 없음(기능 점검 D2).
  const [targetPrefs, setTargetPrefs] = useState([]);
  const [favoriteBusy, setFavoriteBusy] = useState(false); const favoriteLock = useRef(false);
  useEffect(() => {
    if (restoredSpace.current?.space !== orgId) setTargetPrefs([]);
  }, [uid, orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!uid || !orgId || orgId === PERSONAL) { setTargetPrefs([]); return; }
    { const r = restoredSpace.current; if (r?.space === orgId && r.prefs === prefsEpoch && r.sync === syncEpoch) return; } // 저장본(D3) — 내가 설정을 바꾸면 다시 읽는다
    let live = true; const revision = prefQueue.current.revision;
    q(supabase.from('msgr_target_prefs').select('target_kind, target_id, pinned, pin_pos, sort_pos').eq('user_id', uid).eq('org_id', orgId))
      .then((rows) => { if (live && activeOrg.current === orgId && !prefQueue.current.busy && revision === prefQueue.current.revision) setTargetPrefs(rows); })
      .catch((e) => { if (live && activeOrg.current === orgId) setErr(friendlyErr(e.message, t)); });
    return () => { live = false; };
  }, [uid, orgId, prefsEpoch, syncEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const targetPinned = (kind, id) => targetPrefs.some((p) => p.target_kind === kind && p.target_id === id && p.pinned);
  const saveTargetPrefs = async (patches) => {
    if (!patches.length) return;
    await q(supabase.from('msgr_target_prefs').upsert(patches.map((p) => ({ ...p, user_id: uid, org_id: orgId }))));
  };
  const toggleTargetPin = async (kind, id) => {
    if (favoriteLock.current) return;
    favoriteLock.current = true; setFavoriteBusy(true);
    const on = !targetPinned(kind, id);
    try {
      await prefQueue.current.enqueue(() => saveTargetPrefs([{ target_kind: kind, target_id: id, pinned: on }]));
      if (activeOrg.current === orgId) setTargetPrefs((rows) => [...rows.filter((p) => p.target_kind !== kind || p.target_id !== id), { target_kind: kind, target_id: id, pinned: on, pin_pos: rows.find((p) => p.target_kind === kind && p.target_id === id)?.pin_pos ?? null }]);
    } catch (e) { setErr(friendlyErr(e.message, t)); }
    finally { favoriteLock.current = false; setFavoriteBusy(false); bumpPrefs(); }
  };
  // 폰 채널 탭 그룹(유건 확정 2026-10-02) — 나만 보이고(내 기기끼리 맞춰짐) 조직 공간마다 따로, 채널 하나는 그룹 하나에만(phone-lists.mjs).
  // 폰이 조직 공간을 열 때·앞으로 올 때(syncEpoch) 그룹과 연결을 한 요청으로 한 번 읽는다. 폴링·방송 없음, 바꿀 때만 쓴다. 데스크톱은 읽지 않는다
  const [groupsBy, setGroupsBy] = useState({}); // 조직 id → { groups, links } — 공간을 오가도 마지막 값을 먼저 보여 준다(칩이 깜빡이지 않게)
  const [chMenu, setChMenu] = useState('channels'); // 채널 탭 메뉴: 'fav' | 'channels' | 'g:<id>'
  const [grpSheet, setGrpSheet] = useState(null); // { mode: 'new' } | { mode: 'edit', id } | { mode: 'pick', channelId }
  useEffect(() => {
    if (!isPhone || !uid || !orgId || orgId === PERSONAL) return;
    let live = true; const org = orgId;
    q(supabase.from('msgr_channel_groups').select('id, name, pos, created_at, msgr_channel_group_links(channel_id)').eq('org_id', org))
      .then((rows) => { if (!live) return; setGroupsBy((m) => ({ ...m, [org]: { groups: rows.map(({ msgr_channel_group_links: _l, ...g }) => g), links: rows.flatMap((g) => (g.msgr_channel_group_links ?? []).map((l) => ({ channel_id: l.channel_id, group_id: g.id }))) } })); })
      .catch((e) => { if (live) pushDiag('ch-groups', e?.message ?? String(e)); });
    return () => { live = false; };
  }, [uid, orgId, isPhone, syncEpoch]);
  const NO_GROUPS = { groups: [], links: [] };
  const grp = groupsBy[orgId] ?? NO_GROUPS;
  const setGrp = (org, fn) => setGroupsBy((m) => ({ ...m, [org]: fn(m[org] ?? NO_GROUPS) }));
  const groupErr = (e) => setErr(/msgr_group_limit/.test(e.message) ? t('grp.limit') : /duplicate key|unique/.test(e.message) ? t('grp.name.taken') : friendlyErr(e.message, t));
  const putInGroup = async (org, links, ids, groupId) => { // 넣기·옮기기(다른 그룹에서 옮겨 오는 것 포함) — 이미 그 그룹이면 쓰지 않는다
    const rows = ids.filter((id) => linkChange(links, id, groupId).op !== 'none').map((id) => ({ user_id: uid, channel_id: id, group_id: groupId }));
    if (!rows.length) return;
    await q(supabase.from('msgr_channel_group_links').upsert(rows));
    setGrp(org, (g) => ({ ...g, links: [...g.links.filter((l) => !rows.some((r) => r.channel_id === l.channel_id)), ...rows.map((r) => ({ channel_id: r.channel_id, group_id: groupId }))] }));
  };
  const createGroup = async (rawName, channelIds = []) => {
    const org = orgId; const name = cleanGroupName(rawName);
    if (!name || !org || org === PERSONAL) return null;
    if (groupNameTaken(grp.groups, name)) { setErr(t('grp.name.taken')); return null; }
    try { // 그룹을 만들었는데 채널 넣기만 실패하면 만든 그룹은 목록·메뉴에 두고 넣기 실패만 알린다 — 시트가 실패로 남으면 다시 누를 때 '같은 이름' 오류가 났다(분리 검수 L-4)
      const { row, linkError } = await createGroupFlow({
        insertGroup: async () => { const [r] = await q(supabase.from('msgr_channel_groups').insert({ user_id: uid, org_id: org, name, pos: nextGroupPos(grp.groups) }).select('id, name, pos, created_at')); setGrp(org, (g) => ({ ...g, groups: [...g.groups, r] })); return r; },
        linkChannels: (r) => putInGroup(org, grp.links, channelIds, r.id),
      });
      if (linkError) setErr(t('grp.linkFail', { name }));
      else flash('grp.created', { name });
      return row;
    } catch (e) { groupErr(e); return null; }
  };
  const saveGroup = async (g, rawName, checked) => {
    const org = orgId; const name = cleanGroupName(rawName);
    if (!name) return false;
    if (groupNameTaken(grp.groups, name, g.id)) { setErr(t('grp.name.taken')); return false; }
    const d = groupDiff(grp.links, g.id, checked);
    try {
      if (name !== g.name) { await q(supabase.from('msgr_channel_groups').update({ name }).eq('id', g.id)); setGrp(org, (s) => ({ ...s, groups: s.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) })); }
      await putInGroup(org, grp.links, d.add, g.id);
      if (d.remove.length) { await q(supabase.from('msgr_channel_group_links').delete().eq('user_id', uid).eq('group_id', g.id).in('channel_id', d.remove)); setGrp(org, (s) => ({ ...s, links: s.links.filter((l) => !(l.group_id === g.id && d.remove.includes(l.channel_id))) })); }
      flash('grp.saved'); return true;
    } catch (e) { groupErr(e); return false; }
  };
  const deleteGroup = async (g) => { // 그룹만 지운다 — 연결은 서버에서 함께 사라지고(cascade) 채널은 '채널' 메뉴로 돌아간다
    const org = orgId;
    try {
      await q(supabase.from('msgr_channel_groups').delete().eq('id', g.id));
      setGrp(org, (s) => ({ groups: s.groups.filter((x) => x.id !== g.id), links: s.links.filter((l) => l.group_id !== g.id) }));
      flash('grp.deleted'); return true;
    } catch (e) { groupErr(e); return false; }
  };
  const moveChannel = async (channelId, groupId) => { // 채널 줄 '그룹에 넣기' — 한 채널을 한 그룹으로(groupId null = 빼기)
    const org = orgId; const ch = linkChange(grp.links, channelId, groupId);
    if (ch.op === 'none') return;
    try {
      if (ch.op === 'upsert') await putInGroup(org, grp.links, [channelId], groupId);
      else { await q(supabase.from('msgr_channel_group_links').delete().eq('user_id', uid).eq('channel_id', channelId)); setGrp(org, (s) => ({ ...s, links: s.links.filter((l) => l.channel_id !== channelId) })); }
      flash(groupId ? 'grp.moved' : 'grp.removed', { name: grp.groups.find((x) => x.id === groupId)?.name ?? '' });
    } catch (e) { groupErr(e); }
  };
  const toggleMemory = async (c) => { const r = await supabase.from('msgr_channels').update({ crew_memory: c.crew_memory === false }).eq('id', c.id).select('id'); if (r.error) return setErr(friendlyErr(r.error.message, t)); if (!r.data?.length) return setErr(t('err.denied')); setNote(t(c.crew_memory === false ? 'ch.memory.nowOn' : 'ch.memory.nowOff')); loadOrg(orgId).catch(() => {}); }; // 권한 최종 판정은 RLS(msgr_can_manage_channel)·정책 트리거
  // 읽음 커서 저장 — 같은 값을 다시 쓰지 않고(기능 점검 D2: 초점·가시성 바뀔 때마다 upsert), 실패한 위치는 다음 초점·가시성·새 글 때 다시 쓴다(MSG-05). 폰 아이콘은 저장된 뒤 서버 숫자로
  // 이전 대화 보기로 연 보관 방(유건 결정 2026-10-08 1-②)은 새 글이 오지 않는다 — 안 읽은 글이 있었을 때만 한 번 올리고(줄의 '안 읽은 n개'를 지운다, 검수 #857 MEDIUM)
  // 없었으면 쓰지 않는다(DB 쓰기 0). 그 밖의 방은 종전대로. earlierAsked는 아래(이전 대화 보기)에서 만든 세션 기억 — 다시 묻지 않고 그 줄만 고친다
  const markRead = useCallback(async (channelId, lastId) => { const step = archivedReadStep(earlierRoomRef.current, channelId); if (step === 'skip') return; if (step === 'once') { const er = { ...earlierRoomRef.current, unread: 0 }; earlierRoomRef.current = er; setEarlierRoom(er); for (const [k, p] of earlierAsked.current) earlierAsked.current.set(k, p.then((l) => clearEarlierUnread(l, channelId))); } setUnread((u) => (u[channelId]?.n ? { ...u, [channelId]: { n: 0, mention: 0 } } : u)); const w = readCursor.begin(channelId, lastId); if (!w) return; try { await q(supabase.from('msgr_reads').upsert({ channel_id: channelId, user_id: uid, last_read_id: lastId, updated_at: new Date().toISOString() })); } catch { w.fail(); return; } w.ok(); iconBadge?.request(); }, [uid, iconBadge, readCursor]);
  // event.kind는 '무슨 방송인가'(message·approval·reaction·edit)다. 서버 payload에도 kind가 있는데
  // 그건 '글 종류'(text·system)다. 전개를 뒤에 두면 후자가 전자를 덮어 방송이 통째로 버려진다 —
  // 그래서 구분자는 항상 전개 **뒤**에 놓고, 글 종류는 msgKind로 따로 싣는다.
  const [event, setEvent] = useState(null); const [typing, setTyping] = useState({}); const [progress, setProgress] = useState({}); const [received, setReceived] = useState({}); // received = 크루 기기가 내 글을 받았다는 신호(키 channel:crew → 받은 시각) — 보낸 뒤 대기 표시(await-reply.mjs)만 쓴다 // progress = 실행 카드(단계·도구·사고 과정) 스냅샷, 키 channel:crew
  const settledRef = useRef({}); // 키 → 크루 답글 도착 시각 — 답글 직후 늦게 온 방송이 표시를 되살리지 않게(typing-state.js)
  const seenMine = useMemo(() => new Map(), [uid]); // 내 글을 이 기기가 처음 본 시각(기기 시계) — 셸에 두어 방을 다시 열어도 '조금 오래' 판정이 이어진다(검수 L4·통합 재검수 LOW). 이 세션의 내 글 수만큼
  const crewPosts = useMemo(() => createCrewPostsMemory(), [uid]); // 방별 크루 마지막 글 — 방을 다시 열어도 남아 떠나 있는 동안 온 답으로 입력 중을 내린다(통합 재검수 MEDIUM)
  const typingStartRef = useRef({}); // 키 → "지금 이어지는 입력"을 처음 시작한 시각(typing-summary.mjs 정렬 기준) — 6초 창이 끊기면 다음은 새 시작(유건 확정 2026-09-29)
  const crewActive = (crewId) => { if (!crewId) return; setCrews((rows) => markSeen(rows, crewId)); setMyAgents((rows) => (rows ? markSeen(rows, crewId) : rows)); }; // 에이전트가 방금 무언가를 보냈다 — 요청 없이 '방금 봄'으로
  const onTypingEvent = ({ payload }) => {
    if (!acceptTyping(settledRef.current, payload)) return;
    crewActive(payload?.crew_id);
    const k = typingKey(payload); const now = Date.now();
    if (payload?.phase === 'received') { setReceived((m) => ({ ...m, [k]: now })); return; } // 게이트웨이가 잡을 받자마자 보내는 신호(2026-10-05) — 입력 중 말풍선은 아니다(거절·대기로 끝나는 잡이 유령 표시를 남기지 않게)
    setTyping((m) => {
      if (m[k] === undefined || now - m[k] >= TYPING_WINDOW_MS) typingStartRef.current[k] = now; // 직전 방송이 창 밖이면(끊겼다 재개) 새 시작
      return { ...m, [k]: now };
    });
  };
  const onProgressEvent = ({ payload }) => { if (acceptTyping(settledRef.current, payload)) setProgress((m) => ({ ...m, [typingKey(payload)]: { ...payload, at: Date.now() } })); crewActive(payload?.crew_id); }; // 진행 방송 = 그 에이전트가 켜져 있다(요청 없이 '방금 봄')
  const settleCrew = (payload) => { const k = typingKey(payload); settledRef.current[k] = Date.now(); setTyping((m) => withoutKey(m, k)); setProgress((m) => withoutKey(m, k)); setReceived((m) => withoutKey(m, k)); delete typingStartRef.current[k]; };
  // (조직 구독은 아래 '내가 속한 조직 전체 + u:' 효과 하나로 합쳤다 — 기능 점검 D3)
  // ── 열린 방의 채널 토픽 dm:<채널> 구독 — 개인 방과 조직의 비공개 방(DM·비공개 채널) ──
  // 비공개 방의 typing·progress는 조직 토픽이 아니라 이 토픽으로 온다(20260918190000 — 조직 토픽은 조직 전원이 들어 방의 존재·크루 활동이 샜다).
  // 옛 서버에서는 조직 방 typing이 org:로 계속 오고 이 토픽은 조용할 뿐이라 깨지지 않는다. 글은 handleMessage가 id로 한 번만 처리한다.
  // 목록의 '답변 중' 표시(유건 2026-09-23): 열린 방 하나만 구독하면 다른 방·다른 화면에서는 그 방의 typing을 못 받는다 → 이 공간의 비공개 방을 모두 구독한다.
  // 상한 50개(Realtime 연결당 채널 상한 여유) — 열린 방은 항상 포함. 방 집합이 바뀔 때만 다시 붙는다(방을 옮겨도 재구독 없음 — 열린 방이 이미 집합 안이면).
  const openKind = useMemo(() => (chId ? channels.find((c) => c.id === chId)?.kind ?? null : null), [channels, chId]);
  const roomTopic = !!chId && (isPersonal || (openKind !== null && openKind !== 'public')); // 열린 방의 반응·수정 방송은 그 방 토픽으로(아래 broadcast)
  const roomSubs = useRef(new Map()); // 방 id → 구독 채널
  const roomSpaces = useRef(new Map()); // 방 id → 그 방이 속한 공간(조직 id·PERSONAL) — 공간을 오가도 구독을 유지하고 방송을 그 공간으로 보낸다(D3)
  const [roomReset, setRoomReset] = useState(0); // removeAllChannels 뒤 방 구독을 다시 맞추는 신호(데스크톱엔 resumeEpoch가 없다)
  const typingIn = (id) => typingInState(typing, id); // 채널 화면의 typingCrews와 같은 창(TYPING_WINDOW_MS)
  const anyTyping = Object.values(typing).some((at) => Date.now() - at < TYPING_WINDOW_MS); // 끝난 표시가 남은 동안만 2초 주기 재그리기
  useEffect(() => { if (!anyTyping) return; const iv = setInterval(() => setTick((x) => x + 1), 2000); return () => clearInterval(iv); }, [anyTyping]); // 신호가 끊긴 표시는 2초 안에 내린다
  // ── 다른 공간(보고 있지 않은 조직·개인 공간)의 새 글 — 안 읽음 합계·알림(유건 실측 2026-09-18 "교차되는 메시지 확인 안 됨") ──
  // 구독: 보고 있지 않은 조직마다 org:<조직>(공개 채널 글) + u:<나>(비공개 방 글 — 서버 마이그레이션 적용 뒤). 구독 수 = 조직 수 + 1.
  // 서버 적용 전: 조직은 org: 다중 구독만으로 즉시, 개인 공간은 합계 재조회(15초)로 뜬다. u: 구독 실패·합계 RPC 부재는 옛 동작으로 물러난다.
  const [spaceTotals, setSpaceTotals] = useState({});
  const orgIdsKey = useMemo(() => (orgs ?? []).map((o) => o.id).sort().join(','), [orgs]);
  const totalsTimer = useRef(null);
  const loadTotals = useCallback(async () => { if (!uid) return; const { totals } = await loadSpaceTotals(supabase, orgIdsKey ? orgIdsKey.split(',') : [], notifyRef.current.muted ?? new Set()); setSpaceTotals(totals); }, [uid, orgIdsKey]);
  const loadTotalsSoon = useCallback(() => { clearTimeout(totalsTimer.current); totalsTimer.current = setTimeout(() => { loadTotals().catch(() => {}); }, 600); }, [loadTotals]); // 연달아 온 방송은 한 번에 센다
  // ── 폰 에이전트 탭: 결재 대기(모든 조직) — 아래 탭 뱃지와 맨 위 카드. 폰에서만 읽는다(데스크톱은 알림함이 그대로).
  // 부르는 때: 시작(조직 목록 뒤) 한 번, 결재 방송(어느 조직이든 — 이미 붙은 구독에 처리기만 더함, 600ms에 한 번), 앱 복귀, 에이전트 탭에 들어갈 때.
  // 주기 호출 없음 — 유휴 0. 한 번에 2건(결재 표·에이전트 참여 요청 표, 둘 다 RLS가 볼 수 있는 대기 행만).
  const [approvals, setApprovals] = useState([]);
  const [myAgents, setMyAgents] = useState(null); // 폰 에이전트 탭 — 내 에이전트(모든 공간). 아래 loadMyAgents가 채운다(선언은 얼굴 문맥(avatarCtx)보다 앞)
  // 에이전트 = 한 사람(유건 2026-10-05) — 내 크루 행 전부(개인 공간 + 모든 조직)로 얼굴 지도(crew-face.mjs agentLooks)를 만든다. 같은 에이전트는 공간·화면과 상관없이 같은 얼굴·사진.
  // 읽기: 로그인 때 1건 + 복귀·재연결(syncEpoch) 때 1건. 내 에이전트 목록(loadMyAgents)도 같은 읽기를 쓴다(agent-groups.mjs ownRowsReader — 읽는 중이면 같은 약속,
  // 로그인 때 버튼 이름 판정 재료는 같은 회차 결과를 다시 쓴다: 로그인 때 msgr_crews select 2건 → 1건, 분리 검수 2026-10-05 #4). 폰 에이전트 탭에 들어가면 새로 읽는다.
  // { rows, at } — at = 읽기를 시작한(또는 덮어 둔) 시각. 그보다 나중에 읽은 지금 공간 목록의 행(_at)이 있으면 그 행의 얼굴·사진이 앞선다(다른 기기에서 바꾼 값).
  // 더 새 값(저장·채우기로 덮어 둔 것)을 같은 회차의 옛 읽기 결과가 되돌리지 않게, at이 앞서야만 바꾼다(newerOwn).
  const [ownCrews, setOwnCrews] = useState(null);
  const syncEpochRef = useRef(syncEpoch); syncEpochRef.current = syncEpoch;
  const readOwnCrews = useMemo(() => ownRowsReader(async () => {
    const cols = 'id, org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, last_seen_at, avatar_url, created_at';
    if (Date.now() - faceCol.missingAt > 600_000) try { return await q(supabase.from('msgr_crews').select(`${cols}, face`).eq('owner_user_id', uid).in('status', ['active', 'available'])); } catch { /* 옛 서버(face 열 없음) */ }
    return q(supabase.from('msgr_crews').select(cols).eq('owner_user_id', uid).in('status', ['active', 'available']));
  }), [uid]);
  const newerOwn = (own) => (cur) => (cur && cur.at >= own.at ? cur : own);
  // 얼굴·사진 채우기(분리 검수 2026-10-05 #3) — 로그인 뒤 첫 읽기로 한 번만(agent-groups.mjs fillAgentLooks: 저장한 적 없는 열만, 실패는 다음 로그인 때). 추가 읽기 0,
  // 쓰기는 에이전트당 얼굴 1번 + 사진 1번(필요할 때만) 평생. 바뀐 행은 보낸 값을 내 크루 행에 덮어 둔다(다시 읽지 않는다)
  const looksFilled = useRef(false);
  useEffect(() => { if (!uid) { setOwnCrews(null); return undefined; } let live = true; readOwnCrews({ epoch: syncEpoch }).then((own) => {
    if (!live) return; setOwnCrews(newerOwn(own));
    if (looksFilled.current) return; looksFilled.current = true;
    fillAgentLooks(supabase, own.rows).then((done) => { if (done.length) setOwnCrews((cur) => (cur ? { ...cur, rows: cur.rows.map((x) => done.reduce((r, d) => (d.ids.includes(r.id) ? { ...r, ...d.patch } : r), x)) } : cur)); });
  }).catch(() => {}); return () => { live = false; }; }, [uid, syncEpoch, readOwnCrews]); // eslint-disable-line react-hooks/exhaustive-deps -- newerOwn은 순수
  const approvalsTimer = useRef(null);
  // 넣기 요청 카드의 이름(기능 점검 D6) — 에이전트 이름: 조직 에이전트는 조직 행, 개인 에이전트는 160000의 대기 에이전트 이름(msgr_personal_room_crews).
  // 방 이름: 채널·이름 붙은 그룹방은 그 이름, 대화방은 나를 뺀 사람 이름(조직 표시명 → 프로필). 요청이 있을 때만 부른다.
  const joinReqMeta = async (rows) => {
    const chIds = [...new Set(rows.map((r) => r.channel_id))]; const crewIds = [...new Set(rows.map((r) => r.crew_id))];
    const [chs, crs, mems] = await Promise.all([
      q(supabase.from('msgr_channels').select('id, name, kind, org_id').in('id', chIds)).catch(() => []),
      q(supabase.from('msgr_crews').select('id, display_name').in('id', crewIds)).catch(() => []),
      q(supabase.from('msgr_channel_members').select('channel_id, member_id').eq('member_kind', 'user').in('channel_id', chIds)).catch(() => []),
    ]);
    const crew = Object.fromEntries((crs ?? []).map((c) => [c.id, c.display_name]));
    if (crewIds.some((id) => !crew[id])) for (const c of await q(supabase.rpc('msgr_personal_room_crews')).catch(() => [])) if (crewIds.includes(c.id)) crew[c.id] = c.display_name;
    const room = {};
    for (const c of chs ?? []) if (c.name && c.name !== 'dm' && !c.name.startsWith('dm:')) room[c.id] = c.name; // 'dm'·'dm:…'은 이름 없는 대화방(사람 이름으로 짓는다)
    const people = (chs ?? []).filter((c) => !room[c.id]);
    for (const org of [...new Set(people.map((c) => c.org_id ?? null))]) {
      const these = people.filter((c) => (c.org_id ?? null) === org);
      const ids = [...new Set((mems ?? []).filter((m) => these.some((c) => c.id === m.channel_id) && m.member_id !== uid).map((m) => m.member_id))];
      const names = ids.length ? await resolvePeopleNames(supabase, { orgId: org, ids }).catch(() => ({})) : {};
      for (const c of these) { const ns = (mems ?? []).filter((m) => m.channel_id === c.id && m.member_id !== uid).map((m) => names[m.member_id]).filter(Boolean); if (ns.length) room[c.id] = ns.join(', '); }
    }
    return { crew, room };
  };
  const loadApprovals = useCallback(async () => {
    if (!uid || !isPhoneRef.current) return;
    const ids = orgIdsKey ? orgIdsKey.split(',') : [];
    const [aps, joins] = await Promise.all([
      ids.length ? q(supabase.from('msgr_crew_approvals').select('id, org_id, channel_id, crew_id, action, reason, payload, risk, kind, created_at, msgr_crews(owner_user_id)').in('org_id', ids).eq('status', 'pending').order('created_at', { ascending: false }).limit(40)).catch(() => null) : [],
      q(supabase.from('msgr_channel_crew_requests').select('id, channel_id, crew_id, requested_by, created_at').eq('status', 'pending').neq('requested_by', uid).order('created_at', { ascending: false }).limit(40)).catch(() => null),
    ]);
    if (aps === null && joins === null) return; // 둘 다 실패하면 지난 값을 둔다
    // 결재권 판정 재료(분리 검수 M-2) — '꼭 확인'(high) 결재가 있는 조직의 정책만 한 번 더 읽는다(없으면 요청 0). 게스트는 정책을 못 읽는데(RLS) 정책이 없으면 관리자 결정으로 보고, 게스트는 어차피 high를 결정 못 한다
    const highOrgs = [...new Set((aps ?? []).filter((a) => a.risk === 'high').map((a) => a.org_id))];
    const pols = highOrgs.length ? await q(supabase.from('msgr_org_policies').select('org_id, approval_high_by, approver_user_ids').in('org_id', highOrgs)).catch(() => null) : [];
    if (pols === null) return; // 정책을 못 읽으면 결정할 수 있는지 모른다 — 지난 값을 둔다
    const polOf = Object.fromEntries(pols.map((p) => [p.org_id, p]));
    const meta = joins?.length ? await joinReqMeta(joins).catch(() => ({ crew: {}, room: {} })) : { crew: {}, room: {} }; // 넣기 요청이 있을 때만 — 어떤 에이전트를 어느 방에(D6)
    setApprovals([...(aps ?? []).map(({ msgr_crews: crewRow, ...a }) => ({ ...a, apKind: a.kind, key: `approval:${a.id}`, kind: 'approval', at: a.created_at, crewOwnerId: crewRow ? crewRow.owner_user_id : undefined, policy: polOf[a.org_id] ?? null })), /* 결재 표의 종류(action·org_doc·connector…)는 apKind — 등급·요약 문구가 쓴다 */ ...(joins ?? []).map((r) => ({ ...r, key: `crewjoin:${r.id}`, kind: 'join', at: r.created_at, crewName: meta.crew[r.crew_id] ?? null, roomName: meta.room[r.channel_id] ?? null }))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
  }, [uid, orgIdsKey]);
  const approvalsSoon = useRef(() => {});
  approvalsSoon.current = () => { if (!isPhoneRef.current) return; clearTimeout(approvalsTimer.current); approvalsTimer.current = setTimeout(() => { loadApprovals().catch(() => {}); }, 600); };
  useEffect(() => { if (isPhone && orgs) loadApprovals().catch(() => {}); }, [isPhone, !!orgs, loadApprovals, resumeEpoch, syncEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(approvalsTimer.current), []);
  useEffect(() => { loadTotals().catch(() => {}); }, [loadTotals, orgId, syncEpoch]); // 다른 공간의 새 글은 crossRef가 다시 센다(주기 없음)
  const crossRef = useRef(() => {});
  const inboxTimer = useRef(null);
  const inboxSoon = useRef(() => {}); inboxSoon.current = () => { clearTimeout(inboxTimer.current); inboxTimer.current = setTimeout(bumpInbox, 1500); }; // 연달아 온 방송은 한 번에(알림함 조회 6건)
  useEffect(() => () => clearTimeout(inboxTimer.current), []);
  useEffect(() => { if (syncEpoch) { spaceCache.current.clear(); roomAsked.current.clear(); } }, [syncEpoch]); // 복귀·재연결 — 방송을 놓쳤을 수 있다
  // 공간 저장 목록(기능 점검 D3) — 탭·조직을 바꿀 때 떠나는 공간의 목록을 저장해 두고, 그 사이 그 공간에 방송이 오지 않았으면 돌아올 때 다시 읽지 않는다.
  const spaceCache = useRef(new Map()); const dirtySpaces = useRef(new Set());
  const spaceChanged = useRef(() => {}); spaceChanged.current = (space) => { dirtySpaces.current.add(space ?? PERSONAL); };
  crossRef.current = (payload, space) => { // 다른 공간 글: 합계 다시 세고, 읽히는 글이면 알림
    if (payload) spaceChanged.current(space); // 돌아가면 다시 읽는다(D3)
    if (!payload || (payload.author_user_id && payload.author_user_id === uid)) return;
    if (!seenOnce(seenMsgRef.current, payload.id)) return; // 같은 글이 옛 토픽(org:)과 u:로 함께 와도(전환기 이중 송신) 알림은 한 번
    loadTotalsSoon();
    notifyReadable(payload, space);
  };
  // ── Realtime — 내가 속한 조직 전체(org:<각 조직>) + u:<나>를 한 번 걸어 유지한다(기능 점검 D3, 2026-10-02).
  // 탭·고른 조직이 바뀌어도 다시 걸지 않는다 — 방송마다 "지금 보는 공간인가"(activeOrg)로 갈라 처리한다:
  //   보는 공간 = 본문 처리(handleMessage·결재·입력 중·반응·수정·첨부·실행 카드), 다른 공간 = 합계·알림(crossRef) + 그 공간 저장 목록을 '바뀜'으로.
  // 방송은 id·채널만 싣는다(본문은 RLS를 지난 조회로). 구독 수 = 조직 수 + 1. 끊겼다 다시 붙으면 방송이 없는 값을 한 번 다시 읽는다(syncEpoch).
  const subsRef = useRef(new Map());
  // 끊김 기록(realtime-link.mjs) — 구독 효과가 다시 돌아도(복귀·조직 집합·전체 해제) 남아야 다시 붙을 때 rt_up이 나간다(MSG-03·04). 계정마다 새로.
  // 목록 다시 읽기(bumpSync)는 끊겼다 붙은 구독(조직 N개 + u: + 방)을 0.8초 창으로 묶어 한 번. subUid = 이 계정의 조직 구독을 한 번이라도 걸었나(다시 거는 것인가)
  const linkRef = useRef({ uid: null, watch: null, subUid: null });
  const linkWatch = () => { const l = linkRef.current; if (l.uid !== uid || !l.watch) { l.watch?.dispose(); l.watch = createLinkWatch({ onSync: bumpSync }); l.uid = uid; l.subUid = null; } return l.watch; };
  useEffect(() => () => linkRef.current.watch?.dispose(), []);
  const uRetryRef = useRef(null); // u: 구독의 거절 대기 깨우기(joinWithBackoff retry) — 토큰이 갱신되면 바로 다시 붙는다(검수 M2: 만료 토큰 거절 뒤 60초~10분 비었다)
  useEffect(() => { uRetryRef.current?.(); }, [session.access_token]);
  const hasToken = !!session.access_token;
  const orgSubKey = orgSubscriptionKey({ uid, orgIdsKey, resumeEpoch, roomReset }); // 토큰은 빼고(MSG-01) — 갱신마다 떼고 다시 걸던 것
  useEffect(() => {
    if (!uid || !hasToken || !orgs) return undefined;
    const watch = linkWatch();
    if (linkRef.current.subUid === uid) watch.expect([...orgs.map((o) => `org:${o.id}`), `u:${uid}`]); // 다시 거는 구독 — 첫 SUBSCRIBED에서 거는 사이 놓친 글을 한 번 따라잡는다(MSG-01)
    linkRef.current.subUid = uid;
    const subs = new Map(); let stopU = () => {};
    const cleanup = realtimeScope.run(async (isDisposed, registerDispose) => {
      await supabase.realtime.setAuth(); // 인자 없이 — 콜백(getSession)이 갱신된 토큰을 준다. 값을 넘기면 갱신 전 토큰이 가입 값으로 박혔다(검수 M2)
      if (isDisposed()) return;
      const here = (space) => (space == null ? activeOrg.current === PERSONAL : space === activeOrg.current);
      const on = (fn) => (e) => { if (!isDisposed()) fn(e); };
      // 끊김 → 보던 방은 보정 조회를 켜고, 다시 붙거나 다시 건 구독이 붙으면 한 번 따라잡는다. announce=false(u:)는 목록 다시 읽기만 —
      // 열린 방의 끊김은 org:(조직)·dm:(개인 방)이 알린다. u:가 거절되는 옛 서버에서 개인 공간 보정 조회가 멈추지 않던 일이 없게.
      const status = (key, space, announce = true) => on((st) => {
        if (import.meta.env.DEV) console.log('[rt]', key, st);
        const s = watch.status(key, st);
        if (s && announce && here(space)) setEvent(broadcastEvent(s === 'down' ? 'rt_down' : 'rt_up', {}));
      });
      const remove = async () => {
        stopU(); const all = [...subs.values()]; subs.clear(); if (subsRef.current === subs) subsRef.current = new Map(); rt.current = null;
        const res = await Promise.all(all.map((c) => supabase.removeChannel(c).catch(() => 'error')));
        if (res.some((r) => r !== 'ok')) { await supabase.removeAllChannels(); setRoomReset((x) => x + 1); } // 방 구독도 함께 사라졌다 — 다시 맞추게(검수 #690 재검 MEDIUM)
      };
      registerDispose(remove);
      for (const o of orgs) {
        const ch = supabase.channel(`org:${o.id}`, { config: { private: true } });
        const mine = (fn) => on((e) => { if (here(o.id)) fn(e); });
        ch.on('broadcast', { event: 'message' }, on(({ payload }) => (here(o.id) ? handleMessageRef.current(payload) : crossRef.current(payload, o.id)))) // 본문은 handleMessage(org:·u:·dm: 공통)
          .on('broadcast', { event: 'approval' }, on(({ payload }) => { approvalsSoon.current(); if (here(o.id)) { setEvent(broadcastEvent('approval', payload)); notifyApproval(payload); inboxSoon.current(); } else spaceChanged.current(o.id); }))
          .on('broadcast', { event: 'crew_request' }, mine(({ payload }) => { if (payload?.channel_id && payload.channel_id === activeChannel.current) bumpMembers(); }))
          .on('broadcast', { event: 'typing' }, mine(onTypingEvent))
          .on('broadcast', { event: 'reaction' }, mine(({ payload }) => setEvent(broadcastEvent('reaction', payload))))
          .on('broadcast', { event: 'edit' }, mine(({ payload }) => setEvent(broadcastEvent('edit', payload))))
          .on('broadcast', { event: 'attach' }, mine(({ payload }) => setEvent(broadcastEvent('attach', payload)))) // 글보다 늦게 붙은 첨부(서버 20260930160000) — 그 글의 첨부를 다시 읽는다
          .on('broadcast', { event: 'progress' }, mine(onProgressEvent))
          .subscribe(status(`org:${o.id}`, o.id));
        subs.set(o.id, ch);
      }
      subsRef.current = subs; rt.current = subs.get(activeOrg.current) ?? null;
      if (import.meta.env.DEV) window.__argoRt = rt.current;
      // u:<나> — 비공개 방 글·결재·첨부, 친구·에이전트 넣기 요청 변화. 서버 적용 전에는 거절된다 — 거절되면 1분부터 두 배씩 최대 10분 간격으로만 다시 붙는다(Realtime 로그 잡음 방지).
      stopU = joinWithBackoff(supabase, () => supabase.channel(`u:${uid}`, { config: { private: true } })
        .on('broadcast', { event: 'message' }, on(({ payload }) => { const space = payload?.org_id ?? null; if (here(space)) handleMessageRef.current(payload); else crossRef.current(payload, space); }))
        .on('broadcast', { event: 'approval' }, on(({ payload }) => { approvalsSoon.current(); if (here(payload?.org_id ?? null)) { setEvent(broadcastEvent('approval', payload)); notifyApproval(payload); inboxSoon.current(); } }))
        .on('broadcast', { event: 'attach' }, on(({ payload }) => { if (here(payload?.org_id ?? null)) setEvent(broadcastEvent('attach', payload)); }))
        .on('broadcast', { event: 'crew_request' }, on(({ payload }) => { if (here(payload?.org_id ?? null) && payload?.channel_id === activeChannel.current) bumpMembers(); }))
        .on('broadcast', { event: 'friend' }, on(() => bumpFriends())) // 친구 요청·수락·삭제·차단(서버 20261002110000 — 종류와 상대 id만) — 받았을 때만 친구 목록을 다시 읽는다(D5)
        .on('broadcast', { event: 'crew_join' }, on(({ payload }) => { approvalsSoon.current(); inboxSoon.current(); if (payload?.channel_id && payload.channel_id === activeChannel.current) { bumpMembers(); setEvent(broadcastEvent('crew_join', payload)); } })), // 에이전트 넣기 요청 생성·처리(D6, 서버 20261002115000)
        { onStatus: status(`u:${uid}`, null, false) }); // 조직이 없는 사용자는 u:가 유일한 재연결 신호 — 끊겼다 붙으면 목록을 다시 읽는다(2026-10-05)
      uRetryRef.current = stopU.retry;
      return remove;
    });
    return () => { rt.current = null; cleanup(); }; // 송신 참조는 비동기 제거를 기다리지 않고 비운다(분리 검수 P2)
  }, [orgSubKey, hasToken]); // eslint-disable-line react-hooks/exhaustive-deps — 조직 목록(집합)·모바일 복귀·전체 해제 뒤에만 다시 건다(탭·고른 조직·토큰 갱신은 아니다 — orgSubscriptionKey)
  useEffect(() => { rt.current = subsRef.current.get(orgId) ?? null; }, [orgId]);
  useEffect(() => { const iv = setInterval(() => setTick((x) => x + 1), 15_000); return () => clearInterval(iv); }, []);
  const dmIdsKey = useMemo(() => channels.filter((c) => c.kind === 'dm').map((c) => c.id).sort().join(','), [channels]); // DM 집합(개수가 아니라 집합 — 하나 끝나고 하나 생겨도 재조회)
  useEffect(() => { dmIdsRef.current = new Set(dmIdsKey ? dmIdsKey.split(',') : []); }, [dmIdsKey]); // 방송 필터용(렌더 중 ref 대입 대신 효과에서)
  useEffect(() => { // DM 최근순 재료 — 채널당 마지막 메시지 시각(RPC msgr_dm_latest, 채널당 1행·id 인덱스). 폰 DM 탭 정렬에만. 재연결·조직 전환 때도 다시.
    if (!orgId || orgId === PERSONAL || !isPhone || !dmIdsKey || (restoredSpace.current?.space === orgId && restoredSpace.current.sync === syncEpoch)) return; let live = true; // 개인 공간은 loadPersonal이 _personal_last_at를 채운다. 저장본(D3)은 건너뛴다
    supabase.rpc('msgr_dm_latest', { org: orgId }).then(async ({ data }) => { if (!live || !data) return; const m = {}; for (const r of data) m[r.channel_id] = Date.parse(r.last_at); setLastAt((cur) => ({ ...cur, ...m }));
      const ids = data.map((r) => r.last_id).filter(Boolean); if (!ids.length) return; // 한 줄 미리보기 본문 — 마지막 글 id로 한 번에(RLS: 내 DM만 읽힌다)
      const { data: rows } = await supabase.from('msgr_messages').select('id, channel_id, body, author_user_id, crew_id, created_at').in('id', ids).is('deleted_at', null); if (!live || !rows) return;
      const lm = {}; for (const r of rows) lm[r.channel_id] = { body: plainPreview(r.body), mine: r.author_user_id === uid, userId: r.author_user_id ?? null, crewId: r.crew_id ?? null, at: Date.parse(r.created_at) }; setLastMsg((cur) => ({ ...cur, ...lm })); }, () => {});
    return () => { live = false; };
  }, [orgId, dmIdsKey, isPhone, resumeEpoch, syncEpoch]);
  // 폰 채널 탭 줄 재료(오픈채팅 모양 — 인원 수·마지막 글·시각) — 서버 msgr_channel_latest(20261001170000), 참여한 채널마다 1행.
  // 부르는 때: 폰에서 조직 목록(참여 채널 집합)이 바뀔 때·재연결 때 한 번. 주기 호출 없음(유휴 0). 새 글은 아래 방송 처리기가 그 줄만 갱신한다.
  // 서버에 함수가 아직 없으면(운영 적용 전) 조용히 건너뛴다 — 줄은 이름과 안 읽은 수만 보인다.
  const chIdsKey = useMemo(() => channels.filter((c) => c.kind !== 'dm').map((c) => c.id).sort().join(','), [channels]);
  useEffect(() => { listIdsRef.current = new Set(channels.map((c) => c.id)); }, [channels]);
  const previewIdsRef = useRef(new Set()); useEffect(() => { previewIdsRef.current = new Set(previewChannels.map((c) => c.id)); }, [previewChannels]); // 참여 전 공개 채널 글은 '새 방'이 아니다
  useEffect(() => {
    if (!orgId || orgId === PERSONAL || !isPhone || !chIdsKey || (restoredSpace.current?.space === orgId && restoredSpace.current.sync === syncEpoch)) return; let live = true;
    supabase.rpc('msgr_channel_latest', { org: orgId }).then(async ({ data }) => { if (!live || !data || activeOrg.current !== orgId) return;
      const at = {}; const cnt = {}; for (const r of data) { if (r.last_at) at[r.channel_id] = Date.parse(r.last_at); cnt[r.channel_id] = r.members ?? 0; }
      setLastAt((cur) => ({ ...cur, ...at })); setChCount(cnt);
      const ids = data.map((r) => r.last_id).filter(Boolean); if (!ids.length) return;
      const { data: rows } = await supabase.from('msgr_messages').select('id, channel_id, body, author_user_id, crew_id, created_at').in('id', ids).is('deleted_at', null); if (!live || !rows || activeOrg.current !== orgId) return;
      const lm = {}; for (const r of rows) lm[r.channel_id] = { body: plainPreview(r.body), mine: r.author_user_id === uid, userId: r.author_user_id ?? null, crewId: r.crew_id ?? null, at: Date.parse(r.created_at) }; setLastMsg((cur) => ({ ...cur, ...lm })); }, () => {});
    return () => { live = false; };
  }, [orgId, chIdsKey, isPhone, resumeEpoch, syncEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!rail && !orgMenu) return; const on = (e) => { if (e.key === 'Escape') { setRail(false); setOrgMenu(false); } }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [rail, orgMenu]);
  useEffect(() => { if (orgId) writeLastOrg(orgId); }, [orgId]);
  useEffect(() => { if (loadedOrg.current === orgId && orgId && chId && (channels.some((c) => c.id === chId) || previewChannels.some((c) => c.id === chId))) writeLastCh(orgId, chId); }, [orgId, chId, channels, previewChannels]); // 지금 조직의 목록이 도착한 뒤 그 채널일 때만 적는다(공간 전환 중 옛 채널 제외)
  // 30초 목록 다시 읽기는 없앴다(기능 점검 D2) — 새 방은 그 방 글 방송이 알려 주고(목록에 없는 방 → 목록 다시 읽기, D4), 나머지는 복귀·재연결 때 다시 읽는다.
  const personalOrg = useMemo(() => ({ id: PERSONAL, name: t('personal'), slug: 'personal', role: 'owner' }), [t]); // 개인 공간용 가상 조직 객체
  const org = isPersonal ? personalOrg : orgs?.find((o) => o.id === orgId);
  // ── 폰 셸 v2: 채팅 탭 = 개인 공간, 채널·기억 탭 = 고른 조직(chOrg). 공간 전환 버튼은 없다(유건 확정 2026-10-01) ──
  // 고른 조직은 이 기기에 기억한다. 어떤 길로든(알림·초대·조직 메뉴) 조직 공간에 들어가면 그 조직이 채널 탭의 조직이 된다.
  const [chOrgSaved, setChOrgSaved] = useState(() => { try { return localStorage.getItem(PHONE_ORG_KEY); } catch { return null; } });
  const orgIdList = useMemo(() => (orgs ?? []).map((o) => o.id), [orgs]);
  const chOrg = pickChannelOrg({ saved: chOrgSaved, last: readLastOrg(), orgIds: orgIdList });
  useEffect(() => { if (savedOrgAfter(chOrgSaved, orgId, PERSONAL) === chOrgSaved) return; setChOrgSaved(orgId); try { localStorage.setItem(PHONE_ORG_KEY, orgId); } catch { /* 저장 못 해도 이번 세션은 그대로 */ } }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 탭별 공간 맞추기 — 탭에 들어갈 때(그리고 조직 목록을 처음 받았을 때) 한 번만 본다. 공간이 바뀌어도 다시 보지 않는다:
  // 알림을 눌러 다른 공간의 대화를 여는 길(decideNav 'switch')이 채팅 탭 위에서 조직으로 바꿔도 되돌리지 않게.
  const spaceCheck = useRef('');
  useEffect(() => {
    if (!isPhone) return;
    const key = `${page}|${orgs ? 'ready' : 'wait'}`; if (spaceCheck.current === key) return; spaceCheck.current = key;
    if (!orgs) return;
    const want = spaceForTab(page, { personal: PERSONAL, chOrg });
    if (want && want !== orgId) setOrgId(want);
  }, [page, isPhone, orgs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tabQ, setTabQ] = useState(null); // 탭 안 검색어 — null이면 검색 칸을 닫은 상태(유건 확정: 돋보기 = 그 탭 안에서 먼저 찾기 → '전체에서 찾기')
  const [personalConsentAsk, setPersonalConsentAsk] = useState(false); // 개인 공간에서 에이전트를 쓰려는데 AI 이용 동의 전(2026-09-30)
  useEffect(() => { if (aiConsented || !isPersonal) setPersonalConsentAsk(false); if (!isPersonal) afterConsent.current = null; }, [aiConsented, isPersonal]);
  const afterConsent = useRef(null); // 동의하면 이어서 할 일(크루 1:1 열기 등 — 분리 검수 L6)
  const needPersonalConsent = (then = null) => { if (!isPersonal || aiConsented || aiConsent === undefined || aiConsentFailOpen) return false; afterConsent.current = then; setPersonalConsentAsk(true); setPage('chat'); setRail(false); return true; };
  useEffect(() => { if (aiConsented && afterConsent.current) { const go = afterConsent.current; afterConsent.current = null; go(); } }, [aiConsented]);
  const orgGateActive = !isPersonal && !!org && aiConsent !== undefined && !aiConsented; // App Store 5.1.2 재검수 M-5(2026-09-27 유건 결정) — 동의 전엔 조직 공간 전체(사이드바 채널·멤버·에이전트·DM·크루 시트·새 채널·알림함·기억 탭)를 막는다. 예외: 조직 선택(전환)·개인 공간 전환·설정의 '내 계정' 탭.
  const aiConsentLoading = !isPersonal && !!org && aiConsent === undefined && !aiConsentFailOpen; // 3차 검수 L-3 — 아직 모르고 실패도 아니면(=진짜 조회 중) 조직 화면 대신 로딩 표시
  const orgBlocked = orgGateActive || aiConsentLoading; // 사이드바·크루 시트 등은 "동의 안 함"과 "아직 모름" 둘 다 똑같이 가린다 — 다른 건 본문에 뭘 보여줄지뿐
  const friendItems = () => friends.filter((f) => f.status === 'pending' && f.requested_by !== uid).map((f) => ({ kind: 'friend', key: `friend:${f.user_id}`, channel_id: null, at: f.created_at, who: f.user_id, whoKind: 'user', text: t('inbox.friend.text', { name: f.display_name || f.handle || '' }), friendName: f.display_name || f.handle })); // 받은 친구 요청 — 조직·개인 공간 알림함이 같이 쓴다
  const inboxChKey = useMemo(() => [...channels, ...previewChannels].map((c) => `${c.id}:${c.kind}`).sort().join(','), [channels, previewChannels]);
  useEffect(() => { // 알림함 v1(클라이언트 집계): 나를 멘션한 글 · 내 글에 달린 크루 답글 · 대기 결재 · DM 새 글. 읽음 기준은 이 기기(localStorage) — 서버 표(msgr_notifications)는 친구 요청과 함께 v2.
    if (!org || !uid) { setInboxNet([]); return; }
    // 개인 공간: 조직 질의는 가상 org id로 매번 실패한다(검수 M-2) — 친구 요청만 싣는다(S15: 친구 요청이 가장 많이 오는 곳인데 벨·탭 배지가 0이었다).
    // 읽음 기준은 공간별(inboxSeen[공간 id])이라 조직 알림함의 같은 요청과 따로 센다 — 한 화면에 두 번 세지는 않는다
    if (isPersonal || isPhone) { setInboxNet([]); return; } // 개인 공간은 친구 요청만(아래 useMemo). 폰은 알림함이 없다(v2) — 서버 조회를 하지 않는다(기능 점검 D2)
    if (loadedOrg.current !== org.id) return; // 목록이 다 온 뒤 한 번 — 비웠다 채우는 사이마다 6건씩 다시 묻던 것
    let dead = false;
    (async () => {
      const dmIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id);
      const cols = 'id, channel_id, author_kind, author_user_id, crew_id, body, created_at, reply_to';
      const orgChIds = [...channels, ...previewChannels].filter((c) => c.kind !== 'dm').map((c) => c.id);
      const [ments, mine, aps, dms, joins, announces] = await Promise.all([
        q(supabase.from('msgr_messages').select(cols).eq('org_id', org.id).is('deleted_at', null).contains('mentions', JSON.stringify([{ kind: 'user', id: uid }])).order('id', { ascending: false }).limit(40)).catch(() => []),
        q(supabase.from('msgr_messages').select('id').eq('org_id', org.id).eq('author_user_id', uid).order('id', { ascending: false }).limit(200)).catch(() => []),
        // payload 추가(분리 검수 M-3) — 알림함 미리보기도 plain 있으면 쉬운 문장 + 명령 한 줄로 카드와 모양을 맞춘다.
        q(supabase.from('msgr_crew_approvals').select('id, channel_id, crew_id, action, reason, payload, created_at').eq('org_id', org.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(40)).catch(() => []),
        dmIds.length ? q(supabase.from('msgr_messages').select(cols).in('channel_id', dmIds).is('deleted_at', null).or(`author_user_id.neq.${uid},author_user_id.is.null`).order('id', { ascending: false }).limit(40)).catch(() => []) : [],
        // 에이전트 참여 요청 — 서버가 결정할 사람(채널 방장·채팅 결재자)과 요청자에게만 보여 준다. 요청자 자신의 것은 뺀다(유건 2026-09-16: 방장에게 허용 여부를 묻는다).
        // 채팅도 넣는다(20260918170000) — 방을 연 사람이 나가면 결재자가 바뀌는데, 다음 조회부터 새 결재자의 알림함에 대기 요청이 뜬다.
        orgChIds.length + dmIds.length ? q(supabase.from('msgr_channel_crew_requests').select('id, channel_id, crew_id, requested_by, created_at').in('channel_id', [...orgChIds, ...dmIds]).eq('status', 'pending').neq('requested_by', uid).order('created_at', { ascending: false }).limit(40)).catch(() => []) : [],
        // 회사 공지(2026-09-26) — 지금은 무료 기간 연장 안내뿐. 서버(msgr_extend_trial)가 쓰고 여기서 읽기만 한다(옛 서버는 테이블이 없어 빈 배열).
        q(supabase.from('msgr_org_announcements').select('id, kind, meta, created_at').eq('org_id', org.id).order('id', { ascending: false }).limit(20)).catch(() => []),
      ]);
      const myIds = mine.map((m) => m.id);
      for (const id of myIds) mineRef.current.add(id);
      const replies = myIds.length ? (await q(supabase.from('msgr_messages').select(`${cols}, kind, mentions`).eq('org_id', org.id).eq('author_kind', 'crew').eq('kind', 'text').in('reply_to', myIds).is('deleted_at', null).order('id', { ascending: false }).limit(40)).catch(() => []))
        .filter((m) => !(Array.isArray(m.mentions) && m.mentions.some((x) => x?.kind === 'crew'))) : []; // 최종 답글만 — 다른 크루로 넘기는 중간 답글·시스템 안내는 알림함 밖(조직 규모에서 비대해지던 문제, 유건 2026-09-11 밤)
      if (dead) return;
      const item = (kind, m) => ({ kind, key: `${kind}:${m.id}`, channel_id: m.channel_id, at: m.created_at, who: m.author_kind === 'crew' ? m.crew_id : m.author_user_id, whoKind: m.author_kind === 'crew' ? 'crew' : 'user', text: m.body ?? '' });
      const dmSet = new Set(dmIds); // DM 안의 크루 답글은 '1:1 대화'에만(같은 글이 '에이전트 답글'에도 실리던 중복 — 유건 제보 2026-09-11)
      const list = [...ments.map((m) => item('mention', m)), ...replies.filter((m) => !dmSet.has(m.channel_id)).map((m) => item('reply', m)), ...dms.map((m) => item('dm', m)),
        ...joins.map((r) => ({ kind: 'approval', key: `crewjoin:${r.id}`, joinReq: r.id, channel_id: r.channel_id, at: r.created_at, who: r.crew_id, whoKind: 'crew', text: t('inbox.crewjoin.text', { name: nameOfUser(r.requested_by) }) })),
        ...aps.map((a) => ({ kind: 'approval', key: `approval:${a.id}`, channel_id: a.channel_id, at: a.created_at, who: a.crew_id, whoKind: 'crew', text: approvalOneLineSummary(a, t('ap.plain.command')) })),
        ...announces.map((a) => ({ kind: 'system', key: `system:${a.id}`, channel_id: null, at: a.created_at, who: null, whoKind: 'system',
          text: a.kind === 'trial_extended' ? t('inbox.system.trialExtended', { date: fmtDay(a.meta?.trial_ends_at, lang)[0] }) : '' }))];
      setInboxNet(list);
    })();
    return () => { dead = true; };
  }, [org?.id, uid, isPhone, inboxEpoch, syncEpoch, inboxChKey, lang]); // eslint-disable-line react-hooks/exhaustive-deps // lang: 회사 공지 문구가 언어 전환에 다시 그려지게(2026-09-27 L11). 채널은 집합(inboxChKey)으로 — 목록 객체가 새로 만들어질 때마다 다시 조회하지 않게(기능 점검 D2)
  const inbox = useMemo(() => { const seenKeys = new Set(); // 친구 요청·차단·숨김은 조회 없이 합친다(친구 목록이 바뀌어도 서버 조회 6건을 다시 보내지 않는다)
    return [...inboxNet, ...friendItems()].filter((it) => !(it.whoKind === 'user' && blockedIds.has(it.who))).filter((it) => it.kind === 'approval' || !(it.whoKind === 'crew' && mutedCrewIds.has(it.who))) // 숨긴 크루는 알림함에서도 빠진다(검수 M4) — 결재 카드는 예외(검수 L5)
      .filter((it) => !seenKeys.has(it.key) && seenKeys.add(it.key)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 80);
  }, [inboxNet, friends, blockedIds, mutedCrewIds, uid, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodeSeenAt = org?.node_seen_at ? Date.parse(org.node_seen_at) : 0; // 상주 노드 하트비트 — 설정 화면과 같은 판정(AWAY_MS)
  const nodeAlive = !!org?.service_user_id && nodeSeenAt > 0 && Date.now() - nodeSeenAt < AWAY_MS;
  const nodeInd = nodeIndicator({ org, isPersonal, now: Date.now(), awayMs: AWAY_MS }); // 폰 위쪽 서버 표시 — 대상·모양은 순수 함수(src/node-indicator.mjs)
  const nodeLabel = !org?.service_user_id ? t('org.node.none') : !nodeSeenAt ? t('org.node.never') : t(nodeAlive ? 'org.node.on' : 'org.node.off', { when: fmtWhen(org.node_seen_at, lang) });
  const inboxUnread = org ? inbox.filter((it) => Date.parse(it.at) > (inboxSeen[org.id] ?? 0)).length : 0;
  const openInbox = () => { if (!org) return; setInboxPrev(inboxSeen[org.id] ?? 0); const next = { ...inboxSeen, [org.id]: Date.now() }; setInboxSeen(next); writeInboxSeen(next); setPage('inbox'); setRail(false); resyncBadge(); };
  const [otherNames, setOtherNames] = useState({}); // 개인 그룹 방의 친구 아닌 구성원(친구의 친구) 이름 — 친구 목록(members)에 섞으면 친구로 보인다
  // 조직 구성원 목록에 없는 사람(조직을 나간 사람의 옛 글·활동 기록의 작성자)은 이름을 따로 조회한다 — 화면에 그려지며 모인 id를 한 번에 묻고,
  // 같은 id는 다시 묻지 않는다. 조직이 바뀌면 비운다(조직 안 이름이 조직마다 다르다). 끝내 모르면 id 앞 8자리가 아니라 "나간 사용자"(점검 A·B #3).
  const [resolvedNames, setResolvedNames] = useState({});
  const nameWanted = useRef(new Set()); const nameAsked = useRef(new Set()); const nameTimer = useRef(null);
  const flushNames = () => { // 모인 id를 한 번에 묻는다 — 같은 id는 다시 묻지 않는다
    nameTimer.current = null;
    const ids = [...nameWanted.current].filter((id) => !nameAsked.current.has(id)); nameWanted.current.clear(); if (!ids.length) return;
    ids.forEach((id) => nameAsked.current.add(id));
    const asked = activeOrg.current; // 응답이 오기 전에 조직이 바뀌었으면 버린다
    resolvePeopleNames(supabase, { orgId: asked === PERSONAL ? null : asked, ids }).then((got) => { if (activeOrg.current === asked && Object.keys(got).length) setResolvedNames((cur) => ({ ...cur, ...got })); }).catch(() => {});
  };
  useEffect(() => { // 조직이 바뀌면 비운다(조직 안 이름이 조직마다 다르다) — 예약된 조회도 취소
    clearTimeout(nameTimer.current); nameTimer.current = null; nameAsked.current = new Set(); nameWanted.current = new Set(); setResolvedNames({});
    return () => { clearTimeout(nameTimer.current); nameTimer.current = null; };
  }, [orgId]);
  const askName = (id, force = false) => { // 이름을 한 번에 묻는 같은 길에 id를 얹는다 — force는 이미 아는 이름을 지우고 다시 묻는다(프로필 이름을 바꾼 직후)
    if (force) { nameAsked.current.delete(id); setResolvedNames((cur) => { const next = { ...cur }; delete next[id]; return next; }); }
    nameWanted.current.add(id); if (!nameTimer.current) nameTimer.current = setTimeout(flushNames, 0);
  };
  useEffect(() => { if (isPersonal && uid) askName(uid); }, [orgId, isPersonal, uid]); // eslint-disable-line react-hooks/exhaustive-deps -- 개인 공간 내 이름: 진입 때 한 번, 같은 묶음 조회에 얹는다(위 조직 전환 비우기 효과 뒤에 선언 — 순서가 곧 규칙)
  const nameOfUser = (id) => { // 작성자 id null = 계정 삭제(FK set null) — 글은 남고 이름만 사라진다
    if (needsNameLookup({ id, members, otherNames, resolved: resolvedNames }) && !nameAsked.current.has(id)) { // 처음 보는 id — 다음 렌더를 기다리지 않고 곧 한 번에 묻는다(15초 틱을 기다리면 그동안 "나간 사용자"로 보였다)
      nameWanted.current.add(id);
      if (!nameTimer.current) nameTimer.current = setTimeout(flushNames, 0);
    }
    return nameForUser({ id, members, otherNames, resolved: resolvedNames, left: t('user.left'), deleted: t('user.deleted'), unnamed: t('user.unnamed') });
  };
  const me = selfMember({ members, uid, isPersonal, personalName: resolvedNames[uid] || personalSelfName(otherNames, uid), email: session.user.email }); // 개인 공간은 구성원 목록(친구만)에 내가 없다 — 한 곳에서 내 이름을 정한다(검수 F: 레일·설정은 이메일·'—')
  const isAdmin = !isPersonal && org && ['owner', 'admin'].includes(org.role); // 개인 공간의 가상 조직(role owner)은 관리자가 아니다 — 초대 링크 등이 __personal__로 서버에 가던 것(2026-09-16)
  const chOffer = newChannelOffer({ role: org?.role, locked: orgLocked, personal: isPersonal }); const canNewCh = chOffer.can; // 새 채널 — 서버 msgr_create_channel은 owner·admin·member만, 잠긴 조직은 msgr_forbidden. 못 하는 행동은 보이지 않게(화면 검수 UM1), 이유는 안내 문구로(2차 검수 L-b)
  // F2-5 로컬 알림 — 앱이 숨겨졌거나 다른 채널을 보고 있을 때만. 본문은 싣지 않는다(방송 payload에도 본문이 없다 — RLS 통과 조회가 정본).
  const mineRef = useRef(new Set()); // 내가 쓴 글 id — 크루 답글(reply_to) 알림 판정용. 알림함 조회와 내 글의 realtime 방송이 채운다
  const notifyRef = useRef({ channels, members, crews, chId, uid, isAdmin, page, muted, quiet, blocked: blockedIds, mutedCrewIds });
  notifyRef.current = { channels, members, crews, chId, uid, isAdmin, page, muted, quiet, blocked: blockedIds, mutedCrewIds };
  const fromBlocked = (p) => (p?.author_kind !== 'crew' && !!p?.author_user_id && notifyRef.current.blocked.has(p.author_user_id))
    || (p?.author_kind === 'crew' && !!p?.crew_id && notifyRef.current.mutedCrewIds.has(p.crew_id)); // 차단한 사람·숨긴 크루의 글은 OS 알림도 띄우지 않는다(검수 M4 — PC 앞이면 서버가 폰 푸시를 안 보내 이 배너가 유일한 알림)
  useEffect(() => { updateNativeRealtimeContext({ lang, sound: getSound(), currentChannel: page === 'chat' ? chId : null, mutedChannelIds: [...muted], orgIds: (orgs ?? []).map((o) => o.id), quietFrom: quiet?.from ?? null, quietTo: quiet?.to ?? null }); }, [lang, page, chId, muted, quiet, orgs]);
  const hereKey = spaceKey(isPersonal ? null : orgId);
  const hereCount = useMemo(() => { let n = 0; let mention = 0; for (const [id, u] of Object.entries(unread)) if (!muted.has(id)) { n += u?.n || 0; mention += u?.mention || 0; } return { n, mention }; }, [unread, muted]);
  const spaceCount = (key) => (key === hereKey ? hereCount : spaceTotals[key]) ?? { n: 0, mention: 0 }; // 조직 전환기·개인 공간 입구의 숫자
  const elsewhere = Object.entries(spaceTotals).reduce((a, [k, u]) => (k === hereKey ? a : { n: a.n + (u?.n || 0), mention: a.mention + (u?.mention || 0) }), { n: 0, mention: 0 }); // 전환 버튼 — 보고 있지 않은 공간의 합
  const SpaceBadge = ({ c }) => (c?.n > 0 ? <span className={`msgr-badge${c.mention ? ' mark' : ''}`}>{c.n > 99 ? '99+' : c.n}</span> : null);
  legacyBadge.current = badgeTotal({ current: unread, currentKey: spaceKey(isPersonal ? null : orgId), muted, totals: spaceTotals });
  useEffect(() => { if (!iconBadge) setBadge(legacyBadge.current); }, [unread, muted, spaceTotals, orgId, isPersonal, iconBadge]); // 독 아이콘 숫자 = 모든 공간의 안 읽은 합계(음소거 채널 제외 — 레일 배지와 같은 규칙). 보고 있는 공간은 채널별 셈이 최신. 폰은 아래 서버 배지
  const badgeSig = iconBadge ? unreadSignature({ unread, totals: spaceTotals, muted }) : '';
  useEffect(() => { iconBadge?.request(); }, [badgeSig, iconBadge]); // 폰: 안 읽음 값이 바뀔 때만(15초 재조회로 같은 값이 다시 와도 안 부른다)
  useEffect(() => { if (uid) askNotifyOnce().catch(() => {}); }, [uid]); // 로그인 뒤 한 번 OS 권한 요청(미결정일 때만) — 종전엔 설정 버튼을 눌러야만 물었고, 맥 플러그인은 늘 '허용'이라 버튼조차 안 보였다
  const osNotify = (title, body, tag, channelId) => { sendNotify(title, body, tag, channelId); }; // Tauri 플러그인·웹 Notification 분기는 notify.js
  const shouldNotify = (channelId) => { const r = notifyRef.current; if (r.muted.has(channelId) || inQuiet(r.quiet)) return false; return !document.hasFocus() || r.page !== 'chat' || r.chId !== channelId; }; // 초점 기준 — 다른 창 뒤에 있어도 visibilityState는 'visible'이라 같은 채널을 띄워 두면 알림이 전부 억제됐다(유건 제보 2026-09-12) // 음소거 채널·조용한 시간엔 OS 알림 없음(P0 2026-09-09)
  const notifyMention = (payload) => {
    const r = notifyRef.current;
    if (!payload || payload.author_user_id === r.uid) return;
    if (fromBlocked(payload)) return;
    const mentioned = Array.isArray(payload.mentions) && payload.mentions.some((m) => m?.kind === 'user' && m.id === r.uid);
    if (!mentioned || !shouldNotify(payload.channel_id)) return;
    const ch = r.channels.find((c) => c.id === payload.channel_id); const who = r.members.find((m) => m.user_id === payload.author_user_id);
    osNotify(t('notify.mention', { name: payload.author_name || who?.display_name || '?', channel: payload.channel_name ?? ch?.name ?? '' }), plainPreview(payload.body, 140), `m:${payload.id}`, payload.channel_id); return true; // 멘션도 본문 발췌. 이름은 채운 payload(readableForNotify — 다른 공간 글) 우선
  };
  const notifyReply = (payload) => { // 크루 답변·DM(유건 지시 2026-09-11 밤: 답변 오면 알림, 앱이 뒤에 있으면 OS 알림)
    const r = notifyRef.current;
    if (!payload || payload.kind !== 'text' || (payload.author_user_id && payload.author_user_id === r.uid)) return;
    if (fromBlocked(payload)) return; // 크루든 사람이든(사람 DM·답글에 알림이 없던 갭, 2026-09-12 점검) — 내 글은 제외
    const ch = r.channels.find((c) => c.id === payload.channel_id);
    if (!shouldNotify(payload.channel_id)) return; // 모든 메시지에 알림(다른 메신저처럼 — 유건 2026-09-12). 채널 음소거·방해 금지는 shouldNotify
    const who = payload.author_name || (payload.author_kind === 'crew' ? r.crews.find((c) => c.id === payload.crew_id)?.display_name : r.members.find((m) => m.user_id === payload.author_user_id)?.display_name); // 채운 payload(다른 공간 글) 우선
    // 본문은 방송에 실리지 않는다(실시간 payload는 id·채널·멘션만 — 조직 토픽 구독자 전원에게 사적 대화가 새지 않게).
    // 그래서 알림 본문이 늘 비어 제목만 떴다(유건 제보 2026-09-16 배너). 내 권한으로 그 글만 읽어 채운다(RLS가 경계).
    const title = (payload.channel_kind ?? ch?.kind) === 'dm' ? (who || '?') : t('notify.message', { name: who || '?', channel: payload.channel_name ?? ch?.name ?? '' });
    const clip = (v) => plainPreview(v, 140);
    const inline = clip(payload.body);
    if (inline || 'channel_name' in payload) { osNotify(title, inline || t('notify.attachment'), `r:${payload.id}`, payload.channel_id); return; } // readableForNotify가 이미 읽은 글(본문 없음 = 첨부만)
    supabase.from('msgr_messages').select('body').eq('id', payload.id).maybeSingle()
      .then(({ data }) => osNotify(title, clip(data?.body) || t('notify.attachment'), `r:${payload.id}`, payload.channel_id))
      .catch(() => osNotify(title, '', `r:${payload.id}`, payload.channel_id)); // 못 읽으면 종전처럼 제목만
  };
  // 보고 있는 공간의 새 글 — org:(공개 채널)·u:<나>(비공개 방, 서버 적용 뒤)·dm:<열린 개인 방> 어느 토픽으로 와도 같은 처리. 같은 글이 두 토픽으로 올 수 있어 id로 한 번만.
  const seenMsgRef = useRef(new Set());
  const handleMessageRef = useRef(() => {});
  handleMessageRef.current = (payload) => {
    if (!seenOnce(seenMsgRef.current, payload?.id)) return;
    const cid = payload?.channel_id;
    if (unreadWorthy(payload, { uid, listIds: listIdsRef.current, previewIds: previewIdsRef.current, asked: roomAsked.current, openId: activeChannel.current })) unreadSoon.request(); // 방 넣기(addRoom) 전에 판정 — 처음 보는 방의 첫 글은 센다
    if (cid && loadedOrg.current === activeOrg.current && !listIdsRef.current.has(cid) && !previewIdsRef.current.has(cid)) addRoom.current(cid); // 목록에 없는 방의 첫 글 — 그 방만 불러와 넣는다(30초 목록 재조회를 기다리지 않게, D4)
    if (cid && cid === activeChannel.current && payload.kind === 'system') bumpMembers(); // 들어오기·나가기·에이전트 넣기 안내 글 — 열린 방 구성원만 다시 읽는다
    if (!isPhoneRef.current && payload.author_user_id !== uid && ((Array.isArray(payload.mentions) && payload.mentions.some((m) => m?.kind === 'user' && m.id === uid)) || dmIdsRef.current.has(cid) || (payload.author_kind === 'crew' && payload.reply_to))) inboxSoon.current(); // 알림함에 들어갈 글만(데스크톱 벨)
    if (payload?.author_kind === 'crew' && payload.crew_id) { crewActive(payload.crew_id); settleCrew(payload); crewPosts.heard(payload.channel_id, payload.crew_id, payload.id); setDoneAt((m) => ({ ...m, [payload.crew_id]: Date.now() })); } // 답글이 오면 그 크루의 '입력 중'·실행 카드를 즉시 내린다(6~8초 만료를 기다리던 유령 표시)
    if (payload?.author_kind === 'user') { // 사람이 보낸 글 — 멘션된 크루, 또는 그 DM 방의 크루가 1초 놀란다(유건 확정 2026-09-24)
      const surprised = new Set((Array.isArray(payload.mentions) ? payload.mentions : []).filter((m) => m?.kind === 'crew').map((m) => m.id));
      for (const m of dmMembers[payload.channel_id] ?? []) if (m.member_kind === 'crew') surprised.add(m.member_id);
      if (surprised.size) setSurprisedAt((cur) => { const next = { ...cur }; for (const id of surprised) next[id] = Date.now(); return next; });
    }
    if (payload?.author_user_id && payload.author_user_id === uid) mineRef.current.add(payload.id); setEvent(messageEvent(payload)); if (payload?.channel_id && (dmIdsRef.current.has(payload.channel_id) || (isPhoneRef.current && listIdsRef.current.has(payload.channel_id)))) setLastAt((m) => ({ ...m, [payload.channel_id]: Date.now() })); if (payload?.channel_id && payload.id && isPhoneRef.current && listIdsRef.current.has(payload.channel_id)) supabase.from('msgr_messages').select('id, channel_id, body, author_user_id, crew_id, created_at').eq('id', payload.id).is('deleted_at', null).maybeSingle().then(({ data: r }) => { if (r) setLastMsg((m) => (m[r.channel_id]?.at > Date.parse(r.created_at) ? m : { ...m, [r.channel_id]: { body: plainPreview(r.body), mine: r.author_user_id === uid, userId: r.author_user_id ?? null, crewId: r.crew_id ?? null, at: Date.parse(r.created_at) } })); }).catch(() => {}); /* 옛 글 응답이 늦게 오면 덮지 않는다(재검수 L-1) */ /* 방송엔 본문이 없다(서버 트리거는 id·채널·멘션만) → 그 글 1건을 조회해 미리보기 갱신(재검수 M-A) */
    notifyReadable(payload, isPersonal ? null : orgId); // 멘션이면 멘션 알림 하나만 — 알림은 내가 읽을 수 있는 글에만(readableForNotify)
  };
  // 알림 전 확인 — 알릴 상황(초점·음소거·조용한 시간 — shouldNotify)일 때만 조회한다(방송마다 조회하지 않게). 조직 토픽은 조직 전원이 들어, 내가 없는 방의 방송에도 알림이 뜨던 결함(실측 2026-09-18). 읽히는 글이면 이름·본문을 채워 넘긴다.
  // 진단(설정 → 진단): 알림을 왜 보냈는지·안 보냈는지 한 줄 — 배너가 안 떴다는 제보를 앱 밖에서 가를 방법이 없었다(D55: 개인 공간 DM 배너 없음, 로컬 재현 불가)
  const notifySkip = (payload) => { const r = notifyRef.current; if (r.muted.has(payload.channel_id)) return 'muted'; if (inQuiet(r.quiet)) return 'quiet'; return shouldNotify(payload.channel_id) ? '' : 'viewing'; };
  const notifyReadable = (payload, space) => {
    if (!payload || payload.author_user_id === uid) return;
    const tag = `msg ${payload.id} ${space ?? 'personal'}`; const skip = notifySkip(payload);
    if (skip) { pushDiag('notify', `${tag} skip:${skip}`); return; }
    readableForNotify(supabase, payload, space).then((p) => { if (!p) { pushDiag('notify', `${tag} skip:unreadable`); return; } pushDiag('notify', `${tag} send`); if (!notifyMention(p)) notifyReply(p); }).catch((e) => pushDiag('notify', `${tag} error`, String(e?.message ?? e).slice(0, 80)));
  };
  const notifyApproval = (payload) => {
    const r = notifyRef.current;
    if (!payload || payload.status !== 'pending' || !r.isAdmin || !shouldNotify(payload.channel_id)) return; // 확정권 정본은 서버 — 관리자에게만 알린다(저위험은 소유자가 카드에서 본다)
    const ch = r.channels.find((c) => c.id === payload.channel_id);
    osNotify(t('notify.approval', { channel: ch?.name ?? '' }), '', `a:${payload.id}`, payload.channel_id);
  };
  const avatarIdsKey = useMemo(() => [...new Set([uid, ...members.map((m) => m.user_id)].filter(Boolean))].sort().join(','), [uid, members]);
  const avatarAsked = useRef(new Set()); // 이미 물어본 사람 — 공간을 오가도 다시 묻지 않는다(복귀·재연결 때 비운다)
  const loadAvatars = useCallback(async () => { const ids = avatarIdsKey ? avatarIdsKey.split(',').filter((id) => !avatarAsked.current.has(id)) : []; if (!ids.length) return; ids.forEach((id) => avatarAsked.current.add(id)); const rows = await q(supabase.rpc('msgr_avatars', { ids })).catch(() => { ids.forEach((id) => avatarAsked.current.delete(id)); return []; }); if (rows.length) setAvatars((cur) => ({ ...cur, ...Object.fromEntries(rows.map((r) => [r.user_id, r.avatar_url])) })); }, [avatarIdsKey]);
  useEffect(() => { if (syncEpoch) avatarAsked.current.clear(); loadAvatars(); }, [loadAvatars, syncEpoch]); // 사람 집합이 바뀔 때·복귀 때만 — 주기 없음(기능 점검 D2)
  const [doneAt, setDoneAt] = useState({}); // crew_id → 답이 온 시각(얼굴 '완료' 2초)
  useEffect(() => { const ms = nextDoneIn(doneAt); if (ms == null) { if (Object.keys(doneAt).length) setDoneAt({}); return; } const tm = setTimeout(() => setDoneAt((m) => { const now = Date.now(); return Object.fromEntries(Object.entries(m).filter(([, at]) => nextDoneIn({ x: at }, now) != null)); }), ms + 20); return () => clearTimeout(tm); }, [doneAt]); // 크루마다 정확히 2초
  const [surprisedAt, setSurprisedAt] = useState({}); // crew_id → 멘션·수신 글이 온 시각(얼굴 '놀람' 1초, doneAt과 같은 모양·같은 만료 로직)
  useEffect(() => { const ms = nextSurpriseIn(surprisedAt); if (ms == null) { if (Object.keys(surprisedAt).length) setSurprisedAt({}); return; } const tm = setTimeout(() => setSurprisedAt((m) => { const now = Date.now(); return Object.fromEntries(Object.entries(m).filter(([, at]) => nextSurpriseIn({ x: at }, now) != null)); }), ms + 20); return () => clearTimeout(tm); }, [surprisedAt]); // 크루마다 정확히 1초
  const [erroredAt, setErroredAt] = useState({}); // crew_id → 실패한 답(meta.failed)이 온 시각(얼굴 '오류' 8초, doneAt과 같은 모양·같은 만료 로직). 방송에는 meta가 없어 대화창이 새 글을 읽을 때 알린다(onCrewFailed)
  useEffect(() => { const ms = nextErrorIn(erroredAt); if (ms == null) { if (Object.keys(erroredAt).length) setErroredAt({}); return; } const tm = setTimeout(() => setErroredAt((m) => { const now = Date.now(); return Object.fromEntries(Object.entries(m).filter(([, at]) => nextErrorIn({ x: at }, now) != null)); }), ms + 20); return () => clearTimeout(tm); }, [erroredAt]); // 크루마다 정확히 8초
  const noteCrewFailed = useCallback((crewId) => { if (crewId) setErroredAt((m) => ({ ...m, [crewId]: Date.now() })); }, []);
  // 얼굴 지도 — 내 크루 행(ownCrews)에, 그보다 나중에 읽은 화면 목록 행(지금 공간·폰 에이전트 탭)의 얼굴·사진을 덮는다(다른 기기에서 바꾼 값이 다음 목록 읽기에 보이게)
  const looks = useMemo(() => {
    if (!ownCrews) return null;
    const fresh = new Map();
    for (const c of [...crews, ...myAvailable, ...(myAgents ?? [])]) if (c?.owner_user_id === uid && (c._at ?? 0) > ownCrews.at && (c._at ?? 0) >= (fresh.get(c.id)?._at ?? 0)) fresh.set(c.id, c);
    return agentLooks(ownCrews.rows.map((r) => { const f = fresh.get(r.id); return f ? { ...r, ...('face' in f ? { face: f.face } : {}), ...('avatar_url' in f ? { avatar_url: f.avatar_url } : {}) } : r; }));
  }, [ownCrews, crews, myAvailable, myAgents, uid]);
  const avatarCtx = useMemo(() => {
    const now = Date.now();
    const working = new Set(Object.entries(typing).filter(([, at]) => now - at < TYPING_WINDOW_MS).map(([k]) => k.split(':')[1]));
    const asking = new Set(isPhoneRef.current ? approvals.filter((a) => a.kind === 'approval').map((a) => a.crew_id) : inbox.filter((it) => it.key.startsWith('approval:') && it.whoKind === 'crew').map((it) => it.who)); // 폰은 에이전트 탭 결재 목록(모든 조직)으로 — 폰은 알림함을 모으지 않는다(기능 점검 D2)
    const byId = new Map([...(myAgents ?? []), ...crews, ...myAvailable].map((c) => [c.id, c])); // 폰 에이전트 탭 — 다른 공간의 내 에이전트도 저장한 얼굴로
    const photos = Object.fromEntries(crews.filter((c) => c.avatar_url).map((c) => [c.id, c.avatar_url]));
    if (looks) for (const [id, l] of looks) { if (l.photo) photos[id] = l.photo; else delete photos[id]; } // 내 에이전트는 같은 에이전트 기준 사진(그 행 사진 → 대표 행 사진)
    return { users: avatars, crews: photos, looks,
      faceFor: (id) => agentFace(id, looks, byId.get(id)?.face ?? null),
      faceState: (id) => crewFaceState({ crew: byId.get(id) ?? null, working: working.has(id), asking: asking.has(id), surprisedAt: surprisedAt[id] ?? 0, erroredAt: erroredAt[id] ?? 0, doneAt: doneAt[id] ?? 0, now }) };
  }, [avatars, crews, myAvailable, myAgents, looks, typing, inbox, approvals, doneAt, surprisedAt, erroredAt, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const crewOf = (id) => crews.find((c) => c.id === id) ?? myAvailable.find((c) => c.id === id);
  const [newOrg, setNewOrg] = useState(null);
  const [joinCode, setJoinCode] = useState(null); // 초대 코드로 가입 — 앱에는 링크가 열릴 오리진이 없어 코드를 직접 붙여 넣는다(invite.mjs)
  const inviteErr = (e) => { const k = inviteErrorKey(e?.message); return k ? t(k) : friendlyErr(e?.message ?? String(e), t); };
  const [joinPreview, setJoinPreview] = useState(null); // { code, ...msgr_invite_preview } — 받는 쪽 미리보기 카드(설계서 2-2)
  const [joinBusy, setJoinBusy] = useState(false); const [joinErr, setJoinErr] = useState(null);
  const [joinHint, setJoinHint] = useState(null); // 입력이 초대 코드가 아닐 때 입력 아래에 보일 이유 문구 키(버튼을 막지 않고 눌렀을 때 알린다)
  const acceptCode = async (code, preview = null) => { // 참여 → 조직 전환 → 첫 채널(v2 channel_id, 옛 서버면 미리보기의 첫 채널) — 열기 요청(requestNav)이 조직을 바꾼 뒤 연다
    const r = await acceptInvite(supabase, code);
    setJoinCode(null); setOrgMenu(false); setJoinPreview(null);
    await loadJoined(); await loadOrgs();
    if (r.orgId) setOrgId(r.orgId);
    const first = r.channelId ?? (r.legacy ? preview?.channels?.[0]?.id : null) ?? null;
    if (first) requestNav(first, 'invite');
    const name = preview?.channels?.find((c) => c.id === first)?.name;
    setNote([name ? t('inv.joined.ch', { name }) : t('org.joined'), r.skipped.length ? t('inv.joined.skipped', { n: r.skipped.length }) : ''].filter(Boolean).join(' '));
  };
  const joinByCode = async (raw) => {
    const chk = checkJoinInput(raw); if (chk.hint) { setJoinHint(chk.hint); return chk.hint; } // 폼은 입력 아래에 그리고, 링크로 들어온 길은 부르는 쪽이 알린다(반환값)
    const code = chk.code; setJoinHint(null);
    try {
      const p = await previewInvite(supabase, code);
      if (!p) return await acceptCode(code); // 옛 서버: 미리보기 RPC가 없다 → 예전처럼 바로 수락
      setJoinCode(null); setOrgMenu(false); setJoinErr(null); setJoinPreview({ code, ...p });
    } catch (e) { setErr(inviteErr(e)); }
  };
  const joinFromPreview = async () => {
    setJoinBusy(true); setJoinErr(null);
    try { await acceptCode(joinPreview.code, joinPreview); } catch (e) { setJoinErr(inviteErr(e)); } finally { setJoinBusy(false); }
  }; // 인라인 폼 상태(문자열) — 네이티브 prompt 금지(QA: 사용성·룩 불일치)
  const [joinable, setJoinable] = useState([]); // J-3 도메인 자동 가입 후보
  const [railAction, setRailAction] = useState(null); const [actionBusy, setActionBusy] = useState(false); const [actionError, setActionError] = useState(''); const actionLock = useRef(false);
  const actionDialog = useRef(null);
  useEffect(() => {
    if (!railAction) return;
    const previous = document.activeElement;
    const dialog = actionDialog.current;
    (dialog?.querySelector('input') ?? dialog?.querySelector('button:not(:disabled)'))?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [railAction]);
  const trapActionFocus = (e) => {
    if (e.key !== 'Tab') return;
    const controls = [...actionDialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    if (!controls.length) return;
    const at = controls.indexOf(document.activeElement);
    e.preventDefault(); controls[(at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  };
  const [railBusy, setRailBusy] = useState(null); // 레일 목록 파견 진행 중 크루 id // 레일 행 '…' 메뉴(채널 설정·나가기·보관, 1:1 나가기) — 유건 지적 2026-09-04
  const [sortMenu, setSortMenu] = useState(false);
  // 폰 DM 탭 정렬(유건 요청 2026-09-15: 최근 메시지·안읽은 메시지·고정) — 기기에 기억. 고정 = 즐겨찾기한 DM을 DM 탭 맨 위에도 둔다(홈 즐겨찾기와 동시에).
  const [dmSort, setDmSort] = useState(() => { try { const v = localStorage.getItem('argo-msgr-dm-sort'); return DM_SORTS.includes(v) ? v : 'recent'; } catch { return 'recent'; } });
  const [dmSortMenu, setDmSortMenu] = useState(false);
  const DM_FILTERS = CHAT_FILTERS; // 폰 채팅 탭 칩: 전체 / 안읽음 N / 에이전트 / 그룹(유건 확정 2026-10-01 — 즐겨찾기 칩은 빼고 고정한 방을 맨 위에)
  const [dmFilter, setDmFilter] = useState(() => (isPhone && DM_FILTERS.includes(initialSnap?.dmFilter) ? initialSnap.dmFilter : 'all'));
  dmFilterRef.current = dmFilter; // saveScreenSnapshot(위)이 최신 dmFilter를 보게
  const [dmAnim, setDmAnim] = useState(null); const dmAnimSeq = useRef(0); const dmAnimTimer = useRef(null);
  const pickDmFilter = (k) => { // 폰 DM 상단 탭 — 탭 누름·좌우 스와이프가 같은 경로, 목록이 방향대로 들어온다(유건 2026-09-15: "스와이프로 탭 이동"은 하단 탭이 아니라 DM 안의 상단 탭)
    if (k === dmFilter) return; const dir = DM_FILTERS.indexOf(k) > DM_FILTERS.indexOf(dmFilter) ? 'left' : 'right'; setDmFilter(k); const body = document.querySelector('.msgr-side .msgr-railbody'); if (body) body.scrollTop = 0; // 거르개 바뀌면 맨 위부터(카톡) — 범위 밖 스크롤의 iOS 튕김 방지
    const n = ++dmAnimSeq.current; setDmAnim(`${dir}-${n % 2 ? 'a' : 'b'}`); clearTimeout(dmAnimTimer.current); dmAnimTimer.current = setTimeout(() => setDmAnim(null), 260); };
  const [lastMsg, setLastMsg] = useState({}); // channel_id → { body, mine, at } — DM 목록 한 줄 미리보기
  const [dmPeek, setDmPeek] = useState(null); // 길게 눌러 '대화 미리보기' 시트
  const [friendAdd, setFriendAdd] = useState(false); // 개인 공간 친구 추가 팝업(유건 2026-09-30 — 설정으로 보내지 않는다)
  const [dmGroup, setDmGroup] = useState(false); // 폰 DM 탭 + → 새 그룹 대화 시트(유건 2026-09-15: 그룹 탭은 있는데 맺는 기능이 없다)
  const lpStates = useRef({}); // 폰 레일 행 길게 누르기 상태(행별 — 채널·DM·즐겨찾기 대상)
  useEffect(() => () => { for (const st of Object.values(lpStates.current)) if (st.timer) clearTimeout(st.timer); clearTimeout(animTimer.current); clearTimeout(dmAnimTimer.current); }, []); // 언마운트 시 타이머 해제(검수 L-5)
  const pickDmSort = (v) => { setDmSort(v); try { localStorage.setItem('argo-msgr-dm-sort', v); } catch { /* 저장 못 해도 이번 세션은 적용 */ } };
  // onMouseLeave만으로는 터치·키보드로 못 닫는다(검수 #541 MEDIUM-4, D18 S63·K6) — 바깥 누름·Escape. 다른 메뉴 버튼을 누르는 것도 바깥이라 두 메뉴가 겹쳐 열리지 않는다
  useDismiss(dmSortMenu, () => setDmSortMenu(false), '.msgr-dmsort', '.msgr-dmsort > button', isPhone);
  useDismiss(sortMenu, () => setSortMenu(false), '.msgr-railsort', '.msgr-railsort > button', isPhone);
  // 폰 정렬 메뉴가 탭 바·새 대화 단추 밑으로 열려 가리던 제보(유건 실기기 2026-09-29) — 아래가 모자라면 위로 연다. 숨은 요소(높이 0)는 한계에서 뺀다
  useLayoutEffect(() => {
    if (!isPhone || !(dmSortMenu || sortMenu)) return;
    const m = document.querySelector(`${dmSortMenu ? '.msgr-dmsort' : '.msgr-railsort'} .msgr-rowmenu`); if (!m) return;
    const floor = Math.min(window.innerHeight, ...[...document.querySelectorAll('.msgr-tabbar, .msgr-fab')].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top));
    m.toggleAttribute('data-up', m.getBoundingClientRect().bottom > floor - 8);
  }, [isPhone, dmSortMenu, sortMenu]);
  useDismiss(meMenu, () => setMeMenu(false), 'button.me:not(.item), .msgr-rowmenu.me', 'button.me:not(.item)');
  const [lastAt, setLastAt] = useState({}); // 채널 → 마지막 메시지 시각(ms). 최근순 정렬 재료 — 조직 로드 때 한 번 조회, 이후 방송으로 갱신
  // 방 토픽 구독(목록의 '답변 중', 비공개 방의 글·반응·수정) — 바뀐 방만 붙이고 뗀다(방을 옮길 때 50개 전부 다시 붙이던 것, 검수 #690 M1).
  // 토큰 갱신은 조직 구독 효과의 setAuth가 조인된 채널에 전달하므로 의존성에 넣지 않는다. 모바일 복귀(resumeEpoch)엔 전부 다시 붙인다(검수 #690 M2).
  const lastAtRank = Object.entries(lastAt).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k]) => k).join(','); // 상한 선택용 최근 순위(시각이 바뀌어도 순위가 같으면 다시 계산하지 않는다)
  const roomIdsKey = useMemo(() => roomTopicIds(channels, chId, isPersonal, 50, lastAt).join(','), [channels, chId, isPersonal, lastAtRank]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomEpoch = useRef(null);
  useEffect(() => {
    let live = true; // 정리가 setAuth보다 먼저 끝나면(빠르게 옮길 때) 채널을 만들지 않는다 — 고아 dm: 구독이 쌓였다(검수 #607 실측)
    (async () => {
      await supabase.realtime.setAuth(); // 인자 없이 — 콜백(getSession)이 갱신된 토큰을 준다. 값을 넘기면 갱신 전 토큰이 가입 값으로 박혔다(검수 M2)
      if (!live) return;
      const subs = roomSubs.current; const watch = linkWatch();
      const again = new Set(); // 떼고 다시 거는 방 — 첫 SUBSCRIBED에서 거는 사이 놓친 글을 한 번 따라잡는다(열린 개인 방만 알린다 — roomSignal)
      if (roomEpoch.current !== resumeEpoch) { for (const [id, c] of subs) { supabase.removeChannel(c).catch(() => {}); if (roomEpoch.current !== null) again.add(id); } subs.clear(); roomSpaces.current.clear(); roomEpoch.current = resumeEpoch; }
      // 공간을 오가도 다른 공간의 방 구독은 유지한다(기능 점검 D3) — 지금 공간 목록이 다 온 뒤 그 공간에서 빠진 방(나간 방)만 뗀다. 전체 상한 50(Realtime 연결당 채널 여유).
      const space = activeOrg.current; const ready = loadedOrg.current === space;
      const want = new Set(roomIdsKey ? roomIdsKey.split(',') : []);
      const spaces = roomSpaces.current;
      for (const [id, c] of subs) { const closed = c.state === 'closed' || supabase.getChannels?.().includes(c) === false; if ((ready && spaces.get(id) === space && !want.has(id)) || closed) { supabase.removeChannel(c).catch(() => {}); subs.delete(id); spaces.delete(id); if (closed) again.add(id); } } // 빠진 방, 그리고 밖에서 닫힌 채널(removeAllChannels)은 떼고 아래에서 다시 만든다
      for (const id of want) {
        if (subs.has(id)) { spaces.set(id, space); continue; }
        spaces.set(id, space);
        const here = () => spaces.get(id) === activeOrg.current;
        const mine = (fn) => (e) => { if (here()) fn(e); };
        const c = supabase.channel(`dm:${id}`, { config: { private: true } });
        if (again.has(id)) watch.expect([`dm:${id}`]);
        c.on('broadcast', { event: 'message' }, ({ payload }) => { if (here()) handleMessageRef.current(payload); else { const sp = spaces.get(id); crossRef.current(payload, sp === PERSONAL ? null : sp); } }) // 보는 공간이면 본문 처리, 아니면 합계·알림 — id로 한 번만(u:와 겹쳐도)
          .on('broadcast', { event: 'typing' }, mine(onTypingEvent))
          .on('broadcast', { event: 'progress' }, mine(onProgressEvent))
          .on('broadcast', { event: 'reaction' }, mine(({ payload }) => setEvent(broadcastEvent('reaction', payload))))
          .on('broadcast', { event: 'edit' }, mine(({ payload }) => setEvent(broadcastEvent('edit', payload))))
          .on('broadcast', { event: 'attach' }, mine(({ payload }) => setEvent(broadcastEvent('attach', payload))));
        subs.set(id, c); // 상태 콜백보다 먼저 — 아래 '지금 구독인가' 확인이 첫 SUBSCRIBED를 놓치지 않게
        c.subscribe((status) => { // 개인 공간의 열린 방만 끊김·다시 붙음을 둘 다 알린다(MSG-03 — 끊김만 알려 보정 조회가 방을 떠날 때까지 돌았다). 조직 방의 끊김은 조직 구독이 알린다
            if (subs.get(id) !== c) return; // 떼어 낸 옛 구독의 늦은 CLOSED는 무시(같은 방을 다시 건 새 구독과 섞이지 않게)
            const sig = roomSignal(watch.status(`dm:${id}`, status), { roomId: id, openId: activeChannel.current, roomSpace: spaces.get(id), activeSpace: activeOrg.current, personal: PERSONAL });
            if (sig) setEvent(broadcastEvent(sig, {}));
          });
      }
      if (subs.size > 50) for (const [id, c] of subs) { if (subs.size <= 50) break; if (!want.has(id)) { supabase.removeChannel(c).catch(() => {}); subs.delete(id); spaces.delete(id); } } // 오래 전에 넣은 다른 공간 방부터
    })();
    return () => { live = false; };
  }, [roomIdsKey, isPersonal, resumeEpoch, roomReset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { for (const c of roomSubs.current.values()) supabase.removeChannel(c).catch(() => {}); roomSubs.current.clear(); }, []); // 떠날 때 전부 뗀다
  const dmIdsRef = useRef(new Set()); // 방송 핸들러가 DM 채널만 담게(조직 토픽엔 모든 채널이 실린다)
  const listIdsRef = useRef(new Set()); // 폰 목록 줄(채팅·채널 탭)에 있는 방 — 그 방의 새 글만 줄 미리보기를 갱신한다(조직 토픽엔 참여 안 한 공개 채널 글도 온다)

  const finishChannelAction = async (c, message) => {
    if (activeOrg.current !== orgId) return;
    orgRequests.current.begin(orgId); // Invalidate reads started before the successful mutation.
    setChannels((rows) => rows.filter((row) => row.id !== c.id));
    setDmMembers((rows) => { const next = { ...rows }; delete next[c.id]; return next; });
    setChId((id) => id === c.id ? null : id);
    setNote(message);
    await loadOrg(orgId).catch((e) => { if (activeOrg.current === orgId) setErr(friendlyErr(e.message, t)); });
  };
  const leaveChannel = async (c) => {
    if (c.kind === 'dm') {
      const left = await q(supabase.rpc('msgr_leave_dm', { ch: c.id }));
      if (!left) throw new Error(t('err.denied'));
      await finishChannelAction(c, t('dm.leave.done', { name: dmName(c) }));
      return;
    }
    const mine = crews.filter((cr) => cr.owner_user_id === uid).map((cr) => cr.id);
    if (mine.length) { // 규칙 14: 주인이 나가면 내 에이전트도 같이 나간다(주인 없이 남으면 받지도 쓰지도 못한 채 죽는다 — 검수 HIGH-3)
      const stuck = await q(supabase.from('msgr_channel_members').select('member_id').eq('channel_id', c.id).eq('member_kind', 'crew').in('member_id', mine)).catch(() => null);
      if (!stuck) throw new Error(t('ch.leave.checkFailed')); // 조회 실패면 통과가 아니라 중단(검수 LOW: fail-open)
      // 서버(20260918130000)는 내가 빠지는 순간 내 에이전트도 같이 뺀다. 그 마이그레이션이 없는 서버에서는 내가 빠지면
      // 에이전트가 죽은 채 남으므로 먼저 이 방에서 빼고, 빼는 함수가 없는 서버면 종전처럼 막는다.
      for (const s of stuck) {
        const r = await supabase.rpc('msgr_crew_leave_channel', { ch: c.id, crew: s.member_id });
        if (r.error) throw new Error(missingSchema(r.error) ? t('ch.leave.blocked') : friendlyErr(r.error.message, t));
      }
    }
    const res = await supabase.from('msgr_channel_members').delete().eq('channel_id', c.id).eq('member_kind', 'user').eq('member_id', uid).select('member_id');
    if (res.error) throw new Error(friendlyErr(res.error.message, t));
    if (!res.data?.length) throw new Error(t('err.denied'));
    await finishChannelAction(c, t(c.kind === 'dm' ? 'dm.leave.done' : 'ch.leave.done', { name: c.kind === 'dm' ? dmName(c) : c.name }));
  };
  const deleteChannel = async (c) => { // 영구 삭제 — 메시지·구성원·첨부 행은 FK cascade, 저장소 객체는 Storage API
    try { // 첨부 객체는 Storage API로 먼저(조직 관리자 권한 — 아니면 남되 채널이 사라져 열람 불가). 실패해도 채널 삭제는 진행.
      const ids = (await q(supabase.from('msgr_messages').select('id').eq('channel_id', c.id))).map((m) => m.id);
      const paths = ids.length ? (await q(supabase.from('msgr_attachments').select('storage_path').in('message_id', ids))).map((a) => a.storage_path) : [];
      if (paths.length) await supabase.storage.from('msgr').remove(paths);
    } catch { /* 객체 정리 실패는 무해 */ }
    const res = await supabase.from('msgr_channels').delete().eq('id', c.id).select('id');
    if (res.error) throw new Error(friendlyErr(res.error.message, t));
    if (!res.data?.length) throw new Error(t('ch.noEdit'));
    await finishChannelAction(c, t(c.kind === 'dm' ? 'dm.delete.done' : 'ch.delete.done', { name: c.kind === 'dm' ? dmName(c) : c.name }));
  };
  const archiveDm = async (c) => { // 1:1 대화 보관 = 보관(양쪽 목록에서 사라지고 대화는 남는다) — DM은 두 참가자 누구나(RLS msgr_can_manage_channel)
    const res = await supabase.from('msgr_channels').update({ archived_at: new Date().toISOString() }).eq('id', c.id).select('id');
    if (res.error) throw new Error(friendlyErr(res.error.message, t));
    if (!res.data?.length) throw new Error(t('ch.noEdit'));
    await finishChannelAction(c, t('dm.end.done', { name: dmName(c) }));
  };
  const archiveChannel = async (c) => {
    const res = await supabase.from('msgr_channels').update({ archived_at: new Date().toISOString() }).eq('id', c.id).select('id');
    if (res.error) throw new Error(friendlyErr(res.error.message, t));
    if (!res.data?.length) throw new Error(t('ch.noEdit'));
    await finishChannelAction(c, t('ch.archive.done', { name: c.name }));
  };
  const [deletedOrgs, setDeletedOrgs] = useState([]); // J-5 삭제 예정(복구 가능) 조직
  const [newCh, setNewCh] = useState(null);   // { name, kind }
  const createOrg = async (name) => {
    if (!name?.trim()) return;
    const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'org'}-${Date.now().toString(36).slice(-4)}`;
    try { const o = await q(supabase.from('msgr_orgs').insert({ name: name.trim(), slug, owner_user_id: uid }).select('id').single()); setNewOrg(null); setOrgMenu(false); await loadOrgs(); setOrgId(o.id); } catch (e) { setErr(e.message); }
  };
  const [invitesTick, setInvitesTick] = useState(0); // 초대 창이 링크를 만들거나 버렸으면 닫을 때 1 올라간다 — 설정 > 멤버의 초대 목록이 이 값이 바뀔 때만 다시 읽는다(UX 점검 D)
  const inviteSync = useRef(null); if (!inviteSync.current) inviteSync.current = inviteListSync(() => setInvitesTick((n) => n + 1));
  const [inviteFor, setInviteFor] = useState(null); // 초대 창(설계서 2-1) — { channelIds, role }. 채널 패널·조직 메뉴·빈 상태가 같은 창을 연다
  useBackClose(!!dmPeek, () => setDmPeek(null)); useBackClose(friendAdd, () => setFriendAdd(false)); useBackClose(runnerOpen, () => setRunnerOpen(false)); useBackClose(orgMenu, () => setOrgMenu(false)); useBackClose(chSheet, () => setChSheet(false)); useBackClose(!!sheet, () => setSheet(null)); useBackClose(!!personalCard, () => setPersonalCard(null)); useBackClose(!!grpSheet, () => setGrpSheet(null)); useBackClose(!!inviteFor, () => setInviteFor(null)); useBackClose(chPlus, () => setChPlus(false)); useBackClose(dmGroup, () => setDmGroup(false)); // Android 뒤로가 닫는 시트·팝업(MSG-10)
  const inviteChannels = useMemo(() => [...channels, ...previewChannels].filter((c) => c.kind !== 'dm'), [channels, previewChannels]);
  const hostChannels = useMemo(() => new Set(inviteChannels.filter((c) => c.created_by === uid || (c.admin_user_ids ?? []).includes(uid)).map((c) => c.id)), [inviteChannels, uid]); // 서버 msgr_is_channel_host와 같은 규칙(관리자는 창이 따로 취급)
  const orgInvite = () => { const pub = inviteChannels.filter((c) => c.kind === 'public').map((c) => c.id); setInviteFor({ channelIds: pub.length ? pub : chId ? [chId] : [], role: 'member' }); }; // 공개 채널 전부, 없으면 지금 보는 채널
  const createInviteCode = async (opts) => { inviteSync.current.start(); let made = 0; try { const r = await createInvite(supabase, { orgId, uid, ...opts }); made = 1; return r; } finally { setTimeout(() => inviteSync.current.finish(made), 0); } }; // 끝 신호는 한 박자 늦게 — 창이 닫힌 뒤 도착한 링크를 창이 곧바로 버리는 start가 먼저 잡혀 같은 링크를 두 번 읽지 않는다(invite-list-sync.mjs)
  useEffect(() => { if (inviteFor) inviteSync.current.opened(); else inviteSync.current.closed(); }, [inviteFor]); // 창이 사라질 때 보내는 버리기 요청이 끝난 뒤 목록을 다시 읽는다(invite-list-sync.mjs) // { id, code } — 창이 버린 링크는 discardInvite로 정리
  const inviteShare = (code, { channels: chs = [], days = null } = {}) => inviteShareText(code, { origin: location.origin, pathname: location.pathname, t, inviter: nameOfUser(uid), org: org?.name ?? '', channels: chs, days }); // 초대 창이 지금 고른 채널·만료를 넘긴다
  const inviteLinkOf = (code) => inviteLink(code, { origin: location.origin, pathname: location.pathname }) ?? code; // 앱(tauri://)은 열 링크가 없어 코드만
  // 조직 멤버 링크 하나(5차 피드백) — 초대 창이 열릴 때 지금 쓸 수 있는 멤버 링크를 한 번 읽는다(관리자만 읽힌다 — RLS. 못 읽으면 종전처럼 새로 만든다)
  const currentMemberLink = async () => { const r = await supabase.from('msgr_invites').select('id, code, role, channel_ids, expires_at, max_uses, use_count, revoked_at, accepted_at, for_node, created_at').eq('org_id', orgId).eq('role', 'member').is('revoked_at', null).order('created_at', { ascending: false }).limit(20); return r.error ? null : currentLink(r.data ?? [], 'member'); };
  const confirmReplace = ({ onConfirm, onClose }) => createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t('inv.replace')}>
    <ConfirmModal tone="primary" title={t('inv.replace.title')} description={t('inv.replace.note')} confirmLabel={t('inv.replace')} onConfirm={onConfirm} onClose={onClose} />
  </div>, document.body);
  const manageInvites = () => { setInviteFor(null); setChSheet(false); setSettingsTab('members'); setPage('settings'); setRail(false); }; // 설정 → 멤버의 초대 관리 목록(관리자만 보인다)
  const orgAdmins = members.filter((m) => ['owner', 'admin'].includes(m.role) && m.user_id !== org?.service_user_id);
  const askAdmin = orgAdmins.length ? t(orgAdmins.length > 1 ? 'inv.askAdmin.more' : 'inv.askAdmin', { name: orgAdmins[0].display_name || orgAdmins[0].user_id.slice(0, 8), n: orgAdmins.length - 1 }) : null; // 멤버에게는 초대 버튼 대신 누구에게 말할지(총괄 결정 B)
  // 1:1 대화 — 사람(user) 또는 크루(crew)와. 이미 있으면 열고, 없으면 dm 채널 + 멤버(나·상대·크루면 소유자까지) 생성
  // 에이전트와 1:1(D14) — 내 에이전트는 개인 공간의 그 에이전트 1:1(개인 행이 없으면 이 조직의 에이전트 DM), 남의 에이전트는 주인과의 1:1(openDm이 돌린다)에서 @에이전트로 위임.
  // body(방 밖 멘션으로 보냈던 본문)가 있으면 그 방 입력창에 옮겨 두고, 남의 에이전트인데 본문이 없으면 "@이름 "만 넣어 둔다. 보내기는 사람이 누른다.
  // opts.source — 어디서 눌렀나('agents' = 폰 에이전트 탭: 모든 공간을 보는 화면이라 공간 전환 안내를 띄우지 않는다)
  const dmWithCrew = async (crewId, body = '', opts = {}) => {
    const c = crewOf(crewId);
    const draft = body || (c && c.owner_user_id !== uid ? `@${c.display_name} ` : '');
    const cid = await openDm('crew', crewId, draft, opts); // 개인 공간에서 아직 방이 없으면 초안 화면이 이 글을 받는다(D13)
    if (cid && draft) getComposerSession(JSON.stringify([SB_URL, uid, orgId, cid]), composerTransport(supabase, { orgId, chId: cid, uid })).setText(draft);
  };
  // 내 에이전트의 열 수 있는 개인 공간 행 — 판정은 agent-groups.mjs personalRoomFor(주인 확인·조회 주입, 행동 테스트). 조직 크루 목록에는 회사(ws_id)가 없어
  // 1:1을 열 때만 내 행 중 같은 slug를 한 번 읽고(RLS: 개인 행은 주인만 읽힌다), 외부 봇이면 준비 상태(msgr_personal_room_crews의 ready)를 한 번 더 읽는다.
  // 주기 호출 없음. 읽기에 실패하거나 봇이 준비 안 됐으면(다시 연결 필요·조직을 나감) null — 종전 조직 1:1로 연다.
  const personalTwin = (c) => personalRoomFor(c, { uid,
    ownRows: (slug) => q(supabase.from('msgr_crews').select('id, org_id, owner_user_id, ws_id, slug, status, hosting').eq('owner_user_id', uid).eq('slug', slug).in('status', ['active', 'available'])),
    roomCrews: () => q(supabase.rpc('msgr_personal_room_crews')) });
  // 버튼 이름(유건 2026-10-04) — 조직 화면의 '1:1 대화'·'1:1로 시키기'가 개인 1:1로 가면 '개인 1:1 …'. 이미 가진 행(myAgents)으로만 판정하고 렌더마다 조회하지 않는다(모르면 지금 문구)
  const dmGoesPersonal = (c) => !isPersonal && personalRoomKnown(c, myAgents, uid);
  const openDm = async (kind, id, text = '', opts = {}) => {
    if (isPersonal && kind === 'crew') return openPersonalCrewDm(id, text);
    if (isPersonal && kind === 'user') return openPersonalDm(id, text); // 개인 공간에서 사람을 누르면(검색·새 채팅 시트) 개인 1:1 — 조직 DM 생성은 가상 org id로 400이었다
    // 에이전트 = 한 사람(유건 2026-10-03, P2): 조직에서 내 에이전트와 1:1을 새로 만들지 않고 개인 공간의 방 하나를 연다(글은 그 방 입력창으로 옮긴다).
    // 레일 메뉴·크루 카드·방 밖 멘션·전달 알림(dmWithCrew)과 새 대화 시트의 한 명 고르기가 모두 여기를 지난다. 개인 행이 없으면(0.1.92 이전 본체) 아래 종전 경로.
    // 이미 있는 조직 1:1은 지우거나 숨기지 않는다(목록에서 그대로 열린다). 남의 에이전트는 종전대로 주인과의 1:1.
    // 옮겨 간 직후 공간 전환 안내(유건 2026-10-04) — 방이 열렸을 때만, 폰 에이전트 탭에서 왔으면 띄우지 않는다(spaceMoveNotice). 누르면 지금 조직·보던 채널로 돌아간다.
    if (kind === 'crew' && crewOf(id)?.owner_user_id === uid) {
      const here = orgId; const hereCh = chId; const crew = crewOf(id); const twin = await personalTwin(crew);
      if (activeOrg.current !== here) return null;
      if (twin) { toPersonalTwin(crew, twin, { text, source: opts.source, here, hereCh }); return null; }
    }
    if (kind === 'user') supabase.rpc('msgr_friend_request', { target: id }).then(({ error }) => { if (!error) loadFriends(); }).catch(() => {}); // 사람 1:1을 열면 친구 목록과 동기화(같은 조직이면 서버가 바로 accepted) — DM 열기를 막지 않는다, 실패는 무시
    try {
      const mine = await q(supabase.from('msgr_channel_members').select('channel_id, msgr_channels!inner(id, kind, org_id, archived_at)').eq('member_kind', 'user').eq('member_id', uid));
      if (activeOrg.current !== orgId) return null;
      const dmIds = mine.filter((r) => r.msgr_channels?.kind === 'dm' && r.msgr_channels.org_id === orgId && !r.msgr_channels.archived_at).map((r) => r.channel_id);
      if (dmIds.length) {
        const others = await q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', dmIds));
        if (activeOrg.current !== orgId) return null;
        const wantUsers = new Set(kind === 'crew' ? [uid, crewOf(id)?.owner_user_id].filter(Boolean) : [uid, id]); // 자기 크루면 {나}, 남의 크루면 {나, 소유자}
        const hit = dmIds.find((cid) => { const ms = others.filter((m) => m.channel_id === cid); const users = new Set(ms.filter((m) => m.member_kind === 'user').map((m) => m.member_id)); const crewsIn = ms.filter((m) => m.member_kind === 'crew').map((m) => m.member_id); const sameUsers = users.size === wantUsers.size && [...wantUsers].every((u) => users.has(u)); return sameUsers && (kind === 'crew' ? crewsIn.length === 1 && crewsIn[0] === id : crewsIn.length === 0); });
        if (hit) {
          if (!channels.some((c) => c.id === hit)) await loadOrg(orgId); // 방금 서버가 만든 방일 수 있다 — 목록에 없으면 chId만 앞서가 빈 화면(검수 MEDIUM)
          if (activeOrg.current !== orgId) return null;
          setChId(hit); setPage('chat'); setRail(false); setSheet(null); return hit;
        }
      }
      const other = kind === 'crew' ? crewOf(id) : members.find((m) => m.user_id === id);
      // 남의 에이전트: DM에 크루를 넣는 것은 그 주인만 된다(20260918150000 — 종전 "소유자 동반"으로 만들면 msgr_bad_member 원문만 떴다).
      // 그 주인과의 1:1을 연다 — 그 방에서 @에이전트로 부르면 DM 위임(msgr_dm_candidates)으로 전달된다. 입력창 준비는 dmWithCrew가 한다.
      if (kind === 'crew' && other && other.owner_user_id !== uid) return openDm('user', other.owner_user_id);
      const name = kind === 'crew' ? other?.display_name : (other?.display_name || id.slice(0, 8));
      const others = [{ kind, id }];
      const cid = await q(supabase.rpc('msgr_create_channel', { org: orgId, kind: 'dm', name: `dm:${name}`, others })); // 나는 서버가 첫 멤버로 넣는다
      await loadOrg(orgId); if (activeOrg.current !== orgId) return null; setChId(cid); setPage('chat'); setRail(false); setSheet(null); return cid;
    } catch (e) { setErr(e.message); return null; }
  };
  // 조직에서 내 에이전트의 개인 1:1로 옮겨 연다 — 옮긴 직후 공간 전환 안내(유건 2026-10-04). openDm과 옛 조직 1:1 돌리기(openAgentDmInstead)가 같이 쓴다
  const toPersonalTwin = (crew, twin, { text = '', source = null, here, hereCh }) => {
    const move = spaceMoveNotice({ from: here, fromCh: hereCh, to: PERSONAL, source, personalKey: PERSONAL });
    const names = { name: crew.display_name, org: orgs?.find((o) => o.id === here)?.name ?? '' };
    runInSpace(PERSONAL, async (fn) => { const cid = await fn.openPersonalCrewDm(twin.id, text); if (cid && move) fn.moveNotice({ ...move, ...names }); });
  };
  // 옛 조직 1:1(유건 2026-10-05) — 내 에이전트와의 조직 1:1(#819 전에 만든 방)을 대화 목록 줄에서 열면 개인 1:1로 돌린다(agent-groups.mjs agentDmRedirect).
  // 돌릴지는 입구와 안 읽은 글로 정한다(agentDmRoute, 분리 검수 2026-10-05 #1): 그 방에 안 읽은 글이 있거나 입구가 그 방의 글을 가리키면(알림함 'inbox'·알림 탭 navInbox의
  // 출처 push·mac·card·미리보기 'peek') false — 부르는 쪽이 옛 방을 열고(setChId → 방이 읽음 처리), 방 위 안내 띠가 개인 1:1로 안내한다. 목록 줄('list')이고 안 읽은 글이 없을 때만 돌린다.
  // 개인 행이 있는지 서버에 한 번 묻고(personalTwin — openDm과 같은 판정), 없거나 실패하면 누른 그 방을 연다. 옛 방은 지우지 않는다.
  // 돌리는 동안 같은 줄을 다시 누르면 무시한다(분리 검수 #5 — 반응 없이 기다리는 동안 연타하면 두 번 돌았다). 그 줄은 aria-busy·눌림 표시(redirectingId).
  const redirecting = useRef(null); const [redirectingId, setRedirectingId] = useState(null);
  const openAgentDmInstead = (channelId, from) => {
    if (isPersonal) return false;
    const channel = channels.find((c) => c.id === channelId);
    const go = agentDmRedirect(channel, dmMembers[channelId], { uid, crewOf, myAgents });
    if (!go || agentDmRoute({ channel, unread, from }) === 'legacy') return false;
    if (redirecting.current === channelId) return true;
    redirecting.current = channelId; setRedirectingId(channelId);
    const here = orgId; const hereCh = chId;
    personalTwin(go.crew).then((twin) => {
      if (activeOrg.current !== here) return;
      if (twin) toPersonalTwin(go.crew, twin, { here, hereCh });
      else { setChId(channelId); setPage('chat'); setRail(false); setSheet(null); }
    }).finally(() => { if (redirecting.current === channelId) { redirecting.current = null; setRedirectingId(null); } });
    return true;
  };
  // 얼굴·사진 저장(유건 2026-10-05) — 같은 에이전트의 내 행 전부를 한 요청으로(agent-groups.mjs saveAgentLook). 성공하면 보낸 값을 내 크루 행에 덮어 둔다(다시 읽지 않는다)
  const saveLook = async (crewId, patch) => {
    const r = await saveAgentLook(supabase, crewId, patch, looks);
    if (!r.error && r.ids.length) setOwnCrews((cur) => (cur ? { at: Date.now(), rows: cur.rows.map((x) => (r.ids.includes(x.id) ? { ...x, ...patch } : x)) } : cur));
    return r;
  };
  // 이전 대화 보기(분리 검수 2026-10-05 #2) — 내 에이전트 개인 1:1 위에 그 에이전트의 옛 조직 1:1(조직마다 한 줄, 글 수). 개인 1:1이 주 경로가 되며 옛 기록(실측 282개)이 안 보였다.
  // 판정은 agent-groups.mjs earlierAgentDms. 내 크루 행은 이미 읽은 것(ownCrews)을 쓰고, 방을 열 때 에이전트당 세션에 한 번만 묻는다:
  // 그 에이전트 조직 행이 든 채널 1건 + 구성원 1건 + 옛 방마다 글 수(head count) 1건 + 보관한 방이 있으면 내 읽음 커서 1건·보관 방마다 안 읽은 수 1건.
  // 조직 행이 없으면 0건. 주기 조회 없음, 실패하면 띠를 그리지 않는다(다시 묻지 않는다 — 보관 방을 읽으면 markRead가 이 기억의 그 줄만 고친다).
  const earlierAsked = useRef(new Map());
  const findEarlier = (crewId) => {
    if (!ownCrews) return null; // 내 크루 행을 읽기 전 — 읽은 뒤 다시 부른다(빈 결과를 세션에 남기지 않게)
    if (!earlierAsked.current.has(crewId)) earlierAsked.current.set(crewId, earlierAgentDms(crewId, { uid, rows: ownCrews.rows,
      crewDms: (ids) => q(supabase.from('msgr_channel_members').select('channel_id, member_id, msgr_channels!inner(org_id, kind, archived_at)').eq('member_kind', 'crew').in('member_id', ids)),
      members: (ids) => q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', ids)),
      count: async (id) => { const r = await supabase.from('msgr_messages').select('id', { count: 'exact', head: true }).eq('channel_id', id).is('deleted_at', null); if (r.error) throw new Error(r.error.message); return r.count ?? 0; },
      // 보관한 방만(검수 #857 MEDIUM — 서버 안 읽음 수는 보관 방을 세지 않는다): 내 읽음 커서 1건 + 방마다 커서 뒤 남의 글 수 1건(msgr_unread와 같은 기준 — 삭제 제외, 내 글 제외)
      reads: (ids) => q(supabase.from('msgr_reads').select('channel_id, last_read_id').eq('user_id', uid).in('channel_id', ids)),
      unread: async (id, after) => { const r = await supabase.from('msgr_messages').select('id', { count: 'exact', head: true }).eq('channel_id', id).gt('id', after).is('deleted_at', null).or(`author_user_id.is.null,author_user_id.neq.${uid}`); if (r.error) throw new Error(r.error.message); return r.count ?? 0; } }));
    return earlierAsked.current.get(crewId);
  };
  // 누르면 그 조직으로 옮겨 옛 방을 연다 — 돌리기 없이(입구 판정을 거치지 않는다). 그 방 위에는 개인 1:1로 돌아오는 안내 띠가 뜬다
  // 보관한 방(유건 결정 2026-10-08 1-②)은 조직 목록에 없다 — 누를 때 그 방 행을 한 번 읽어 earlierRoom으로 남기고 읽기 전용으로 연다(주기 조회 없음).
  // 행은 공간을 옮기기 전에 읽는다(채널 읽기 권한은 공간과 무관 — msgr_channels_select). 읽는 동안 사용자가 다른 공간으로 옮겼으면 열지 않고,
  // 못 읽으면 안내만 — 그 조직으로 공간도 옮기지 않는다(검수 #857 LOW). 그 사이 보관이 풀렸으면 종전 목록 경로. unread = 줄의 안 읽은 수(markRead가 한 번 쓸지 본다)
  const openEarlier = async (l) => {
    let room = null;
    if (l.archived) {
      const from = activeOrg.current;
      const row = await q(supabase.from('msgr_channels').select('id, kind, name, topic, crew_memory, personal_crews, created_by, admin_user_ids, excluded_user_ids, excluded_crew_ids, org_id, archived_at').eq('id', l.channelId).maybeSingle()).catch(() => null);
      if (activeOrg.current !== from) return;
      if (!row) { setErr(t('dm.archived.fail')); return; }
      if (row.archived_at) room = { orgId: l.orgId, channel: row, crewId: l.crewId, unread: l.unread ?? 0 };
    }
    runInSpace(l.orgId, () => { if (room) setEarlierRoom(room); setChId(l.channelId); setPage('chat'); setRail(false); setSheet(null); });
  };
  // ── 개인 공간 에이전트 1:1(2026-09-30): 내 개인 크루와 한 방. 남의 크루면 그 주인(친구)과의 1:1. AI 이용 동의 전이면 동의부터 받는다 ──
  // text = 그 방 입력창에 옮겨 둘 글(조직에서 방 밖 멘션으로 쓴 글을 개인 1:1로 가져올 때 — openDm). 동의를 거쳐도 남는다. 보내기는 사람이 누른다.
  const openPersonalCrewDm = async (crewId, text = '') => {
    const c = crewOf(crewId);
    if (c && c.owner_user_id !== uid) return openPersonalDm(c.owner_user_id, text);
    if (needPersonalConsent(() => openPersonalCrewDm(crewId, text))) return null;
    try {
      const cid = await q(supabase.rpc('msgr_dm_personal_crew', { crew: crewId }));
      if (!await loadUntilListed(cid, { load: loadPersonal, here: () => activeOrg.current === PERSONAL })) return null; // 목록 읽기가 밀리면 한 번 더 — 목록에 없는 방을 고르면 마지막 방이 열렸다(agent-groups.mjs)
      if (text) getComposerSession(JSON.stringify([SB_URL, uid, PERSONAL, cid]), composerTransport(supabase, { orgId: PERSONAL, chId: cid, uid, personal: true })).setText(text); // 그 방 입력창과 같은 세션 키·개인 통로(sendFirstDm과 같다)
      setChId(cid); setPage('chat'); setRail(false); setSheet(null); return cid;
    } catch (e) { setErr(friendlyErr(e.message, t)); return null; }
  };
  // ── 개인 1:1 열기: 친구와 조직 밖 대화. 개인 공간으로 전환하고 그 방을 연다 ──
  // 친구와의 1:1 — 있는 방만 찾고(만들지 않는다), 없으면 초안 화면을 연다. 방은 첫 글을 보낼 때 만든다(기능 점검 D13: 누르기만 해도 빈 방이 DB에 생겼다).
  // 반환: 있는 방이면 그 id, 초안이면 null(text는 초안 입력창에 미리 넣는다 — 남의 에이전트를 부르려던 글).
  const openPersonalDm = async (targetUserId, text = '') => {
    try {
      setOrgId(PERSONAL); // 개인 공간으로 전환
      const rows = await loadPersonal();
      if (activeOrg.current !== PERSONAL) return null;
      const hit = personalDmWith(rows, targetUserId);
      setRail(false); setSheet(null);
      if (hit) { setDmDraft(null); setChId(hit.id); setPage('chat'); return hit.id; }
      setDmDraft({ userId: targetUserId, text }); setPage('chat'); return null; // 친구가 아니면 첫 글에서 서버가 msgr_not_friend로 막는다
    } catch (e) { setErr(/msgr_not_friend/.test(e.message) ? t('friends.err.closed') : e.message); return null; }
  };
  // 초안의 첫 글 — 방을 만들고(msgr_dm_personal: 있으면 그 방, 나갔던 사람은 다시 넣는다) 그 방 입력창과 같은 전송 세션으로 보낸 뒤 그 방을 연다.
  // 보내기가 실패해도 방은 열린다 — 입력창의 실패 카드가 다시 보내기를 맡는다(같은 세션 키).
  const sendFirstDm = async (targetUserId, body) => {
    try {
      const cid = await q(supabase.rpc('msgr_dm_personal', { target: targetUserId }));
      const session = getComposerSession(JSON.stringify([SB_URL, uid, PERSONAL, cid]), composerTransport(supabase, { orgId: PERSONAL, chId: cid, uid, personal: true })); // personal: 개인 방 첨부 경로(feat/msgr-media 병합 뒤 쓰인다 — 같은 세션 키를 그 방 입력창이 이어 쓴다)
      roomAsked.current.add(cid); // 내 첫 글의 방송이 '모르는 방'으로 목록을 또 읽어 아래 읽기를 낡은 요청으로 만들지 않게(실측: 그러면 chId가 목록에 없어 마지막 방이 열렸다)
      session.setText(body); await session.send([]);
      let rows = await loadPersonal(); if (activeOrg.current !== PERSONAL) return;
      if (!rows?.some((c) => c.id === cid)) { rows = await loadPersonal(); if (activeOrg.current !== PERSONAL) return; } // 다른 읽기(복귀 등)에 밀렸으면 한 번 더
      setDmDraft(null); setChId(cid); setPage('chat');
    } catch (e) { setErr(/msgr_not_friend/.test(e.message) ? t('friends.err.closed') : friendlyErr(e.message, t)); }
  };
  // ── 폰 에이전트 탭: 내 에이전트(개인 공간 + 모든 조직) — 탭에 들어갈 때·앱 복귀 때만 읽는다(주기 호출 없음, 한 번에 2건) ──
  // 같은 에이전트 한 줄(유건 2026-10-02 — agent-groups.mjs): 판정에 ws_id·slug가 필요하다. 개인 행 RPC는 ws_id를 주지 않아, 본인 크루 조회(한 건)에서
  // 조직 필터를 빼 내 개인 행도 같이 받아 ws_id만 빌린다(RLS: org_id NULL 행은 주인만 본다). 요청 수는 그대로 2건 — 에이전트 탭에서만 즐겨찾기 1건을 더 읽는다.
  // reuse — 같은 회차(syncEpoch)에 얼굴 지도가 이미 읽은 내 크루 행을 다시 쓴다(로그인 때 버튼 이름 판정 재료 — 요청 0). 폰 에이전트 탭·설정은 새로 읽는다(읽는 중이면 같은 약속)
  const loadMyAgents = useCallback(async ({ favs = false, reuse = false } = {}) => {
    if (!uid) return;
    const [own, personal, pins] = await Promise.all([readOwnCrews({ epoch: syncEpochRef.current, reuse }).catch(() => null), q(supabase.rpc('msgr_personal_room_crews')).catch(() => []),
      favs ? q(supabase.from('msgr_target_prefs').select('org_id, target_id').eq('user_id', uid).eq('target_kind', 'crew').eq('pinned', true)).catch(() => null) : null]);
    if (pins) setAgentPins(new Set(pins.map((p) => `${p.org_id}:${p.target_id}`)));
    if (own === null) return;
    setOwnCrews(newerOwn(own));
    const wsOf = new Map(own.rows.filter((c) => !c.org_id).map((c) => [c.id, c.ws_id]));
    setMyAgents(stampFetched([...withoutCopies(personal ?? []).filter((c) => c.owner_user_id === uid && c.status === 'active').map((c) => ({ ...c, org_id: null, ws_id: c.ws_id ?? wsOf.get(c.id) ?? null })), ...withoutCopies(own.rows).filter((c) => c.org_id)]));
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps -- readOwnCrews는 uid로만 바뀐다
  // 에이전트 즐겨찾기 — 조직 행은 기존 에이전트 즐겨찾기(msgr_target_prefs, 데스크톱 레일 별과 같은 행), 개인 행은 이 기기(AGENT_FAV_KEY). 누를 때만 쓴다(같은 값은 다시 쓰지 않는다)
  const [agentPins, setAgentPins] = useState(() => new Set());
  const [agentLocalFav, setAgentLocalFav] = useState(() => { try { return readAgentFav(window.localStorage); } catch { return new Set(); } });
  const toggleAgentFav = async (g) => {
    const on = !groupIsFav(g, { pinned: agentPins, local: agentLocalFav });
    const ch = favChanges(g, on, { pinned: agentPins, local: agentLocalFav });
    setAgentLocalFav(ch.local); try { window.localStorage.setItem(AGENT_FAV_KEY, JSON.stringify([...ch.local])); } catch { /* 저장 못 해도 이번 화면엔 보인다 */ }
    if (!ch.server.length) return;
    setAgentPins((st) => { const n = new Set(st); for (const p of ch.server) { const k = `${p.org_id}:${p.target_id}`; if (on) n.add(k); else n.delete(k); } return n; });
    try { await prefQueue.current.enqueue(() => q(supabase.from('msgr_target_prefs').upsert(ch.server.map((p) => ({ ...p, user_id: uid }))))); if (ch.server.some((p) => p.org_id === orgId)) bumpPrefs(); }
    catch (e) { setErr(friendlyErr(e.message, t)); loadMyAgents({ favs: true }).catch(() => {}); }
  };
  useEffect(() => { if (isPhone && page === 'agents') { loadMyAgents({ favs: true }).catch(() => {}); loadApprovals().catch(() => {}); } if (isPhone && page === 'set-agents') loadMyAgents().catch(() => {}); if (isPhone && page === 'approvals') loadApprovals().catch(() => {}); }, [isPhone, page, resumeEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  // 버튼 이름(개인 1:1 대화) 판정 재료 — 폰 에이전트 탭을 아직 안 열었거나 데스크톱(myAgents를 읽지 않는다)이면, 조직 화면에 내 에이전트가 보일 때 세션에 한 번만 읽는다
  // (요청 2건, 주기 호출 없음 — 실패해도 다시 묻지 않고 지금 문구). 그 뒤 폰은 종전대로 에이전트 탭에서 새로 읽는다.
  const myAgentsAsked = useRef(false);
  useEffect(() => { if (myAgentsAsked.current || myAgents !== null || !uid || !orgId || orgId === PERSONAL || !crews.some((c) => c.owner_user_id === uid)) return; myAgentsAsked.current = true; loadMyAgents({ reuse: true }).catch(() => {}); }, [uid, orgId, crews, myAgents]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 공간의 에이전트·대화를 열 때 — 공간을 바꾸고, 그 공간 목록이 도착하면 그때의 최신 함수로 연다(옛 렌더의 함수는 옛 공간 목록을 본다)
  const afterSpace = useRef(null); const latestOpen = useRef({});
  latestOpen.current = { dmWithCrew, openPersonalCrewDm, setSheet, crewOf, note: setNote, orgBlocked, moveNotice: showMoveNotice }; // orgBlocked: 동의 전 조직이면 카드 대신 이유(openAgentCard)
  const runInSpace = (space, run, tag = null) => { if (orgId === space && loadedOrg.current === space) { run(latestOpen.current); return; } afterSpace.current = { space, run, tag }; setOrgId(space); };
  useEffect(() => { const a = afterSpace.current; if (!a || a.space !== orgId || loadedOrg.current !== orgId) return; afterSpace.current = null; a.run(latestOpen.current); }, [orgId, channels, crews]); // eslint-disable-line react-hooks/exhaustive-deps
  // 토스트를 누르면 — 언제나 바로 닫는다. 공간 전환 안내가 떠 있으면 직전 조직으로 돌아간다(공간 전환 = runInSpace, 떠날 때 남긴 공간 저장본이 그 조직의 목록·보던 채널을 바로 연다)
  const tapToast = () => { const back = !err && moveNote?.text === note ? spaceMoveBack(moveNote, orgs) : null; clearToast(); if (back) runInSpace(back.space, () => { if (back.ch) setChId(back.ch); setPage('chat'); setRail(false); }); };
  // 그룹 대화 만들기(유건 2026-09-15): 사람·크루를 여럿 골라 dm 채널 하나로. 서버 msgr_create_channel은 others 여러 명을 받는다(크루는 소유자 동반 규칙 그대로).
  const createGroupDm = async (picks) => { // picks: [{ kind: 'user'|'crew', id }]
    setDmGroup(false); // 시트는 어느 경로든 닫는다(검수 HIGH-1: 한 명 경로에서 대화 위를 덮었다)
    if (picks.length === 1) return openDm(picks[0].kind, picks[0].id); // 한 명이면 1:1(있으면 재사용)
    if (isPersonal) { // 개인 공간 그룹 = 친구 여럿과 조직 밖 방(서버가 친구 여부·같은 구성 재사용을 판정한다)
      try {
        const people = picks.filter((p) => p.kind === 'user').map((p) => p.id);
        const agentIds = picks.filter((p) => p.kind === 'crew' && crewOf(p.id)?.owner_user_id === uid).map((p) => p.id);
        if (agentIds.length && needPersonalConsent()) return null;
        // 사람이 한 명이면 그 친구와의 1:1, 없으면 첫 에이전트와의 1:1에 나머지 에이전트를 넣는다(2026-09-30)
        const cid = people.length >= 2 ? await q(supabase.rpc('msgr_dm_personal_group', { targets: people, title: people.map(nameOfUser).join(', ').slice(0, 76) }))
          : people.length === 1 ? await q(supabase.rpc('msgr_dm_personal', { target: people[0] })) : await q(supabase.rpc('msgr_dm_personal_crew', { crew: agentIds.shift() }));
        const failed = [];
        for (const id of agentIds) { const r = await supabase.rpc('msgr_crew_join', { ch: cid, crew: id }); if (r.error) failed.push(`${crewOf(id)?.display_name ?? '?'}: ${joinErr(r.error.message, t)}`); }
        if (failed.length) setErr(failed.join('\n'));
        await loadPersonal(); if (activeOrg.current !== PERSONAL) return null; setChId(cid); setPage('chat'); setRail(false); return cid;
      } catch (e) { setErr(/msgr_group_blocked_pair/.test(e.message) ? t('dm.group.err.blocked') : /msgr_not_friend/.test(e.message) ? t('dm.group.err.notFriend') : e.message); if (activeOrg.current === PERSONAL) setDmGroup(true); return null; }
    }
    try {
      const others = []; const seen = new Set();
      const add = (kind, id) => { const k = `${kind}:${id}`; if (!seen.has(k)) { seen.add(k); others.push({ kind, id }); } };
      for (const p of picks) { add(p.kind, p.id); if (p.kind === 'crew') { const o = crewOf(p.id)?.owner_user_id; if (o && o !== uid) add('user', o); } }
      // 같은 멤버 조합의 방이 이미 있으면 그 방으로(검수 LOW-2: 만들 때마다 동명 방이 늘던 것)
      const want = new Set([...seen, `user:${uid}`]);
      const existing = channels.find((c) => c.kind === 'dm' && !c.archived_at && (() => { const ms = dmMembers[c.id] ?? []; return ms.length === want.size && ms.every((m) => want.has(`${m.member_kind}:${m.member_id}`)); })());
      if (existing) { setChId(existing.id); setPage('chat'); setRail(false); return existing.id; }
      const names = picks.map((p) => p.kind === 'crew' ? crewOf(p.id)?.display_name : nameOfUser(p.id)).filter(Boolean);
      const cid = await q(supabase.rpc('msgr_create_channel', { org: orgId, kind: 'dm', name: `dm:${names.join(', ')}`.slice(0, 80), others }));
      await loadOrg(orgId); if (activeOrg.current !== orgId) return null; setChId(cid); setPage('chat'); setRail(false); return cid;
    } catch (e) { setErr(e.message); if (activeOrg.current === orgId) setDmGroup(true); return null; } // 공간이 바뀌었으면 되살리지 않는다(3R) // 생성이 실패하면 시트를 되살려 고른 사람이 사라지지 않게(재검수 LOW-A)
  };
  // 대화방에 사람을 더 부르기(유건 2026-09-16) — 지금 방의 구성원에 그 사람을 더해 **새 방**을 연다.
  // 지금 방에 밀어 넣지 않는 이유: 둘이 나눈 사적인 대화가 불려 온 사람에게 통째로 넘어간다(슬랙도 새 방을 연다). 서버도 그 길을 막아 둔다.
  const widenDm = async (userId) => {
    const ms = dmMembers[chId] ?? [];
    const picks = [...ms.filter((m) => !(m.member_kind === 'user' && m.member_id === uid)).map((m) => ({ kind: m.member_kind, id: m.member_id })), { kind: 'user', id: userId }];
    setChSheet(false);
    return createGroupDm(picks);
  };
  // 전달(relay) 알림에서 대상 1:1로 이동 — 목록에 있으면 바로 연다. 없으면 방금 트리거가 만든 방일 수 있어 다시 불러온 뒤 찾고,
  // 그래도 없으면(다른 조직 전환 등) openDm이 그 사람·크루의 방을 찾거나 만든다(msgr_dm_for_crew와 같은 멤버 판정). 빈 화면 방지(검수 MEDIUM).
  const openRelay = async (crewId, channelId) => {
    try {
      if (channels.some((c) => c.id === channelId)) { setChId(channelId); setPage('chat'); setRail(false); return; }
      const fresh = await loadOrg(orgId);
      if (activeOrg.current !== orgId) return;
      if (fresh?.some((c) => c.id === channelId)) { setChId(channelId); setPage('chat'); setRail(false); return; }
      if (crewId) await dmWithCrew(crewId);
    } catch (e) { setErr(e.message); }
  };
  const createChannel = async ({ name, kind } = newCh ?? {}) => {
    if (!name?.trim()) return;
    const priv = kind === 'private';
    try {
      if (channels.some((c) => c.kind !== 'dm' && c.name.toLowerCase() === name.trim().toLowerCase())) return setErr(t('ch.dup')); // 검수 M-2: 이름이 기억 페이지 밖에서도 표시 키라 동명은 막는다
      const id = await q(supabase.rpc('msgr_create_channel', { org: orgId, kind: priv ? 'private' : 'public', name: name.trim() })); // 생성+첫 멤버를 서버가 한 번에(생성 직후 열람 예외 폐지 — 검수 HIGH)
      if (!priv) { await q(supabase.rpc('msgr_join_channel', { ch: id })); joinedRef.current = new Set([...joinedRef.current, id]); } // 서버가 공개 채널은 만든 사람을 참여 행에 안 넣는다(kind<>'public'만) — 옛 서버에서도 참여자로(#626 검수, 서버 수정은 별도). 이미 참여면 서버가 무시
      if (activeOrg.current !== orgId) return; setNewCh(null); await loadOrg(orgId); if (activeOrg.current !== orgId) return; setChId(id); setPage('chat'); setRail(false); // 폼을 보이려 연 서랍(폰·좁은 폭)은 만든 채널을 가리지 않게 닫는다
    } catch (e) { setErr(friendlyErr(e.message, t)); }
  };
  // 새 채널 기본 종류(D1): 조직에 공개 채널이 없으면 공개(#general), 있으면 비공개(안내 문구 ch.step1.sub*도 같은 판단) — 채널 수 한도는 없다(2026-09-27)
  const hasPublic = hasPublicChannel(channels, previewChannels);
  const newChKind = newChannelKind(channels, previewChannels);
  const openNewCh = () => { setNewCh({ name: '', kind: newChKind }); if (!isPhone) setRail(true); }; // 폰은 채널 탭 목록 맨 위에 칸이 열린다(서랍 없음)
  // 조직 시작 단계 재료(D1·D3·D6) — 빈 조직 안내와 첫 채널 뒤 남은 단계 카드가 같이 쓴다
  const onboard = { hasPublic, invited: members.length > 1, hasCrew: crews.length > 0, isAdmin: !!isAdmin, adminName: orgAdmins[0]?.display_name || null,
    openAgents: () => { setSettingsTab('crews'); setPage('settings'); setRail(false); }, openRunner: () => setRunnerOpen(true) };
  const joinWithCode = () => { if (!isPhone) setRail(true); setOrgMenu(true); setJoinCode(''); setJoinHint(null); setNewOrg(null); }; // D4: 안내 문구가 가리키는 그 메뉴를 바로 연다
  // 채널 찾아보기(유건 2026-09-16) — 조직의 공개 채널 중 아직 안 들어간 것. 들어가야 목록·알림에 뜬다.
  const [browse, setBrowse] = useState(null); // null = 닫힘, [] = 없음, [..] = 목록
  // 폰: 새 채널 칸·채널 찾아보기가 열린 채 바깥을 누르면 먼저 닫는다 — 그 누름이 아래 대화로 들어가던 제보(유건 2026-09-29)
  useDismiss(isPhone && !!newCh, () => setNewCh(null), '.msgr-inline, .msgr-chnew, .msgr-addrow', '.msgr-chnew', true);
  useDismiss(isPhone && !!browse, () => setBrowse(null), '.msgr-browse, .msgr-chbrowse', '.msgr-chbrowse', true);
  const openBrowse = async () => {
    if (!orgId || isPersonal) return;
    if (!isPhone) setRail(true);
    try { setBrowse(await q(supabase.rpc('msgr_browse_channels', { org: orgId })) ?? []); } catch (e) { setErr(e.message); }
  };
  const joinChannel = async (c) => {
    try {
      await q(supabase.rpc('msgr_join_channel', { ch: c.id }));
      setBrowse((list) => (list ?? []).filter((x) => x.id !== c.id));
      joinedRef.current = new Set([...joinedRef.current, c.id]);
      const chs = await loadOrg(orgId);
      if (chs?.some((x) => x.id === c.id)) setChId(c.id);
      setNote(t('ch.browse.joined', { name: c.name }));
    } catch (e) { setErr(e.message); }
  };
 // 기본 비공개(유건 2026-09-16) — 공개는 고를 때만
  const [ctx, setCtx] = useState(null); // 우클릭 메뉴 {x, y, items}
  const [drag, setDrag] = useState(null); // 즐겨찾기 안에서 끌어 정렬 중인 id
  // 공간 전환(기능 점검 D3) — 떠나는 공간의 다 불러온 목록을 저장하고, 돌아갈 공간에 저장본이 있고 그 사이 방송이 없었으면(dirtySpaces) 저장본으로 바로 연다.
  // 저장본으로 연 공간은 목록·안 읽음·마지막 글 조회를 건너뛴다(restoredSpace — 같은 커밋의 효과들이 본 뒤 아래 효과가 비운다). 없거나 바뀌었으면 종전처럼 비우고 다시 읽는다.
  const spaceSnap = useRef(null);
  spaceSnap.current = { channels, previewChannels, members, crews, myAvailable, lastAt, lastMsg, chId, dmMembers, ent, policy, unread, unreadSpace, chCount, botKinds, otherNames, targetPrefs };
  const prevSpace = useRef(null); const restoredSpace = useRef(null);
  useLayoutEffect(() => {
    const prev = prevSpace.current; prevSpace.current = orgId;
    if (prev && prev !== orgId && loadedOrg.current === prev) { spaceCache.current.set(prev, spaceSnap.current); dirtySpaces.current.delete(prev); }
    const hit = orgId && !dirtySpaces.current.has(orgId) ? spaceCache.current.get(orgId) ?? null : null;
    restoredSpace.current = hit ? { space: orgId, sync: syncEpoch, prefs: prefsEpoch } : null; // 머무는 동안 유지 — 다시 읽기 신호(syncEpoch·설정 변경)가 오면 각 효과가 무효로 본다
    loadedOrg.current = hit ? orgId : null;
    const d = hit ?? {};
    setChannels(d.channels ?? []); setPreviewChannels(d.previewChannels ?? []); setMembers(d.members ?? []); setCrews(d.crews ?? []); setMyAvailable(d.myAvailable ?? []); setLastAt(d.lastAt ?? {}); setLastMsg(d.lastMsg ?? {}); setChId(d.chId ?? null); setChMembers([]); setDmMembers(d.dmMembers ?? {}); setEnt(d.ent ?? null); setPolicy(d.policy ?? null); setUnread(d.unread ?? {}); setUnreadSpace(d.unreadSpace ?? null); setChCount(d.chCount ?? {}); setBotKinds(d.botKinds ?? []);
    if (hit) { setOtherNames(d.otherNames ?? {}); setTargetPrefs(d.targetPrefs ?? []); }
    setCtx(null); setDrag(null); setRailAction(null); setSheet(null); setChSheet(false); setSearchRes(null); setNewCh(null); setDmGroup(false); // 그룹 대화 시트는 공간을 넘기지 않는다(개인 공간에서 여러 명 생성이 __personal__로 가던 길)
  }, [orgId]);
  const openCtx = (e, items, trigger = null) => { e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); const returnFocus = e.currentTarget.closest('.msgr-railrow')?.querySelector('button.item') ?? e.currentTarget; setCtx({ x: e.clientX || r.left, y: e.clientY || r.bottom, items, trigger, returnFocus }); };
  useEffect(() => { const h = (e) => { if (!e.target.closest?.('input, textarea, [contenteditable="true"], a[href]')) e.preventDefault(); }; document.addEventListener('contextmenu', h); return () => document.removeEventListener('contextmenu', h); }, []); // 웹뷰 기본 메뉴(다시 로드 등)는 입력창 밖에서는 띄우지 않는다
  // 훅은 전부 위 조기 return 앞에(실측 2026-09-12: 뒤에 두면 'Rendered more hooks')
  const swipeLive = useRef({}); swipeLive.current = { channels, togglePin: (c) => togglePin(c), toggleMute: (c) => toggleMute(c) };
  useEffect(() => { // 폰 채팅·채널 탭 목록 줄 밀기 — 끝까지 민 동작: 오른쪽 고정(즐겨찾기), 왼쪽 알림 끄기
    if (!isPhone || !(page === 'chats' || page === 'channels')) return undefined;
    const el = document.querySelector('.msgr-side .msgr-railbody'); if (!el) return undefined;
    return bindRowSwipe(el, { blocked: () => !!touchDrag.current, onFull: (id, dir) => { const c = swipeLive.current.channels.find((x) => x.id === id); if (!c) return; if (dir === 'lead') swipeLive.current.togglePin(c); else swipeLive.current.toggleMute(c); } });
  }, [isPhone, page, orgId]); // eslint-disable-line react-hooks/exhaustive-deps
  const touchDrag = useRef(null); // { id, el, onDrop, startX, startY, moved, rows } — 아래 조기 반환보다 먼저(훅 순서, 2026-09-29 실측: 반환 뒤에 두면 조직 로딩 직후 'Rendered more hooks' 로 앱 전체가 멈췄다)
  // 길게 눌러 끌기 대기 중엔 브라우저 스크롤을 막는다 — 막지 않으면 23px쯤 움직였을 때 pointercancel이 와 드롭이 사라졌다(2026-09-29 실측).
  // React의 onTouchMove는 passive라 preventDefault가 안 먹어 문서에 직접 단다.
  // 안전망(검수 LOW): 끄는 중 행이 사라지면(DM 삭제·필터 전환) 그 행의 pointerup이 안 와 끌기 상태가 남고 위 리스너가 앱 전체 스크롤을 막는다 → 창 수준에서 한 번 더 정리
  useEffect(() => {
    const f = (e) => { if (touchDrag.current) e.preventDefault(); };
    const end = (e) => { const d = touchDrag.current; if (!d || (d.pid != null && e.pointerId !== d.pid)) return; setTimeout(() => { if (touchDrag.current !== d) return; touchDrag.current = null; d.el.removeAttribute('data-lift'); d.el.style.removeProperty('transform'); d.container?.querySelectorAll('[data-drop]').forEach((n) => n.removeAttribute('data-drop')); setDrag(null); }, 0); };
    document.addEventListener('touchmove', f, { passive: false }); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    return () => { document.removeEventListener('touchmove', f); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, []);
  // 채팅·채널 탭 검색의 본문 찾기(기능 점검 D9) — 목록은 마지막 글만 알아서 예전 대화를 못 찾았다. 서버 msgr_tab_search가 내가 든 방만, 방마다 최근 500개 글
  // 안에서 찾아 맞은 방 id만 돌려준다(차단한 사람·숨긴 에이전트 글 제외 — 20261002150000). 공간 전체 글을 입력마다 ilike로 훑던 것을 줄였다(분리 검수 MEDIUM 2026-10-02).
  // 검색 칸을 연 동안, 두 글자부터, 입력이 300ms 멈췄을 때 한 번(유휴 0, 칸을 닫으면 요청 없음). 차단·숨김이 바뀌면 다시 찾는다.
  const [tabHits, setTabHits] = useState(null); // { space, q, ids: Set }
  const tabBodyQ = isPhone && (page === 'chats' || page === 'channels') ? tabBodyQuery(tabQ) : null;
  useEffect(() => {
    if (!tabBodyQ || !uid) { setTabHits(null); return undefined; }
    const space = orgId; let off = false;
    const timer = setTimeout(async () => {
      const rows = await q(supabase.rpc('msgr_tab_search', { org: space === PERSONAL ? null : space, q: tabBodyQ })).catch((e) => { pushDiag('tab-search', e?.message ?? e); return []; }); // 방마다 최근 500개 글 안에서만 — 더 오래된 글은 '전체에서 찾기'로
      if (off) return;
      setTabHits({ space, q: tabBodyQ, ids: new Set((rows ?? []).map((r) => r.channel_id)) });
    }, 300);
    return () => { off = true; clearTimeout(timer); };
  }, [tabBodyQ, uid, orgId, blockedIds, mutedCrewIds]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (orgs !== null) markAppReady(); }, [orgs]); // 스플래시 준비 신호 — 조직을 불러온 뒤(조기 반환 앞, 훅 순서)
  if (orgs === null) return <div className="msgr-auth"><span className="msgr-klabel">{t('ui.loading')}</span></div>;
  const joinedChannel = loadedOrg.current === orgId ? channels.find((c) => c.id === chId) : undefined;
  const previewing = !joinedChannel && loadedOrg.current === orgId && !isPersonal ? previewChannels.find((c) => c.id === chId) : undefined;
  const archivedView = !joinedChannel && !previewing && loadedOrg.current === orgId && !isPersonal ? archivedRoomFor(earlierRoom, { orgId, chId }) : undefined; // 이전 대화 보기로 연 보관 방 — 읽기 전용
  const channel = joinedChannel ?? previewing ?? archivedView;
  // 채널 중심 구조(유건 지시 2026-09-04): 레일은 채널·1:1만, 크루·멤버는 "이 채널의 구성"으로 본다. 공개 채널 = 조직 멤버 전원 + 이 채널에서 일할 수 있는 크루(채널 정책), 비공개·DM = 채널 멤버.
  const usableCrews = limitsPersonal(channel) ? crews.filter((c) => crewTier(c, org) === 'company') : crews;
  // 이 채널의 사람 = 참여한 사람(공개 채널도 — #555 이후 참여 기준). 공개 채널에서 내보낸 사람은 제외 목록으로도 걸러 낸다(유건 요청 2026-09-11).
  // 종전에는 공개 채널이면 조직원 전원을 보여 줘, 참여하지 않은 사람까지 "이 채널의 사람"에 떴다(유건 제보 2026-09-16).
  // 개인 공간: members는 친구 목록뿐이라 나·친구 아닌 구성원이 빠져 "사람 더 부르기"가 안 보이고 인원도 틀렸다(검수 HIGH-2) — 방 구성원에서 만든다
  const chPeople = !channel ? [] : isPersonal ? (dmMembers[channel.id] ?? []).filter((x) => x.member_kind === 'user').map((x) => ({ user_id: x.member_id, display_name: nameOfUser(x.member_id), role: x.member_id === uid ? null : members.some((f) => f.user_id === x.member_id) ? 'friend' : null })) : members.filter((m) => chMembers.some((x) => x.member_kind === 'user' && x.member_id === m.user_id) && !(channel.kind === 'public' && (channel.excluded_user_ids ?? []).includes(m.user_id)));
  // @멘션 후보는 따로 둔다 — 공개 채널은 누구나 읽을 수 있고, 멘션하면 참여하지 않은 사람에게도 알림이 간다(msgr_push_recipients의 멘션 분기, 슬랙과 같다).
  const mentionPeople = channel?.kind === 'public' ? members.filter((m) => !(channel.excluded_user_ids ?? []).includes(m.user_id)) : chPeople;
  // 이 채널의 에이전트 = 초대된(참여 행이 있는) 에이전트. 공개 채널도 같다 — 종전에는 파견된 에이전트 전원이 저절로 들어와 있었다(유건 2026-09-16).
  const chCrews = !channel ? [] : usableCrews.filter((c) => chMembers.some((x) => x.member_kind === 'crew' && x.member_id === c.id) && !(channel.excluded_crew_ids ?? []).includes(c.id));
  // 채널 칩 — 정렬: 현재 → 이름순. 6개 초과는 '+N'(펼치기)
  // DM 라벨 = 나 아닌 참가자(검수 MEDIUM-2: 저장된 이름은 생성자 시점). 크루 DM에 다른 사람도 있으면(소유자 동반) '서윤 · 민수'처럼 병기
  // 그룹 판정 정본(검수 HIGH-2): 나를 뺀 참가자(사람+크루)가 2 이상이면 그룹. 단 "사람 1 + 크루 1이고 그 사람이 그 크루의 소유자"는 남의 크루 1:1(소유자 동반 규칙)
  const traitsOf = (c) => roomTraits({ c, members: dmMembers[c.id] ?? [], uid, ownerOf: (id) => crewOf(id)?.owner_user_id ?? null }); // 그룹·에이전트 방 판정 정본(phone-shell.mjs — 단위 테스트 대상)
  const dmIsGroup = (c) => traitsOf(c).group;
  const dmName = (c) => dmBaseName(c);
  const dmBaseName = (c) => { const ms = dmMembers[c.id] ?? []; const crew = ms.find((m) => m.member_kind === 'crew'); const other = ms.find((m) => m.member_kind === 'user' && m.member_id !== uid); const base = c.name.replace(/^dm:/, ''); const crewName = crew ? (crewOf(crew.member_id)?.display_name ?? base) : (crews.some((k) => k.display_name === base) ? base : null); // 해제 sweep으로 크루가 빠진 1:1도 크루명 유지(사람 1:1과 이름이 겹치던 실측 2026-09-09)
    const people = ms.filter((m) => m.member_kind === 'user' && m.member_id !== uid); const crewsIn = ms.filter((m) => m.member_kind === 'crew');
    if (c.org_id == null && c._personal_other && !c._personal_group && !c._personal_crew && other) return nameOfUser(other.member_id); // 개인 1:1은 에이전트가 들어와도 친구 이름(2026-09-30 — 에이전트 이름이 앞에 붙던 것)
    if (dmIsGroup(c)) { const names = [...crewsIn.map((m) => crewOf(m.member_id)?.display_name), ...people.map((m) => nameOfUser(m.member_id))].filter(Boolean).join(', ');
      return c._personal_group && people.length <= 1 ? `${names || base} · ${t('dm.group.tag')}` : (names || base); } // 한 명만 남은 개인 그룹이 같은 이름의 1:1과 구별되게(검수 MEDIUM-1) // 그룹 대화 = 멤버 이름 나열(판정 정본 dmIsGroup — 검수 HIGH-2)
    return [crewName, other ? nameOfUser(other.member_id) : null].filter(Boolean).join(' · ') || base; };
  const targetFavs = targetPrefs.filter((p) => p.pinned).flatMap((p) => {
    const target = p.target_kind === 'crew' ? crews.find((c) => c.id === p.target_id) : members.find((m) => m.user_id === p.target_id);
    return target ? [{ id: `target:${p.target_kind}:${p.target_id}`, kind: 'target', targetKind: p.target_kind, targetId: p.target_id, name: target.display_name || nameOfUser(p.target_id), pin_pos: p.pin_pos }] : [];
  });
  // 레일 두 절(src/rail-rooms.mjs — 단위 테스트 대상): 즐겨찾기한 방은 채팅 절에서 빠지고 즐겨찾기 절에만 있다. 개인 공간도 즐겨찾기 절을 그린다(2026-10-08 — 감추던 탓에 즐겨찾기한 1:1이 넓은 화면에서 사라졌다). 글 없는 개인 1:1은 채팅 절에서 뺀다(D13)
  const railRoom = railRooms({ channels, pinned, pinPos, targets: targetFavs, hidden: (c) => emptyPersonalDm(c, lastMsg[c.id]), blocked: orgBlocked, space: orgId });
  const { favs, dms } = railRoom;
  const dmTab = isPhone && (page === 'dm' || swipeTo === 'dm'); // 스와이프로 DM에 돌아가는 중에도 DM 탭 모양(밑 화면이 전환 순간 다시 그려지지 않게) // 폰 DM 탭에서만: 고정(즐겨찾기) DM을 맨 위에 + 선택한 정렬
  const dmSorted = (list) => sortDms(list, { sort: dmSort, lastAt, unread, nameOf: dmName, sortPos: dmSortPos }); // 순수 함수(src/dm-sort.mjs) — 단위 테스트 대상
  const dmPinnedTop = dmTab ? channels.filter((c) => c.kind === 'dm' && pinned.has(c.id)).sort((a, b) => (pinPos.get(a.id) ?? 1e9) - (pinPos.get(b.id) ?? 1e9)) : [];
  // DM 탭 필터(슬랙식): 전체 = 고정 단락 + 나머지, 즐겨찾기 = 고정만, 안읽음·그룹 = 고정 포함 전체에서 거른다. 그룹 판정은 위 dmIsGroup(정본)
  const dmWho = (c, m) => m.mine ? t('dm.snip.me').trim() : m.crewId ? (crews.find((x) => x.id === m.crewId)?.display_name ?? dmName(c)) : nameOfUser(m.userId); // 스니펫·미리보기 발신자(검수 M-5)
  const dmSnipWho = (c, m) => m.mine ? t('dm.snip.me') : (dmIsGroup(c) ? `${dmWho(c, m)}: ` : '');
  const dmVisible = (c) => dmFilter === 'all' || (dmFilter === 'fav' && pinned.has(c.id)) || (dmFilter === 'unread' && unread[c.id]?.n > 0 && !muted.has(c.id)) || (dmFilter === 'group' && dmIsGroup(c));
  const dmPool = dmFilter === 'all' ? dms : [...dmPinnedTop, ...dms];
  const dmList = !dmTab ? (isPhone && dmSort === 'custom' ? dmSorted(dms) : dms) : dmFilter === 'fav' ? dmPinnedTop : dmSorted(dmPool.filter(dmVisible)); // dms는 이미 고정 제외 — 전체 탭의 고정은 아래 별도 단락, 즐겨찾기 탭은 고정 순서 그대로(검수 L-6)
  const dmPinnedShown = dmTab && dmFilter === 'all' ? dmPinnedTop : [];
  const chBase = [...channels].filter((c) => c.kind !== 'dm' && !pinned.has(c.id)).sort((a, b) => (a.kind === 'private') - (b.kind === 'private') || a.name.localeCompare(b.name)); // 공개 먼저·이름순 고정(선택한 채널을 위로 끌어올리면 목록이 뛴다)
  const sortedCh = isPhone && chBase.some((c) => dmSortPos[c.id] != null) ? sortByCustomOrder(chBase, dmSortPos, (c) => c.name) : chBase; // 폰에서 한 번이라도 끌어 옮겼으면 그 순서(유건 2026-09-29 "어디든 꾹 눌러 배치") — 데스크톱은 종전 순서(DM과 같은 규칙, 검수 M2) — sort_pos는 채널·DM 공용 표(msgr_channel_prefs)
  const reorderFav = async (dragId, beforeId = null, visible = null) => {
    if (favoriteLock.current) return;
    const ids = reorderVisibleInFull(favs.map((c) => c.id), visible ?? favs.map((c) => c.id), dragId, beforeId); // 채팅 탭 고정 단락은 즐겨찾기의 일부(DM만)
    if (sameOrder(ids, favs.map((c) => c.id))) return; // 제자리(검수 M1)
    favoriteLock.current = true; setFavoriteBusy(true);
    const channelPatches = []; const targetPatches = [];
    ids.forEach((id, i) => { const c = favs.find((f) => f.id === id); if (c.kind === 'target') targetPatches.push({ target_kind: c.targetKind, target_id: c.targetId, pin_pos: i }); else channelPatches.push({ channel_id: id, pin_pos: i }); });
    try {
      await prefQueue.current.enqueue(async () => {
        if (channelPatches.length) await q(supabase.from('msgr_channel_prefs').upsert(channelPatches.map((p) => ({ ...p, user_id: uid }))));
        await saveTargetPrefs(targetPatches);
      });
      if (activeOrg.current === orgId) {
        setPinPos((m) => { const next = new Map(m); channelPatches.forEach((p) => next.set(p.channel_id, p.pin_pos)); return next; });
        setTargetPrefs((rows) => rows.map((p) => ({ ...p, pin_pos: targetPatches.find((x) => x.target_kind === p.target_kind && x.target_id === p.target_id)?.pin_pos ?? p.pin_pos })));
      }
    } catch (e) { setErr(friendlyErr(e.message, t)); }
    finally { favoriteLock.current = false; setFavoriteBusy(false); bumpPrefs(); }
  };
  // DM 탭 '직접 배치' 순서(유건 확정 2026-09-29) — msgr_channel_prefs.sort_pos. 새로 생긴 DM은 sortByCustomOrder가 맨 아래로(sort_pos 없음).
  // 채널 목록도 같은 열(유건 2026-09-29) — 걸러 보이는 일부에서 끌어도 전체 순서에 반영한다(검수 MEDIUM-1: 부분 목록만 0..k로 매기면 전체가 섞였다). 위치가 바뀐 행만 쓴다(DB 위생)
  const sameOrder = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
  const reorderChannelPos = async (full, dragId, beforeId = null, visible = null, onMoved = null) => {
    const base = full.map((c) => c.id); const ids = reorderVisibleInFull(base, visible ?? base, dragId, beforeId);
    if (sameOrder(ids, base)) return; // 제자리에 놓으면 정렬 전환도 쓰기도 없다(검수 M1)
    onMoved?.();
    const now = new Date().toISOString();
    const rows = ids.map((id, i) => ({ channel_id: id, sort_pos: i, user_id: uid, updated_at: now })).filter((r) => dmSortPos[r.channel_id] !== r.sort_pos);
    if (!rows.length) return;
    try {
      await prefQueue.current.enqueue(() => q(supabase.from('msgr_channel_prefs').upsert(rows)));
      setDmSortPos((m) => { const next = { ...m }; ids.forEach((id, i) => { next[id] = i; }); return next; });
    } catch (e) { setErr(friendlyErr(e.message, t)); }
  };
  // DM을 끌면 그 정렬이 '직접 배치'로 바뀐다 — 지금 보이는 순서에서 옮긴 자리만 달라진다. 홈·채팅 탭이 같은 순서를 쓴다
  const reorderDmCustom = (dragId, beforeId = null, visible = null) => reorderChannelPos(dmTab ? dmSorted(dmPool) : dmList, dragId, beforeId, visible, () => { if (dmSort !== 'custom') pickDmSort('custom'); });
  const reorderChannels = (dragId, beforeId = null, visible = null) => reorderChannelPos(sortedCh, dragId, beforeId, visible);

  // 폰 '직접 배치' 길게 눌러 끌기(유건 확정 2026-09-29 #9 — 1차 구현, 자동 스크롤 제외) — 길게 눌러도 8px 이상 움직여야 진짜 드래그로 본다.
  // 안 움직이고 놓으면(탭-홀드) 기존처럼 행 메뉴가 열린다 — DM 탭은 점 세 개 버튼이 없어 길게 누르기가 메뉴로 가는 유일한 길이라(유건 2026-09-15) 그 경로를 남겨 둔다.
  const beginTouchDrag = (id, el, onDrop, x, y, pid = null) => { touchDrag.current = { id, el, onDrop, startX: x, startY: y, moved: false, rows: [], pid }; }; // pid: 끄는 손가락 — 창 수준 안전망이 다른 손가락의 pointerup에 반응하지 않게
  // 끄는 동안 행이 손가락을 따라오고(들어 올린 모양), 놓을 자리엔 선을 긋는다 — 흐려진 행만 제자리에 있어 어디로 가는지 안 보였다(2026-09-29 점검)
  const markDropAt = (d, y) => { const before = dropBeforeIdAtY(d.rows, y); d.container?.querySelectorAll('[data-drop]').forEach((n) => n.removeAttribute('data-drop'));
    const at = before ? d.container?.querySelector(`[data-drag-id="${before}"]`) : d.container?.querySelector(`[data-drag-id="${d.rows.at(-1)?.id}"]`);
    at?.setAttribute('data-drop', before ? 'before' : 'after'); };
  const clearTouchDrag = (d) => { if (!d) return; d.el.removeAttribute('data-lift'); d.el.style.removeProperty('transform'); d.container?.querySelectorAll('[data-drop]').forEach((n) => n.removeAttribute('data-drop')); };
  const moveTouchDrag = (x, y) => {
    const d = touchDrag.current; if (!d) return;
    if (!d.moved) {
      if (Math.hypot(x - d.startX, y - d.startY) < 8) return;
      d.moved = true;
      d.container = d.el.closest('.msgr-list, .msgr-folder');
      d.rows = d.container ? [...d.container.querySelectorAll('[data-drag-id]')].filter((n) => n.dataset.dragId !== d.id).map((n) => { const r = n.getBoundingClientRect(); return { id: n.dataset.dragId, top: r.top, height: r.height }; }) : [];
      setCtx(null); // 길게 눌러 뜬 메뉴는 움직이는 순간 닫고 끌기로(iOS 방식)
      d.el.setAttribute('data-lift', ''); // 클래스가 아니라 data 속성 — setDrag 재렌더가 className을 다시 써 지웠다(2026-09-29 실측)
      setDrag(d.id); // 데스크톱 드래그와 같은 .dragging 표시(폰은 [data-lift]가 흐림 대신 들어 올림으로 바꾼다)
    }
    d.el.style.transform = `translateY(${y - d.startY}px)`;
    markDropAt(d, y);
  };
  const endTouchDrag = (y) => {
    const d = touchDrag.current; touchDrag.current = null;
    clearTouchDrag(d);
    if (d?.moved) { d.onDrop(d.id, dropBeforeIdAtY(d.rows, y), d.rows.map((r) => r.id)); setDrag(null); }
    return !!d?.moved;
  };
  const cancelTouchDrag = () => { const d = touchDrag.current; touchDrag.current = null; clearTouchDrag(d); if (d?.moved) setDrag(null); };
  const dragStart = (c) => (e) => { setDrag(c.id); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', c.id); } catch { /* 웹뷰 차이 */ } };
  const dragOver = (e) => { if (drag) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } };
  const dropOnRow = (e, c) => { e.preventDefault(); e.stopPropagation(); const id = drag; setDrag(null); if (!id || id === c.id) return;
    if (favs.some((f) => f.id === id) && favs.some((f) => f.id === c.id)) return reorderFav(id, c.id); // 끌어서 옮기는 것은 즐겨찾기 안의 순서
    if (dmTab && dmSort === 'custom' && dmFilter === 'all' && !pinned.has(id) && !pinned.has(c.id) && c.kind === 'dm' && dmList.some((x) => x.id === id) && dmList.some((x) => x.id === c.id)) return reorderDmCustom(id, c.id); // DM 탭 직접 배치 — 순서가 보이는 폰 채팅 탭에서만(데스크톱 레일은 정렬을 안 쓰는데 끌면 안 보이는 순서가 저장됐다, 2026-09-29 실측)
    if (railSort === 'custom' && myCrews.some((x) => x.id === id) && myCrews.some((x) => x.id === c.id)) return reorderRailCustom(id, c.id); // '내 에이전트' 직접 배치(내 소유 크루만)
  };
  const orderItems = (c) => { const at = favs.findIndex((f) => f.id === c.id); return at < 0 ? [] : [
    { icon: 'star', label: t('rail.order.up'), disabled: favoriteBusy || at === 0, run: () => reorderFav(c.id, favs[at - 1]?.id) },
    { icon: 'star', label: t('rail.order.down'), disabled: favoriteBusy || at === favs.length - 1, run: () => reorderFav(c.id, favs[at + 2]?.id ?? null) },
  ]; };
  // '내 에이전트' = 세 출처 한 목록(유건 지시 2026-09-08): 아르고 에이전트 + 내가 연결한 헤르메스·오픈클로(봇). 출처 표시는 msgr_bots.kind.
  const sourceOf = (c) => c.hosting !== 'bot' ? 'argo' : (botKinds.find((b) => b.crew_id === c.id)?.kind ?? c.bot_kind ?? 'custom'); // 개인 공간 봇 쌍둥이는 서버가 bot_kind를 준다(2026-10-01)
  const railSortPos = Object.fromEntries(targetPrefs.filter((p) => p.target_kind === 'crew' && p.sort_pos != null).map((p) => [p.target_id, p.sort_pos])); // '내 에이전트' 직접 배치 순서(유건 확정 2026-09-29)
  const sortCrews = (list) => railSort === 'custom' ? sortByCustomOrder(list, railSortPos, (c) => c.display_name) : [...list].sort((a, b) => railSort === 'added' ? Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0) : a.display_name.localeCompare(b.display_name, 'ko'));
  const myCrews = sortCrews(crews.filter((c) => c.owner_user_id === uid));
  // '내 에이전트' 직접 배치(유건 확정 2026-09-29 — 내 소유 크루만, 회사 소속 railCompany는 대상 밖) — msgr_target_prefs.sort_pos.
  // pinned를 항상 같이 실어 보낸다: 이 테이블은 pinned default true라, sort_pos만 보내 새 행을 만들면 즐겨찾기로 잘못 켜진다(#8).
  // 끌면 정렬이 '직접 배치'로 바뀐다(유건 2026-09-29) — 지금 보이는 순서에서 옮긴 자리만 달라진다. 멤버도 같은 표(target_kind 'user')
  const reorderTargetPos = async (kind, full, dragId, beforeId = null, visible = null, onMoved = null) => {
    if (favoriteLock.current) return;
    const ids = reorderVisibleInFull(full, visible ?? full, dragId, beforeId);
    if (sameOrder(ids, full)) return; // 제자리(검수 M1)
    onMoved?.();
    const pos = (id) => targetPrefs.find((p) => p.target_kind === kind && p.target_id === id)?.sort_pos;
    const patches = ids.map((id, i) => ({ target_kind: kind, target_id: id, sort_pos: i, pinned: targetPinned(kind, id) })).filter((p) => pos(p.target_id) !== p.sort_pos); // 위치가 바뀐 행만(DB 위생)
    if (!patches.length) return;
    favoriteLock.current = true; setFavoriteBusy(true);
    try {
      await prefQueue.current.enqueue(() => saveTargetPrefs(patches));
      if (activeOrg.current === orgId) setTargetPrefs((rows) => [...rows.filter((p) => p.target_kind !== kind || !patches.some((x) => x.target_id === p.target_id)), ...patches.map((x) => ({ ...rows.find((p) => p.target_kind === kind && p.target_id === x.target_id), ...x }))]);
    } catch (e) { setErr(friendlyErr(e.message, t)); }
    finally { favoriteLock.current = false; setFavoriteBusy(false); }
  };
  // 멤버 디렉터리 — 나 먼저·이름순, 한 번이라도 끌어 옮겼으면 그 순서(유건 2026-09-29)
  const peopleBase = [...members].sort((a, b) => (a.user_id === uid ? -1 : b.user_id === uid ? 1 : 0) || String(a.display_name || '').localeCompare(String(b.display_name || '')));
  const peoplePos = Object.fromEntries(targetPrefs.filter((p) => p.target_kind === 'user' && p.sort_pos != null).map((p) => [p.target_id, p.sort_pos]));
  const peopleSorted = isPhone && peopleBase.some((m) => peoplePos[m.user_id] != null) ? sortByCustomOrder(peopleBase.map((m) => ({ ...m, id: m.user_id })), peoplePos, (m) => String(m.display_name || '')) : peopleBase;
  // 만료된 손님은 목록엔 보여도 순서를 저장하지 않는다 — 대상 설정 RLS가 만료 멤버를 거부해 한 번에 보낸 행 전체가 403이었다(2026-09-29 로컬 실측). 순서 없이 맨 아래로 간다
  const reorderPeople = (dragId, beforeId = null, visible = null) => { const live = new Set(peopleSorted.filter((m) => !(m.expires_at && Date.parse(m.expires_at) <= Date.now())).map((m) => m.user_id)); return reorderTargetPos('user', [...live], dragId, beforeId, visible?.filter((id) => live.has(id))); };
  const personCtx = (m) => [m.user_id !== uid && { icon: 'at', label: t('ui.dm'), run: () => { openDm('user', m.user_id); setRail(false); } }, m.user_id !== uid && { icon: 'star', label: t(targetPinned('user', m.user_id) ? 'ch.unpin' : 'ctx.fav'), disabled: favoriteBusy, run: () => toggleTargetPin('user', m.user_id) }, { icon: 'gear', label: t('ctx.members'), run: () => { setSettingsTab('members'); setPage('settings'); setRail(false); } }];
  const reorderRailCustom = (dragId, beforeId = null, visible = null) => reorderTargetPos('crew', myCrews.map((c) => c.id), dragId, beforeId, visible, () => { if (railSort !== 'custom') pickSort('custom'); });
  // 행은 아바타·이름·상태점만(유건 지적 2026-09-09 "레일이 복잡"). 출처는 글자 대신 소속별 정렬일 때 소제목으로.
  // 지금 연 방이 내 에이전트의 옛 조직 1:1이고 개인 1:1이 있다고 알면 방 위에 안내 띠(유건 2026-10-05) — 오래된 링크·마지막으로 본 방 복원처럼 돌리기를 거치지 않고 열린 경우
  // 이전 대화 보기로 연 보관 방(archivedView)도 같은 띠 — 그 방의 에이전트 조직 행으로 dmWithCrew가 개인 1:1을 연다
  const legacyDm = archivedView?.id && earlierRoom?.crewId ? { crew: { id: earlierRoom.crewId }, known: true } : channel && !isPersonal ? agentDmRedirect(channel, dmMembers[channel.id], { uid, crewOf, myAgents }) : null;
  // 내 에이전트와의 개인 1:1이면 그 개인 행 — 방 위 '이전 대화 보기'(분리 검수 2026-10-05 #2). 남의 에이전트 방·친구 방·그룹 방은 null(내 행이 아니면 earlierAgentDms가 조회 없이 빈 목록)
  const earlierCrew = isPersonal && channel?.kind === 'dm' && channel._personal_crew && !channel._personal_group ? channel._personal_crew : null;
  const crewCtx = (c) => isPersonal ? [{ icon: 'at', label: t('ui.dm'), run: () => { dmWithCrew(c.id); setRail(false); } }] // 개인 공간 — 크루 카드·즐겨찾기는 조직 기능(2026-09-30 1단계)
    : [{ icon: 'gear', label: t('ctx.crew.card'), run: () => { setSheet(c.id); setRail(false); } }, { icon: 'at', label: t(dmGoesPersonal(c) ? 'ui.dm.personal' : 'ui.dm'), run: () => { dmWithCrew(c.id); setRail(false); } }, { icon: 'star', label: t(targetPinned('crew', c.id) ? 'ch.unpin' : 'ctx.fav'), disabled: favoriteBusy, run: () => toggleTargetPin('crew', c.id) }];
  // 폰 줄 밀기(유건 승인 2026-09-29): 오른쪽 = 즐겨찾기(고정), 왼쪽 = 알림 끄기·읽음. 단추는 아이콘만(유건 2026-09-29 "아이콘만 봐도 안다"), 이름은 aria-label. 절반 넘게 밀면 첫 동작 바로 실행(row-swipe.js)
  const markChannelRead = async (c) => { if (!unread[c.id]?.n) return; try { const last = await q(supabase.from('msgr_messages').select('id').eq('channel_id', c.id).order('id', { ascending: false }).limit(1).maybeSingle()); if (last?.id) await markRead(c.id, last.id); } catch (e) { setErr(e.message); } }; // 누를 때 한 번만 조회
  const swipeActs = (c) => (
    <div className="msgr-swipeacts" aria-hidden="true">
      <div className="lead"><button type="button" tabIndex={-1} className="fav" onClick={() => togglePin(c)} aria-label={t(pinned.has(c.id) ? 'swipe.unfav' : 'swipe.fav')}><I name="star" size={18} /></button></div>
      <div className="trail">
        <button type="button" tabIndex={-1} className="mute" onClick={() => toggleMute(c)} aria-label={t(muted.has(c.id) ? 'ch.unmute' : 'ch.mute')}><I name={muted.has(c.id) ? 'bell' : 'belloff'} size={18} /></button>
        <button type="button" tabIndex={-1} className="read" onClick={() => markChannelRead(c)} aria-label={t('swipe.read')}><I name="check" size={18} /></button>
      </div>
    </div>
  );
  const chItemsOf = (c) => { const canManage = isAdmin || c.created_by === uid || (c.admin_user_ids ?? []).includes(uid); const confirmVia = (kind) => { setActionError(''); setRailAction({ channel: c, kind }); }; return [ // 채널 줄 메뉴 — 데스크톱 레일 줄과 폰 채널 탭 줄이 같은 항목
                { icon: 'gear', label: t('ch.menu.settings'), run: () => { setChId(c.id); setPage('chat'); setRail(false); setChSheet(true); } },
                { icon: 'star', label: t(pinned.has(c.id) ? 'ch.unpin' : 'ch.pin'), run: () => togglePin(c) },
                { icon: muted.has(c.id) ? 'bell' : 'belloff', label: t(muted.has(c.id) ? 'ch.unmute' : 'ch.mute'), run: () => toggleMute(c) },
                isPhone && !isPersonal && { icon: 'folder', label: t('ch.group'), run: () => setGrpSheet({ mode: 'pick', channelId: c.id }) }, // 폰 채널 탭 그룹(유건 2026-10-02) — 데스크톱 레일 메뉴는 그대로
                { icon: 'out', label: t('ch.leave'), run: () => confirmVia('leave') }, // 공개 채널도 나간다 — 참여 행을 지우면 찾아보기로 다시 들어온다(D16, 종전엔 비공개만)
                canManage && { icon: 'archive', label: t('ch.archive'), run: () => confirmVia('archive') },
                ...orderItems(c),
                canManage && { icon: 'trash', label: t('ch.delete'), danger: true, run: () => confirmVia('delete') },
              ]; };
  const chRow = (c) => { const items = chItemsOf(c); return (
              <div key={c.id} className={`msgr-railrow${ctx?.trigger === c.id ? ' open' : ''}${drag === c.id ? ' dragging' : ''}`} onDragStart={dragStart(c)} onDragEnd={() => setDrag(null)} onDragOver={dragOver} onDrop={(e) => dropOnRow(e, c)} onContextMenu={(e) => { if (Date.now() - (lpStates.current[c.id]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, items, c.id); }} draggable={!isPhone && pinned.has(c.id)} data-drag-id={c.id} data-swipe-id={isPhone ? c.id : undefined} {...(isPhone ? rowLongPress(c, items, { onDrop: pinned.has(c.id) ? reorderFav : reorderChannels }) : {})}>{isPhone && swipeActs(c)}
                <button type="button" className={`item${c.id === chId ? ' active' : ''}${unread[c.id]?.n && !muted.has(c.id) ? ' unread' : ''}`} onClick={() => { setChId(c.id); setRail(false); if (isPhone) setPage('chat'); setPage('chat'); }}>
                  <I name={c.kind === 'private' ? 'lock' : 'hash'} size={14} /><span className="name">{c.name}</span>{muted.has(c.id) && <I name="belloff" size={12} className="mi" />}{typingIn(c.id) && <span className="msgr-busy" role="img" aria-label={t('side.typing')} title={t('side.typing')} />}{unread[c.id]?.n > 0 && <span className={`msgr-badge${unread[c.id].mention ? ' mark' : ''}${muted.has(c.id) ? ' dim' : ''}`}>{unread[c.id].n}</span>}
                </button>
                <button type="button" className="more" onClick={(e) => { openCtx(e, items, c.id); }} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-haspopup="menu" aria-expanded={ctx?.trigger === c.id}><I name="dots" size={13} /></button>

              </div>
            ); };
  // 폰 레일 행 길게 누르기 → 행 메뉴(점 세 개와 같은 항목; DM 탭은 미리보기 포함). 홈에도 적용(유건 2026-09-15). iOS 웹뷰는 길게 눌러도 contextmenu를 안 내고, 안드로이드는 낸다 → 800ms 안 중복은 onContextMenu가 삼킨다
  const rowLongPress = (c, items, dragCtx = null) => { const st = (lpStates.current[c.id] ??= { timer: null, x: 0, y: 0, el: null, firedAt: 0, opened: false });
    const { clear, ...lp } = longPressHandlers(st, () => { st.firedAt = Date.now(); st.opened = true; if (!st.el) return;
      openCtx({ preventDefault() {}, stopPropagation() {}, currentTarget: st.el, clientX: st.x, clientY: st.y }, items, c.id);
      if (dragCtx) beginTouchDrag(c.id, st.el, dragCtx.onDrop, st.mx ?? st.x, st.my ?? st.y, st.pid); }); // 끌기 기준점 = 메뉴가 뜬 순간의 손가락 위치 — 누른 자리 기준이면 8~10px 흔들림이 곧바로 끌기가 됐다(검수 M1) // 메뉴가 뜬 채 움직이면 끌기(8px, moveTouchDrag가 메뉴를 닫는다) — 어느 목록이든(유건 2026-09-29)
    void clear;
    // 손을 뗄 때 오는 click(메뉴 뒤 배경에 떨어져 메뉴를 닫고, 행에 떨어지면 대화를 연다)은 **이 누름으로 메뉴가 열렸을 때만, pointerup 직후 300ms 안에서** 한 번 삼킨다 —
    // 상태 플래그라 오래 누르고 있다가 떼도 보호되고(재검수 M-B), iOS가 click을 안 내는 경우(드래그 리프트·콜아웃)엔 300ms 뒤 풀려 다음 탭(메뉴 항목)을 먹지 않는다(검수 HIGH-3)
    const swallowNext = () => { if (!st.opened) return; st.opened = false; const swallow = (e) => { e.preventDefault(); e.stopPropagation(); }; document.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 300); };
    return { ...lp,
      onPointerDown: (e) => { st.el = e.currentTarget; st.pid = e.pointerId; st.mx = null; st.my = null; lp.onPointerDown(e); },
      onPointerMove: (e) => { st.mx = e.clientX; st.my = e.clientY; lp.onPointerMove(e); if (dragCtx && touchDrag.current?.id === c.id) moveTouchDrag(e.clientX, e.clientY); },
      onPointerUp: (e) => {
        lp.onPointerUp(e);
        if (dragCtx && touchDrag.current?.id === c.id) endTouchDrag(e.clientY); // 안 움직였으면 뜬 메뉴가 그대로 남는다
        swallowNext();
      },
      onPointerCancel: (e) => { lp.onPointerCancel(e); if (touchDrag.current?.id === c.id) cancelTouchDrag(); }, // 브라우저가 제스처를 가져가면 들어 올린 행·흐림이 남지 않게
    }; };
  const dmItemsOf = (c, preview = false) => { const confirmVia = (kind) => { setActionError(''); setRailAction({ channel: c, kind }); }; return [ // 대화 줄 메뉴 — 폰은 '대화 미리보기'를 맨 위에
                ...(preview ? [{ icon: 'doc', label: t('dm.preview'), run: () => setDmPeek(c) }] : []),
                { icon: 'star', label: t(pinned.has(c.id) ? 'ch.unpin' : 'ch.pin'), run: () => togglePin(c) },
                { icon: muted.has(c.id) ? 'bell' : 'belloff', label: t(muted.has(c.id) ? 'ch.unmute' : 'ch.mute'), run: () => toggleMute(c) },
                ...orderItems(c),
                { icon: 'out', label: t('dm.leave'), run: () => confirmVia('leave') },
                ...(c._personal_group && c.created_by !== uid ? [] : [ // 개인 그룹은 만든 사람만 끝내거나 지운다(친구의 친구가 모두의 기록을 지우지 못하게 — 서버 msgr_can_manage_channel과 같은 규칙)
                  { icon: 'archive', label: t('dm.end'), run: () => confirmVia('end') },
                  // 조직 그룹 대화는 만든 사람·조직 관리자만 삭제(유건 결정 2026-10-06 — 서버 msgr_can_delete_channel). 나머지는 비활성 항목으로 나가기를 안내한다
                  canDeleteRoom({ c, members: dmMembers[c.id] ?? [], uid, isOrgAdmin: isAdmin })
                    ? { icon: 'trash', label: t('dm.delete'), danger: true, run: () => confirmVia('delete') }
                    : { icon: 'trash', label: t('dm.delete.groupOnly'), disabled: true, run: () => {} },
                ]),
              ]; };
  const dmRow = (c) => { const dmMs = dmMembers[c.id] ?? []; const dmCrew = dmMs.find((m) => m.member_kind === 'crew'); const dmOther = dmMs.find((m) => m.member_kind === 'user' && m.member_id !== uid); const isGroupRow = dmIsGroup(c); const withCrew = !!dmCrew && !isGroupRow && !(c.org_id == null && c._personal_other && !c._personal_group && !c._personal_crew); /* 개인 1:1은 에이전트가 들어와도 친구 아바타(2026-09-30) */ const items = dmItemsOf(c, dmTab); return (
            <div key={c.id} data-drag-id={c.id} className={`msgr-railrow${ctx?.trigger === c.id ? ' open' : ''}${drag === c.id ? ' dragging' : ''}`} onDragStart={dragStart(c)} onDragEnd={() => setDrag(null)} onDragOver={dragOver} onDrop={(e) => dropOnRow(e, c)} onContextMenu={(e) => { if (Date.now() - (lpStates.current[c.id]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, items, c.id); }} draggable={!isPhone} data-swipe-id={isPhone ? c.id : undefined} {...(isPhone ? rowLongPress(c, items, { onDrop: (dmTab ? dmFilter === 'fav' || (dmFilter === 'all' && pinned.has(c.id)) : pinned.has(c.id)) ? reorderFav : reorderDmCustom }) : {})}>{isPhone && swipeActs(c)}
              <button type="button" className={`item${c.id === chId ? ' active' : ''}${unread[c.id]?.n && !muted.has(c.id) ? ' unread' : ''}`} aria-busy={redirectingId === c.id || undefined} onClick={() => { if (openAgentDmInstead(c.id, 'list')) { setRail(false); return; } setChId(c.id); setRail(false); if (isPhone) setPage('chat'); setPage('chat'); }}><Av name={dmName(c)} size="xs" crew={withCrew} crewId={isGroupRow ? null : (dmCrew?.member_id ?? null)} userId={isGroupRow || dmCrew ? null : (dmOther?.member_id ?? null)} />{/* 여럿이 있는 방은 누구 한 사람의 얼굴이 아니라 이름 묶음으로 — 첫 한 명만 뜨던 것(검수 2026-09-16) */}{dmTab ? <span className="dmtext"><span className="dmline"><span className="name">{dmBaseName(c)}</span>{lastMsg[c.id]?.at > 0 && <span className="when">{fmtDmWhen(t('time.yesterday'), lastMsg[c.id].at, lang)}</span>}{muted.has(c.id) && <I name="belloff" size={12} className="mi" />}</span>{lastMsg[c.id]?.body && !mutedCrewIds.has(lastMsg[c.id].crewId) && <span className="snip">{dmSnipWho(c, lastMsg[c.id])}{lastMsg[c.id].body}</span>}</span> : <><span className="name">{dmBaseName(c)}</span>{muted.has(c.id) && <I name="belloff" size={12} className="mi" />}</>}{typingIn(c.id) && <span className="msgr-busy" role="img" aria-label={t('side.typing')} title={t('side.typing')} />}{unread[c.id]?.n > 0 && <span className={`msgr-badge${muted.has(c.id) ? ' dim' : ' mark'}`}>{unread[c.id].n}</span>}</button>
              {!dmTab && <button type="button" className="more" onClick={(e) => { openCtx(e, items, c.id); }} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-haspopup="menu" aria-expanded={ctx?.trigger === c.id}><I name="dots" size={13} /></button>}{/* 폰 DM 탭: 점 세 개 없음 — 같은 메뉴가 길게 누르기로 뜬다(유건 2026-09-15) */}
            </div>
          ); };
  const targetRow = (c) => {
    const items = [{ icon: 'at', label: t(c.targetKind === 'crew' && dmGoesPersonal(crewOf(c.targetId)) ? 'ui.dm.personal' : 'ui.dm'), run: () => openDm(c.targetKind, c.targetId) }, { icon: 'star', label: t('ch.unpin'), disabled: favoriteBusy, run: () => toggleTargetPin(c.targetKind, c.targetId) }, ...orderItems(c)];
    return <div key={c.id} data-drag-id={c.id} className="msgr-railrow" draggable={!isPhone} onDragStart={dragStart(c)} onDragEnd={() => setDrag(null)} onDragOver={dragOver} onDrop={(e) => dropOnRow(e, c)} onContextMenu={(e) => { if (Date.now() - (lpStates.current[c.id]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, items, c.id); }} {...(isPhone ? rowLongPress(c, items, { onDrop: reorderFav }) : {})}>
      <button type="button" className="item" onClick={() => openDm(c.targetKind, c.targetId)}><Av name={c.name} size="xs" crew={c.targetKind === 'crew'} crewId={c.targetKind === 'crew' ? c.targetId : null} userId={c.targetKind === 'user' ? c.targetId : null} /><span className="name">{c.name}</span></button>
      <button type="button" className="more" aria-label={t('ch.row.more')} aria-haspopup="menu" aria-expanded={ctx?.trigger === c.id} onClick={(e) => openCtx(e, items, c.id)}><I name="dots" size={13} /></button>
    </div>;
  };
  const confirmRailAction = async () => {
    if (!railAction || actionLock.current) return;
    actionLock.current = true; setActionBusy(true); setActionError('');
    try {
      const { channel: c, kind } = railAction;
      if (kind === 'leave') await leaveChannel(c);
      else if (kind === 'delete') await deleteChannel(c);
      else if (c.kind === 'dm') await archiveDm(c);
      else await archiveChannel(c);
      setRailAction(null);
    } catch (e) { setActionError(friendlyErr(e.message, t)); }
    finally { actionLock.current = false; setActionBusy(false); }
  };
  const railActionKey = railAction && (railAction.channel.kind === 'dm' ? `dm.${railAction.kind === 'end' ? 'end' : railAction.kind}` : `ch.${railAction.kind}`);
  // '내 에이전트' 직접 배치 드래그는 내 소유 크루만(railCompany는 대상 밖, 유건 확정 2026-09-29 #7) — mine 여부로 드래그 속성 자체를 끈다.
  const railRow = (c) => { const mine = c.owner_user_id === uid; const items = crewCtx(c); return (
    <div key={c.id} data-drag-id={c.id} className={`msgr-railrow nomore${ctx?.trigger === c.id ? ' open' : ''}${drag === c.id ? ' dragging' : ''}${twinPaused(c) ? ' paused' : ''}`} onDragStart={mine ? dragStart(c) : undefined} onDragEnd={() => setDrag(null)} onDragOver={dragOver} onDrop={(e) => dropOnRow(e, c)} onContextMenu={(e) => { if (Date.now() - (lpStates.current[c.id]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, items, c.id); }} draggable={!isPhone && mine && railSort === 'custom'} {...(isPhone ? rowLongPress(c, items, mine ? { onDrop: reorderRailCustom } : null) : {})}>
      <button type="button" className="item" onClick={() => { if (isPersonal) dmWithCrew(c.id); else setSheet(c.id); setRail(false); }} title={`${c.display_name}${twinOrgLabel(c) ? ` · ${t('rail.twin.org', { org: twinOrgLabel(c) })}` : ` · ${t(`rail.src.${sourceOf(c)}`)}`}${c.role_text ? ` · ${c.role_text}` : ''}${twinRelink(c) ? ` · ${t('rail.relink.title')}` : ''}${twinLeftOrg(c) ? ` · ${t('rail.leftorg.title')}` : ''}`}><Av name={c.display_name} crew size="xs" company={crewTier(c, org) === 'company'} crewId={c.id} /><span className="name">{c.display_name}{!twinOrgLabel(c) && crewHints.get(c.id) && <small className="msgr-namehint">{crewHints.get(c.id)}</small>}</span>{twinOrgLabel(c) && <span className="msgr-orglabel">{twinOrgLabel(c)}</span>}{twinRelink(c) && <span className="msgr-relink">{t('rail.relink')}</span>}{twinLeftOrg(c) && <span className="msgr-relink">{t('rail.leftorg')}</span>}<span className={`msgr-dot${seenWithin(c, AWAY_MS, Date.now(), crewSeenAt(c)) ? ' mark' : ''}`} /></button>
    </div>
  ); };
  // 평평한 목록(유건 결정 2026-09-09). 외부 에이전트(헤르메스·오픈클로 봇)가 있을 때만 '외부' 소제목 하나로 아래에 구분한다.
  const railArgo = myCrews.filter((c) => sourceOf(c) === 'argo'); const railExt = myCrews.filter((c) => sourceOf(c) !== 'argo');
  const railCompany = sortCrews(crews.filter((c) => c.owner_user_id !== uid && crewTier(c, org) === 'company')); // 다른 멤버의 에이전트는 레일에 두지 않는다 — 외부(VPS) 봇 포함(유건 2026-09-16 "다른 멤버의 에이전트는 안 보이게", 2026-09-24 "VPS 에이전트도 Argo 에이전트처럼").
  // 조직 명부에는 그대로 있다 — 목록에서 빼는 것은 화면 규칙이고, 지시는 서버가 허용 범위로 막는다. 회사 크루만 남는다.
  const railVisible = crews.filter((c) => c.owner_user_id === uid || crewTier(c, org) === 'company');
  const openers = crewOpeners({ isPersonal, openSheet: setSheet, openDm: dmWithCrew }); // 개인 공간은 에이전트 시트를 그리지 않는다 — 메시지의 에이전트 버튼 없음, 검색 결과는 1:1로
  const orgJoinForms = (phone = false) => (<>{/* 조직 메뉴의 '초대 코드로 참여'·'조직 만들기' — 데스크톱 조직 창과 폰 채널 탭 조직 메뉴·빈 화면이 같은 폼 */}
              {joinCode === null
                ? <button type="button" role="menuitem" onClick={() => { setJoinCode(''); setJoinHint(null); setNewOrg(null); }}><span className="msgr-av sm ghost"><I name="link" size={13} /></span><span className="label">{t(phone ? 'phone.org.join' : 'org.join.code')}</span></button>
                : <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); joinByCode(joinCode); }}>
                    <input className="msgr-input" placeholder={t('org.join.code.ph')} value={joinCode} onChange={(e) => { setJoinCode(e.target.value); setJoinHint(null); }} aria-invalid={!!joinHint} autoFocus />
                    {joinHint && <p className="msgr-inline-err" role="alert">{t(joinHint)}</p>}
                    <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!canSubmitJoin(joinCode)}><I name="check" size={13} />{t('org.join.code.go')}</button><button type="button" className="btn sm" onClick={() => setJoinCode(null)}>{t('ui.cancel')}</button></div>
                  </form>}
              {newOrg === null
                ? <button type="button" role="menuitem" onClick={() => setNewOrg('')}><span className="msgr-av sm ghost"><I name="plus" size={13} /></span><span className="label">{t(phone ? 'phone.org.create' : 'org.new')}</span></button>
                : <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); createOrg(newOrg); }}>
                    <input className="msgr-input" placeholder={t('org.name')} value={newOrg} onChange={(e) => setNewOrg(e.target.value)} autoFocus maxLength={80} />
                    <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!newOrg.trim()}><I name="check" size={13} />{t('ui.create')}</button><button type="button" className="btn sm" onClick={() => setNewOrg(null)}>{t('ui.cancel')}</button></div>
                  </form>}
  </>);
  const crewHints = duplicateNameHints(railVisible, { lang, sourceLabel: (c) => t(`rail.src.${sourceOf(c)}`) }); // 같은 이름이 겹칠 때만 종류·만든 날을 덧붙인다(점검 A·B #12)

  // ════ 폰 루트 화면(아래 탭 5개 — 유건 확정 2026-10-01). 데스크톱은 이 블록을 그리지 않는다 ════
  const rootTab = isPhoneRoot(page) ? page : (swipeTo ?? lastRoot.current); // 대화방·설정을 열어도 밑에는 마지막 탭이 깔린다(뒤로 스와이프 밑 화면)
  const spaceReady = loadedOrg.current === orgId;
  const friendReqs = friends.filter((f) => f.status === 'pending' && f.requested_by !== uid);
  const friendList = withoutHidden(friends.filter((f) => f.status === 'accepted'), hiddenUserIds).sort((a, b) => String(a.display_name || a.handle || '').localeCompare(String(b.display_name || b.handle || ''), 'ko'));
  const approvalItems = decidableApprovals(approvals, { uid, orgs }); // 결재 대기(모든 조직 — loadApprovals) 중 내가 결정할 수 있는 것만(분리 검수 M-2 — 숫자·뱃지·페이지 모두). 내 역할은 조직 목록(orgs[].role)
  const tabBadgeN = tabBadges({ hereKey, here: hereCount, hereReady: unreadSpace === orgId, totals: spaceTotals, orgIds: orgIdList, approvals: approvalItems.length, friendRequests: friendReqs.length });
  const tabQText = tabQ ?? '';
  const decideFriend = async (f, accept) => { try { await q(supabase.rpc('msgr_friend_decide', { other: f.user_id, accept })); setNote(t(accept ? 'friends.accepted' : 'friends.declined')); await onFriendsChanged(); } catch (e) { setErr(/msgr_friend_closed/.test(e.message) ? t('friends.err.closed') : e.message); } };
  const openSettings = (tab = null, focus = null) => { setTabQ(null); const m = phoneSettingsPage(tab); if (m === 'orgsettings') setSettingsTab(tab); setSettingsFocus(focus); setPage(m); }; // 톱니 = 어느 탭에서든 같은 설정 화면(focus = 그 묶음으로 바로 스크롤)
  const openOrgSub = (kind) => { if (chOrg && orgId !== chOrg) setOrgId(chOrg); setPage(`set-${kind}`); }; // 조직 범위 설정 화면 — 고른 조직(채널·기억 탭과 같은 값) 공간으로 바꿔 그린다. 화면 안 '조직 이름 ▾'가 공간을 바꾼다(4차 피드백)
  const runnerAgents = () => { setRunnerOpen(false); if (isPhone) openOrgSub('ext'); else { setSettingsTab('crews'); setPage('settings'); setRail(false); } }; // 실행기 시트 '외부 에이전트' → 설정의 에이전트 연결 화면
  const pickSettingsOrg = (id) => { if (id && id !== orgId) setOrgId(id); }; // 설정 조직 화면의 드롭다운 — 앱 전체의 고른 조직도 같이 바뀐다(savedOrgAfter)
  // 에이전트별 설정 = 에이전트 카드(유건 2차 피드백 1) — 조직 에이전트는 그 조직 공간에서 조직 카드, 개인 에이전트는 개인 카드. 열 수 없으면 이유를 띄운다(아무 일도 없는 줄 0)
  const openAgentCard = (c) => {
    const a = agentCardAction(c);
    if (a.do === 'personal-card') { setPersonalCard(c.id); return; }
    if (a.do !== 'org-card') { setNote(t('agentcard.why.missing')); return; }
    const timer = setTimeout(() => { if (afterSpace.current?.tag === c.id) { afterSpace.current = null; setNote(t(`agentcard.why.${orgCardStep({ timedOut: true }).why}`)); } }, 8000);
    runInSpace(a.space, (fn) => { clearTimeout(timer); const step = orgCardStep({ found: !!fn.crewOf(c.id), blocked: fn.orgBlocked }); if (step.do === 'open') fn.setSheet(c.id); else fn.note(t(`agentcard.why.${step.why}`)); }, c.id);
  };
  const gearAct = { key: 'gear', icon: 'gear', label: t('ui.settings'), run: () => openSettings() };
  const searchAct = { key: 'search', icon: 'search', label: t('phone.hdr.search'), on: tabQ !== null, run: () => setTabQ((v) => (v === null ? '' : null)) };
  const searchAll = () => { const qv = tabQText.trim(); if (!qv) return; setSearchQ(qv); runSearch(qv); }; // '전체에서 찾기' — 지금 공간의 통합 검색(메시지·사람·에이전트·채널)
  const rowOf = (c) => roomRow({ c, lastMsg: lastMsg[c.id], lastAt: lastAt[c.id], unread: unread[c.id], muted: muted.has(c.id), pinned: pinned.has(c.id) });
  const maskOf = (c) => { const r = rowOf(c); const lm = lastMsg[c.id]; return maskedPreview({ preview: r.preview, userId: r.userId ?? lm?.userId, crewId: r.crewId ?? lm?.crewId }, { blocked: blockedIds, muted: mutedCrewIds }); };
  const bodyHit = (c) => !!tabHits && tabHits.space === orgId && tabHits.q === tabBodyQ && tabHits.ids.has(c.id); // 서버 본문 찾기에서 맞은 방(D9) — 검색어·공간이 바뀌면 옛 결과는 쓰지 않는다
  const previewForSearch = (c) => { const m = maskOf(c); return m.masked === 'blocked' ? t('msg.blockedUser') : m.text; }; // 목록 검색도 가린 글자로(D7)
  const openRoom = (c) => { setTabQ(null); if (openAgentDmInstead(c.id, 'list')) return; setChId(c.id); setRail(false); setPage('chat'); }; // 폰 채팅·채널 탭 줄 — 내 에이전트의 옛 조직 1:1이고 안 읽은 글이 없으면 개인 1:1로(유건 2026-10-05). 돌리는 동안 줄은 aria-busy
  const roomAvatar = (c, tr) => {
    if (c.kind !== 'dm') return <span className={`ph-chav${c.kind === 'private' ? ' lock' : ''}`} aria-hidden="true"><I name={c.kind === 'private' ? 'lock' : 'hash'} size={20} /></span>;
    const ms = dmMembers[c.id] ?? [];
    if (tr.group) { const others = ms.filter((m) => !(m.member_kind === 'user' && m.member_id === uid)).slice(0, 4); return <span className={`ph-gav n${others.length}`} aria-hidden="true">{others.map((m) => m.member_kind === 'crew' ? <Av key={`c${m.member_id}`} name={crewOf(m.member_id)?.display_name} crew size="xs" crewId={m.member_id} /> : <Av key={`u${m.member_id}`} name={nameOfUser(m.member_id)} size="xs" userId={m.member_id} />)}</span>; }
    const personal1to1 = c.org_id == null && c._personal_other && !c._personal_group && !c._personal_crew; // 개인 1:1은 에이전트가 들어와도 친구 얼굴(2026-09-30)
    const crew = ms.find((m) => m.member_kind === 'crew') ?? (c._personal_crew ? { member_id: c._personal_crew } : null); const other = ms.find((m) => m.member_kind === 'user' && m.member_id !== uid);
    if (crew && !personal1to1) return <Av name={crewOf(crew.member_id)?.display_name ?? dmBaseName(c)} crew size="kk" crewId={crew.member_id} />;
    return <Av name={dmBaseName(c)} size="kk" userId={other?.member_id ?? c._personal_other ?? null} />;
  };
  // 카톡 줄 — 왼쪽 사진(그룹 2×2·에이전트 얼굴·채널 타일), 이름 + 인원 수 + 고정·알림 끔, 마지막 글 두 줄, 오른쪽 위 시각, 그 아래 @·안 읽은 수
  const kRow = (c, dragCtx = null) => {
    const isDm = c.kind === 'dm'; const tr = isDm ? traitsOf(c) : { group: false, agent: false, size: 0 };
    const r = rowOf(c); const lm = lastMsg[c.id];
    const name = isDm ? dmBaseName(c) : c.name;
    const count = isDm ? (tr.group ? tr.size : 0) : (chCount[c.id] ?? 0);
    const items = isDm ? dmItemsOf(c, true) : chItemsOf(c);
    const mp = maskOf(c); const hidden = !!mp.masked; // 차단한 사람·숨긴 에이전트의 글은 미리보기에서 방 안과 같이 가린다(D7)
    const prefix = lm && r.preview === lm.body ? (isDm ? dmSnipWho(c, lm) : (lm.mine ? t('dm.snip.me') : `${dmWho(c, lm)}: `)) : '';
    return (
      <div key={c.id} data-drag-id={c.id} data-swipe-id={c.id} className={`msgr-railrow ph-krow${ctx?.trigger === c.id ? ' open' : ''}${drag === c.id ? ' dragging' : ''}`} onContextMenu={(e) => { if (Date.now() - (lpStates.current[c.id]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, items, c.id); }} {...rowLongPress(c, items, dragCtx)}>{swipeActs(c)}
        <button type="button" className={`item ph-kitem${r.unreadN && !r.muted ? ' unread' : ''}`} aria-busy={redirectingId === c.id || undefined} onClick={() => openRoom(c)}>
          {roomAvatar(c, tr)}
          <span className="ph-kbody">
            <span className="ph-kl1"><span className="name">{name}</span>{count > 0 && <span className="ph-kcount" aria-label={t('phone.row.members', { n: count })}>{count}</span>}{r.pinned && <I name="pin" size={13} className="ph-kic" />}{r.muted && <I name="belloff" size={13} className="ph-kic" />}<span className="when">{r.at > 0 ? fmtDmWhen(t('time.yesterday'), r.at, lang) : ''}</span></span>
            <span className="ph-kl2"><span className="snip">{typingIn(c.id) ? <span className="ph-typing">{t('side.typing')}</span> : mp.masked === 'blocked' ? t('msg.blockedUser') : hidden ? '' : `${prefix}${r.preview}`}</span><span className="ph-kbadges">{r.mention && <span className="ph-at" role="img" aria-label={t('phone.row.mention')}>@</span>}{r.unreadN > 0 && <span className={`msgr-badge${r.muted ? ' dim' : ''}`}>{badgeText(r.unreadN)}</span>}</span></span>
          </span>
        </button>
      </div>
    );
  };
  const searchBar = tabQ !== null && (
    <form className="ph-search" role="search" onSubmit={(e) => { e.preventDefault(); e.currentTarget.querySelector('input')?.blur(); }}>
      <I name="search" size={16} /><input autoFocus value={tabQText} onChange={(e) => setTabQ(e.target.value)} placeholder={t(`phone.search.ph.${rootTab}`)} aria-label={t(`phone.search.ph.${rootTab}`)} enterKeyHint="search" />
      <button type="button" className="ph-searchx" onClick={() => setTabQ(null)}>{t('ui.cancel')}</button>
    </form>
  );
  const searchFoot = (found) => tabQText.trim() ? (<div className="ph-searchfoot">{!found && <p className="msgr-hint">{t('phone.search.none')}</p>}<button type="button" className="btn ph-searchall" onClick={searchAll}><I name="search" size={14} />{t('phone.search.all', { q: tabQText.trim() })}</button></div>) : null;
  // ── 채팅 탭(개인 공간) ──
  const chatsAll = isPersonal && spaceReady ? channels.filter((c) => c.kind === 'dm' && !emptyPersonalDm(c, lastMsg[c.id])) : []; // 글 없는 개인 1:1은 목록에서 뺀다(D13 — 첫 글이 오면 바로 보인다)
  const chatSorted = sortRooms(chatsAll, { sort: dmSort, atOf: (c) => rowOf(c).at, unread, pinned, pinPos, nameOf: dmBaseName, sortPos: dmSortPos });
  const chatFiltered = chatSorted.filter((c) => chatVisible(dmFilter, { ...rowOf(c), ...traitsOf(c) }));
  const chatShown = tabSearch(chatFiltered, tabQText, (c) => [dmBaseName(c), previewForSearch(c)], bodyHit);
  const chatDrop = (c) => ({ onDrop: pinned.has(c.id) ? reorderFav : (id, before, visible) => reorderChannelPos(chatSorted.filter((x) => !pinned.has(x.id)), id, before, visible, () => { if (dmSort !== 'custom') pickDmSort('custom'); }) });
  // ── 채널 탭(고른 조직) ──
  const orgRow = orgs?.find((o) => o.id === chOrg) ?? null;
  const onOrgTab = !!orgRow && orgId === orgRow.id && spaceReady;
  const chChannels = onOrgTab ? sortRooms(channels.filter((c) => c.kind !== 'dm'), { sort: chBase.some((c) => dmSortPos[c.id] != null) ? 'custom' : 'recent', atOf: (c) => rowOf(c).at, unread, pinned, pinPos, nameOf: (c) => c.name, sortPos: dmSortPos }) : [];
  const chTalks = onOrgTab ? sortRooms(channels.filter((c) => c.kind === 'dm'), { sort: dmSort, atOf: (c) => rowOf(c).at, unread, pinned, pinPos, nameOf: dmBaseName, sortPos: dmSortPos }) : [];
  // 채널 탭 메뉴 '즐겨찾기 · 채널 · <그룹들…>'(유건 2026-10-02) — 그룹에 넣은 채널은 '채널'에서 빠지고 그 그룹에서 보인다. '이 조직의 대화'는 채널 메뉴에서 종전 그대로, 즐겨찾기는 고정한 대화만, 그룹 메뉴엔 없다
  const chMenuKey = resolveMenu(chMenu, grp.groups); // 고른 메뉴(칩 강조)
  const chListKey = searchMenu(chMenuKey, tabQText); // 보여 줄 범위 — 검색어가 있으면 메뉴와 상관없이 채널·대화 전체('all'), 지우면 고른 메뉴로(분리 검수 M-4)
  const chMenuGroup = chListKey.startsWith('g:') ? grp.groups.find((g) => `g:${g.id}` === chListKey) : null;
  const chMenuList = menuChannels(chListKey, chChannels, { pinned, links: grp.links, groups: grp.groups });
  const chTalksMenu = menuTalks(chListKey, chTalks, pinned);
  const chChannelsShown = tabSearch(chMenuList, tabQText, (c) => [c.name, c.topic, previewForSearch(c)], bodyHit);
  const chTalksShown = tabSearch(chTalksMenu, tabQText, (c) => [dmBaseName(c), previewForSearch(c)], bodyHit);
  const otherOrgsUnread = (orgs ?? []).filter((o) => o.id !== chOrg).reduce((a, o) => ({ n: a.n + (spaceCount(o.id)?.n || 0), mention: a.mention + (spaceCount(o.id)?.mention || 0) }), { n: 0, mention: 0 });
  const orgMenuPop = orgMenu && ((items) => (
    <OrgMenuCard orgs={orgs ?? []} current={chOrg} onClose={() => setOrgMenu(false)} onPick={(o) => { setTabQ(null); if (o.id !== orgId) setOrgId(o.id); }} badge={items.includes('joinable') ? (o) => <SpaceBadge c={spaceCount(o.id)} /> : null}>
      {items.includes('joinable') && joinable.map((o) => <button key={`j-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); joinDomain(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.join.cta')}</span></button>)}
      {items.includes('deleted') && deletedOrgs.map((o) => <button key={`d-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); restoreOrg(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.restore.cta', { days: Math.max(0, Math.ceil((Date.parse(o.purge_at) - Date.now()) / 86_400_000)) })}</span></button>)}
      {(orgs ?? []).length > 0 && <div className="sep" />}
      {items.includes('join') && orgJoinForms(true)}
      {items.includes('invite') && <button type="button" role="menuitem" onClick={() => { setOrgMenu(false); orgInvite(); }}><span className="msgr-av sm ghost"><I name="personplus" size={13} /></span><span className="label">{t('phone.org.invite')}</span></button>}
      {items.includes('org-settings') && <button type="button" role="menuitem" onClick={() => { setOrgMenu(false); openSettings('org'); }}><span className="msgr-av sm ghost"><I name="gear" size={13} /></span><span className="label">{t('phone.org.settings')}</span></button>}
      {items.includes('memory-settings') && <button type="button" role="menuitem" onClick={() => { setOrgMenu(false); openSettings(null, 'memory'); }}><span className="msgr-av sm ghost"><I name="gear" size={13} /></span><span className="label">{t('phone.mem.settings')}</span></button>}
    </OrgMenuCard>
  ))(orgMenuItems(rootTab, { admin: onOrgTab && !!isAdmin }));
  const chPlusPop = chPlus && (<>
    <div className="msgr-scrim clear ph-scrim" onClick={() => setChPlus(false)} role="presentation" />
    <div className="msgr-menu-pop ph-pop ph-pluspop" role="menu" aria-label={t('phone.ch.add')}>
      {canNewCh && <button type="button" role="menuitem" onClick={() => { setChPlus(false); setBrowse(null); openNewCh(); }}><span className="msgr-av sm ghost"><I name="plus" size={13} /></span><span className="label">{t('phone.ch.new')}</span></button>}
      <button type="button" role="menuitem" onClick={() => { setChPlus(false); setNewCh(null); openBrowse(); }}><span className="msgr-av sm ghost"><I name="hash" size={13} /></span><span className="label">{t('ch.browse')}</span></button>
    </div>
  </>);
  // ── 에이전트 탭: 내 에이전트·외부 에이전트(개인 공간 + 모든 조직) ──
  const spaceName = (orgIdOf) => (orgIdOf ? (orgs?.find((o) => o.id === orgIdOf)?.name ?? '') : t('personal.space'));
  // 같은 에이전트는 한 줄(agent-groups.mjs — 주인·회사·slug). 에이전트 = 한 사람(유건 2026-10-03, P2): 줄을 누르면 개인 공간의 1:1 방 하나 — 공간 고르기 없음.
  // 개인 행이 없으면(0.1.92 이전 본체) 종전대로 지금 공간의 것(없으면 첫 공간). 조직 이야기는 다음 단계의 '조직 기억 찾기'로 꺼낸다.
  const agentGroups = groupAgents(myAgents ?? [], { orgOrder: orgIdList });
  const agentFavOf = (g) => groupIsFav(g, { pinned: agentPins, local: agentLocalFav });
  const agentShown = (list) => tabSearch(list, tabQText, (g) => [g.display_name, g.role_text]);
  const agentSecs = agentSections(agentShown(agentGroups), { filter: agentFilter, isFav: agentFavOf });
  const agentState = (c) => (twinPaused(c) ? 'relink' : Object.entries(typing).some(([k, at]) => k.endsWith(`:${c.id}`) && Date.now() - at < TYPING_WINDOW_MS) || !!progress && Object.entries(progress).some(([k, v]) => k.endsWith(`:${c.id}`) && Date.now() - (v?.at ?? 0) < 8000) ? 'working' : 'idle');
  const openAgent = (c) => { setTabQ(null); const space = c.org_id ?? PERSONAL; if (c.status === 'available') { runInSpace(space, (fn) => fn.setSheet(c.id)); return; } runInSpace(space, (fn) => (space === PERSONAL ? fn.openPersonalCrewDm(c.id) : fn.dmWithCrew(c.id, '', { source: 'agents' }))); }; // 꺼 둔(파견 해제) 에이전트는 다시 켜는 카드로. 모든 공간을 보는 탭이라 공간 전환 안내 없음(source 'agents')
  const agentOpenRow = (g) => agentRoomTarget(g, { uid, space: orgId, personalKey: PERSONAL }); // 줄이 여는 행(얼굴도 이 행) — 준비 안 된 봇 쌍둥이는 고르지 않는다
  const groupState = (g) => (g.rows.some((r) => agentState(r) === 'working') ? 'working' : agentState(agentStateRow(g, { uid, space: orgId, personalKey: PERSONAL }))); // 대화할 수 없는 내 쌍둥이가 있으면 '다시 연결 필요'
  const openAgentGroup = (g) => openAgent(agentOpenRow(g));
  const agentItems = (g) => [
    { icon: 'star', label: t(agentFavOf(g) ? 'phone.agents.fav.remove' : 'phone.agents.fav.add'), run: () => { toggleAgentFav(g).catch(() => {}); } },
  ];
  const agentRow = (g) => { const on = g.rows.some((r) => seenWithin(r, AWAY_MS, Date.now(), crewSeenAt(r))); const st = agentRowState(groupState(g), on); /* 꺼진 에이전트는 '쉬는 중' 대신 '꺼져 있음'(UXM-14) */ const lpId = `agent:${g.key}`; const fav = agentFavOf(g); const def = agentOpenRow(g); return (
    <div key={g.key} className={`msgr-railrow ph-arowwrap${ctx?.trigger === lpId ? ' open' : ''}`} onContextMenu={(e) => { if (Date.now() - (lpStates.current[lpId]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, agentItems(g), lpId); }} {...rowLongPress({ id: lpId }, agentItems(g))}>
      <button type="button" className="item ph-arow" onClick={() => openAgentGroup(g)}>
        <Av name={g.display_name} crew size="kk" crewId={def.id} src={agentLook(def.id, looks, null, def.avatar_url ?? g.avatar_url ?? null).photo ?? null} />
        <span className="ph-kbody"><span className="ph-kl1"><span className="name">{g.display_name}</span>{fav && <span className="ph-afav" role="img" aria-label={t('phone.agents.fav')}><I name="star" size={12} /></span>}</span><span className="ph-kl2"><span className={`ph-astate ${st}`}><span className={`msgr-dot${on && st !== 'relink' ? ' mark' : ''}`} />{t(`phone.agent.${st}`)}</span>{g.role_text && <span className="snip">{g.role_text}</span>}</span></span>
      </button>
    </div>); };
  const levelOf = (it) => approvalGrade(it.kind === 'join' ? it : { ...it, kind: it.apKind }); // 결재 표의 종류는 apKind(loadApprovals)
  const approvalSum = (it) => { const [k, p] = it.kind === 'join' ? joinReqKey({ crew: it.crewName, room: it.roomName }) : approvalSummaryKey({ ...it, kind: it.apKind }); return (lang === 'en' ? (x) => x : koJosa)(t(k, p)); }; // 한두 줄 요약 — "목적을 위해 할 일"(결재 페이지와 같은 문장), 넣기 요청은 "'효일'을 '유건, 하나' 방에 넣어 달라는 요청"(D6)
  const openApproval = (it) => {
    if (!it?.channel_id) return; setTabQ(null); if (it.kind === 'join') sheetAfterNav.current = true; requestNav(it.channel_id, 'approval');
    // 결재는 그 카드 글로 가서 머리 바로 아래에 둔다(기능 점검 D12 — 안 읽음 기준으로 열려 카드가 머리 아래에 가렸다). 누를 때 한 번 조회, 못 찾으면 종전대로 연다.
    if (it.kind === 'approval') q(supabase.from('msgr_messages').select('id').eq('channel_id', it.channel_id).eq('kind', 'approval_card').contains('mentions', JSON.stringify([{ kind: 'approval', id: it.id }])).limit(1))
      .then((r) => { if (r?.[0]) setJump({ ch: it.channel_id, mid: r[0].id, start: true }); }).catch(() => {});
  }; // 다른 조직이면 알림 탭과 같은 길(decideNav)이 공간을 바꿔 연다. 참여 요청은 그 방 설정창까지
  const phoneRoot = (
    <div className="ph-root" data-tab={rootTab}>
      {rootTab === 'friends' && (<PhoneHead title={t('phone.tab.friends')} actions={[searchAct, { key: 'add', icon: 'personplus', label: t('friends.add'), run: () => { setTabQ(null); setFriendAdd(true); } }, gearAct]} />)}
      {rootTab === 'chats' && (<PhoneHead title={t('phone.tab.chats')} actions={[searchAct, { key: 'new', icon: 'chatplus', label: t('dm.new'), run: () => { if (!isPersonal) return; setTabQ(null); setDmGroup(true); } }, gearAct]} />)}
      {rootTab === 'channels' && (<PhoneHead left={orgRow ? <button type="button" className="ph-orgtitle" onClick={() => { setChPlus(false); setOrgMenu((v) => !v); }} aria-haspopup="menu" aria-expanded={orgMenu} aria-label={t('phone.org.switchNamed', { name: orgRow.name })}><I name="hash" size={22} className="ph-orgmark" /><span className="name">{orgRow.name}</span><SpaceBadge c={otherOrgsUnread} /><I name="caret" size={18} className="caret" /></button> : null} title={t('phone.tab.channels')} actions={[onOrgTab && !orgBlocked && searchAct, onOrgTab && !orgBlocked && { key: 'plus', icon: 'plus', label: t('phone.ch.add'), menu: true, on: chPlus, run: () => { setOrgMenu(false); setChPlus((v) => !v); } }, gearAct]}>{orgMenuPop}{chPlusPop}</PhoneHead>)}
      {rootTab === 'agents' && (<PhoneHead title={t('phone.tab.agents')} actions={[searchAct, { ...gearAct, run: () => openSettings(null, 'agents') }]} />)}
      {rootTab === 'memory' && (<PhoneHead left={orgRow ? <button type="button" className="ph-orgtitle" onClick={() => setOrgMenu((v) => !v)} aria-haspopup="menu" aria-expanded={orgMenu} aria-label={t('phone.org.switchNamed', { name: orgRow.name })}><I name="folder" size={22} className="ph-orgmark" /><span className="name">{orgRow.name}</span><I name="caret" size={18} className="caret" /></button> : null} title={t('phone.tab.memory')} actions={[onOrgTab && !orgBlocked && searchAct, { ...gearAct, run: () => openSettings(null, 'memory') }]}>{orgMenuPop}</PhoneHead>)}
      {searchBar}
      <div className="msgr-railbody ph-body" ref={pullList.setRef}><PullIndicator phase={pullList.phase} pulse={pullList.pulse} t={t} /><div className="msgr-railinner">
        {rootTab === 'friends' && (<>
          {(() => { const label = me?.display_name || session.user.email; return !tabQText.trim() && (
            <button type="button" className="item ph-me" onClick={() => openSettings('me')}><Av name={label} size="kk" userId={uid} /><span className="ph-kbody"><span className="name">{label}</span><span className="snip">{t('phone.friends.meSub')}</span></span></button>); })()}
          {friendReqs.length > 0 && !tabQText.trim() && (<>
            <button type="button" className="item ph-reqrow" aria-expanded={reqOpen} onClick={() => setReqOpen((v) => !v)}><span className="ph-reqic"><I name="personplus" size={18} /></span><span className="name">{t('phone.friends.requests', { n: friendReqs.length })}</span><I name="caret" size={20} className={`ph-chev${reqOpen ? ' open' : ''}`} /></button>
            {reqOpen && <div className="ph-reqs">{friendReqs.map((f) => (
              <div key={f.user_id} className="ph-req"><Av name={f.display_name || f.handle || '?'} size="lg" userId={f.user_id} /><span className="name">{f.display_name || f.handle || f.user_id.slice(0, 8)}</span>
                <button type="button" className="btn btn-primary" onClick={() => decideFriend(f, true)}>{t('phone.friends.accept')}</button><button type="button" className="btn" onClick={() => decideFriend(f, false)}>{t('phone.friends.decline')}</button></div>))}</div>}
          </>)}
          <div className="ph-sechead">{t('phone.friends.count', { n: friendList.length })}</div>
          {(() => { const shown = tabSearch(friendList, tabQText, (f) => [f.display_name, f.handle]); return (<>
            <div className="msgr-list ph-friends">{shown.map((f) => (
              <button key={f.user_id} type="button" className="item ph-frow" onClick={() => { setTabQ(null); openPersonalDm(f.user_id); }}><Av name={f.display_name || f.handle || '?'} size="lg" userId={f.user_id} /><span className="name">{f.display_name || f.handle || f.user_id.slice(0, 8)}</span></button>))}</div>
            {!friendList.length && <div className="msgr-hint">{t('friends.none')} {t('phone.friends.add.hint')}</div>}
            {searchFoot(shown.length > 0)}
          </>); })()}
        </>)}
        {rootTab === 'chats' && (<>
          <div className="ph-chiprow">
            <div className="ph-chips" role="radiogroup" aria-label={t('dm.filter')}>{CHAT_FILTERS.map((k) => <button key={k} type="button" role="radio" aria-checked={dmFilter === k} className={dmFilter === k ? 'active' : ''} onClick={() => pickDmFilter(k)}>{k === 'unread' ? (chatUnreadTotal(chatsAll, unread, muted) ? t('phone.chip.unread', { n: chatUnreadTotal(chatsAll, unread, muted) }) : t('phone.chip.unread0')) : t(`phone.chip.${k}`)}</button>)}</div>
            <span className="msgr-sortwrap msgr-dmsort"><button type="button" className={`msgr-sortbtn${dmSortMenu ? ' on' : ''}`} onClick={() => setDmSortMenu((v) => !v)} title={t('dm.sort')} aria-label={t('dm.sort')} aria-haspopup="menu" aria-expanded={dmSortMenu}><I name="sort" size={16} /></button>{dmSortMenu && <div className="msgr-rowmenu" role="menu">{DM_SORTS.map((v) => <button key={v} type="button" role="menuitemradio" aria-checked={dmSort === v} onClick={() => { pickDmSort(v); setDmSortMenu(false); }}>{dmSort === v ? <I name="check" size={13} /> : <span className="mi" style={{ width: 13 }} />}{t(`dm.sort.${v}`)}</button>)}</div>}</span>
          </div>
          {(() => { const { favs: chatFavs, rest: chatRest } = splitFavs(chatShown, pinned); return (<>{/* 즐겨찾기한 대화는 맨 위 단락으로 따로(유건 2026-10-02) — 끌기는 단락 안에서만(.msgr-list가 끌기 범위) */}
            {chatFavs.length > 0 && (<><div className="ph-sechead">{t('phone.sec.fav')}</div><div className={`msgr-list ph-rooms ph-favs${dmAnim ? ` anim-list-${dmAnim}` : ''}`}>{chatFavs.map((c) => kRow(c, chatDrop(c)))}</div>{chatRest.length > 0 && <div className="ph-sechead">{t('phone.sec.chats')}</div>}</>)}
            <div className={`msgr-list ph-rooms${dmAnim ? ` anim-list-${dmAnim}` : ''}`}>{chatRest.map((c) => kRow(c, chatDrop(c)))}</div>
          </>); })()}
          {isPersonal && spaceReady && !chatShown.length && !tabQText.trim() && <div className="msgr-hint ph-empty">{t(chatsAll.length ? `phone.chats.empty.${dmFilter}` : 'phone.chats.empty')}{!chatsAll.length && <div className="ph-emptyacts"><button type="button" className="btn btn-primary" onClick={() => { setTabQ(null); setDmGroup(true); }}><I name="chatplus" size={15} />{t('dm.new')}</button></div>}</div>}{/* 첫 행동은 단추로(UXM-24) */}
          {(!isPersonal || !spaceReady) && <div className="msgr-hint ph-empty" role="status">{t('ui.loading')}</div>}
          {searchFoot(chatShown.length > 0)}
        </>)}
        {rootTab === 'channels' && (!orgs?.length ? (
          <div className="ph-noorg">
            <h2>{t('phone.ch.noOrg.title')}</h2><p>{t('phone.ch.noOrg.body')}</p>
            <div className="ph-noorg-acts">
              <button type="button" className="btn btn-primary" onClick={() => { setOrgMenu(true); setJoinCode(null); setNewOrg(''); }}><I name="plus" size={14} />{t('phone.org.create')}</button>
              <button type="button" className="btn" onClick={() => { setOrgMenu(true); setNewOrg(null); setJoinCode(''); setJoinHint(null); }}><I name="link" size={14} />{t('phone.org.join')}</button>
            </div>
          </div>
        ) : !onOrgTab ? <div className="msgr-hint ph-empty" role="status">{t('ui.loading')}</div>
          : orgGateActive ? <AiConsentGate t={t} onMenu={openNav} onError={setErr} onDecline={() => setPage('chats')} bare />
          : aiConsentLoading ? <OrgGateLoading t={t} bare />
          : (<>
          <div className="ph-chiprow ph-chmenu">{/* 채팅 탭 칩과 같은 모양 — 그룹이 늘면 가로 스크롤, 그룹 칩을 길게 누르면 이름 바꾸기·채널 넣고 빼기·지우기 */}
            <div className="ph-chips" role="radiogroup" aria-label={t('phone.chmenu')}>
              {channelMenu(grp.groups).map((k) => { const g = k.startsWith('g:') ? grp.groups.find((x) => `g:${x.id}` === k) : null; return <HoldChip key={k} on={chMenuKey === k} label={g ? g.name : t(`phone.chmenu.${k}`)} onPick={() => setChMenu(k)} onHold={g ? () => setGrpSheet({ mode: 'edit', id: g.id }) : null} />; })}
              <button type="button" className="ph-chipadd" onClick={() => setGrpSheet({ mode: 'new' })} aria-label={t('phone.chmenu.add')} title={t('phone.chmenu.add')}><I name="plus" size={16} /></button>
            </div>
          </div>
          {newCh && (
            <form className="msgr-inline ph-inline" onSubmit={(e) => { e.preventDefault(); createChannel(); }}>
              <input className="msgr-input" placeholder={t('ch.name')} value={newCh.name} onChange={(e) => setNewCh((c) => ({ ...c, name: e.target.value }))} autoFocus maxLength={80} />
              <Seg label={t('ch.new.kind')} value={newCh.kind} onPick={(v) => setNewCh((c) => ({ ...c, kind: v }))} options={[['public', t('ch.new.public')], ['private', t('ch.new.private')]].map(([v, l]) => ({ v, label: l, icon: <I name={v === 'private' ? 'lock' : 'hash'} size={12} /> }))} />
              <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!newCh.name.trim()}><I name="check" size={13} />{t('ui.create')}</button><button type="button" className="btn sm" onClick={() => setNewCh(null)}>{t('ui.cancel')}</button></div>
            </form>
          )}
          {browse && (<div className="msgr-browse ph-browse">
            <div className="ph-sechead">{t('ch.browse')}<button type="button" className="ph-secx" onClick={() => setBrowse(null)} aria-label={t('ui.close')}><I name="x" size={14} /></button></div>
            {browse.length === 0 ? <p className="empty">{t('ch.browse.none')}</p>
              : browse.map((c) => (<div key={c.id} className="row"><span className="name"><I name="hash" size={13} />{c.name}</span><span className="msgr-klabel">{t('ch.browse.members', { n: c.members })}</span><button type="button" className="btn btn-primary sm" onClick={() => joinChannel(c)}>{t('ch.browse.join')}</button></div>))}
          </div>)}
          <div className="ph-sechead">{chMenuGroup ? chMenuGroup.name : t('phone.sec.channels')}</div>
          <div className="msgr-list ph-rooms">{chChannelsShown.map((c) => kRow(c, { onDrop: pinned.has(c.id) ? reorderFav : reorderChannels }))}</div>
          {!chChannels.length && !tabQText.trim() && (isAdmin && !previewChannels.length ? <div className="msgr-phsteps"><OrgStepList steps={orgSteps({ t, ...onboard, hasChannel: false, createChannel: chOffer.can ? openNewCh : null, newWhy: chOffer.why, invite: orgInvite })} /></div>
            : <div className="msgr-hint ph-empty">{t(previewChannels.length ? 'inv.empty.title' : chOffer.can ? 'ch.noneYet' : chOffer.why ?? 'ch.noneYet.short')} {previewChannels.length > 0 && <button type="button" className="btn sm" onClick={openBrowse}><I name="hash" size={13} />{t('inv.empty.browse')}</button>}</div>)}
          {chChannels.length > 0 && !chMenuList.length && !tabQText.trim() && <div className="msgr-hint ph-empty">{t(chMenuKey === 'fav' ? 'grp.fav.empty' : chMenuGroup ? 'grp.empty' : 'grp.channels.allGrouped')}</div>}
          {!chMenuGroup && (chTalksMenu.length > 0 || (chMenuKey === 'channels' && !tabQText.trim())) && <div className="ph-sechead">{t('phone.sec.talks')}<button type="button" className="ph-secbtn" onClick={() => { setTabQ(null); setDmGroup(true); }}><I name="chatplus" size={15} />{t('dm.new')}</button></div>}
          <div className="msgr-list ph-rooms">{chTalksShown.map((c) => kRow(c, { onDrop: pinned.has(c.id) ? reorderFav : (id, before, visible) => reorderChannelPos(chTalks.filter((x) => !pinned.has(x.id)), id, before, visible) }))}</div>
          {chMenuKey === 'channels' && !chTalks.length && !tabQText.trim() && <div className="msgr-hint ph-empty">{t('phone.talks.empty')}</div>}
          {searchFoot(chChannelsShown.length + chTalksShown.length > 0)}
        </>))}
        {rootTab === 'memory' && (!orgs?.length ? <div className="msgr-hint ph-empty">{t('phone.memory.noOrg')}</div>
          : !onOrgTab ? <div className="msgr-hint ph-empty" role="status">{t('ui.loading')}</div>
          : orgGateActive ? <AiConsentGate t={t} onMenu={openNav} onError={setErr} onDecline={() => setPage('chats')} bare />
          : aiConsentLoading ? <OrgGateLoading t={t} bare />
          : <PhoneMemory key={orgRow.id} org={orgRow} channels={channels} previewChannels={previewChannels} dmName={dmName} nameOfUser={nameOfUser} query={tabQText} sort={memSort} onSort={pickMemSort} onError={setErr} searchFoot={searchFoot} onOpen={(doc, label) => { setMemDoc({ doc, label }); setPage('memdoc'); }} />)}
        {rootTab === 'agents' && (<>
          {!tabQText.trim() && <div className="ph-apcard-wrap">{/* 결재 대기 카드 — 누르면 쌓인 결재만 모은 페이지(유건 2026-10-02) */}
            <button type="button" className={`ph-apcard${approvalItems.length ? ' on' : ''}`} onClick={() => { setTabQ(null); setPage('approvals'); }} disabled={!approvalItems.length}>
              <span className="ph-aphead"><span className="ph-apic"><I name="stamp" size={18} /></span><span className="ph-kbody"><span className="name">{t('phone.agents.approvals', { n: approvalItems.length })}</span><span className="snip">{approvalItems.length ? t('phone.agents.approvals.tap') : t('phone.agents.approvals.none')}</span></span>{approvalItems.length > 0 && <I name="next" size={20} className="ph-apgo" />}</span>
              {approvalItems.slice(0, 3).map((it) => (
                <span key={it.key} className="ph-aprow">
                  <Av name={myAgents?.find((c) => c.id === it.crew_id)?.display_name ?? crewOf(it.crew_id)?.display_name ?? it.crewName ?? '?'} crew size="sm" crewId={it.crew_id} />
                  <span className="ph-kbody"><span className="snip">{approvalSum(it)}</span><span className="ph-apmeta">{[levelOf(it) && t(`ap.level.${levelOf(it)}`), it.org_id ? spaceName(it.org_id) : null, fmtDmWhen(t('time.yesterday'), Date.parse(it.at), lang)].filter(Boolean).join(' · ')}</span></span>
                </span>))}
              {approvalItems.length > 3 && <span className="ph-apmore">{t('phone.agents.approvals.more', { n: approvalItems.length - 3 })}</span>}
            </button>
          </div>}
          {agentGroups.length > 0 && <div className="ph-chiprow">
            <div className="ph-chips" role="radiogroup" aria-label={t('phone.agents.filter')}>{AGENT_FILTERS.map((k) => <button key={k} type="button" role="radio" aria-checked={agentFilter === k} className={agentFilter === k ? 'active' : ''} onClick={() => setAgentFilter(k)}>{k === 'all' ? t('phone.chip.all') : t(`phone.agents.chip.${k}`)}</button>)}</div>
          </div>}
          {agentSecs.map((sec) => (<div key={sec.key}><div className="ph-sechead">{t(sec.key === 'fav' ? 'phone.agents.fav' : `phone.agents.${sec.key}`)}</div><div className="msgr-list ph-agents">{sec.list.map(agentRow)}</div></div>))}
          {myAgents === null && <div className="msgr-hint ph-empty" role="status">{t('ui.loading')}</div>}
          {myAgents !== null && !agentGroups.length && !tabQText.trim() && <div className="msgr-hint ph-empty">{t('phone.agents.none')}<div className="ph-emptyacts"><RunnerButton primary /></div></div>}
          {myAgents !== null && agentGroups.length > 0 && agentFilter !== 'all' && !agentSecs.length && !tabQText.trim() && <div className="msgr-hint ph-empty">{t(`phone.agents.empty.${agentFilter}`)}</div>}
          {searchFoot(agentSecs.length > 0)}
        </>)}
      </div></div>
    </div>
  );
  return (
    <AvatarCtx.Provider value={avatarCtx}><SafetyCtx.Provider value={safetyCtx}><RunnerCtx.Provider value={openRunner}>
    <div className={`shell msgr-shell${online ? '' : ' is-offline'}${rail ? ' rail-open' : ''}${isPhone ? ' msgr-phone' : ''}${isPhone && isPhoneRoot(page) ? ' phone-home' : ''}${isPhone && page === 'chat' ? ' phone-chat' : ''}${isPhone && ROOT_PAGES.has(page) ? ' phone-root' : ''}${isPhone && pageAnim ? ` anim-${pageAnim}` : ''}`}>
      {!online && <div className="msgr-offline-bar" role="status">{t('net.offline')}</div>}
      {rail && <div className="msgr-scrim" onClick={() => setRail(false)} role="presentation" />}
      {dmPeek && <DmPeekSheet channel={dmPeek} name={dmName(dmPeek)} uid={uid} whoOf={(m) => dmWho(dmPeek, { mine: m.author_user_id === uid, userId: m.author_user_id, crewId: m.crew_id })} onOpen={() => { const c = dmPeek; setDmPeek(null); if (openAgentDmInstead(c.id, 'peek')) return; setChId(c.id); setRail(false); setPage('chat'); }} onClose={() => setDmPeek(null)} />}
      <aside id="msgr-navigation" className={`side msgr-side${orgMenu ? ' menu-open' : ''}`}>
        {isPhone ? phoneRoot : (<>
        <button type="button" className="msgr-rail-close" onClick={() => setRail(false)} aria-label={t('ui.close')}><I name="x" /></button>
        <div className="msgr-brand"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO</div>
        <div className="msgr-orgwrap">
          {isPhone && <span className="msgr-smalltitle" aria-hidden="true">{dmTab ? t('phone.tab.dm') : isPersonal ? t('personal.space') : (org?.name ?? t('org.pick'))}</span>}
          <button type="button" className={`msgr-org${orgMenu ? ' open' : ''}${isPersonal ? ' personal' : ''}`} onClick={() => setOrgMenu((v) => !v)} aria-haspopup="menu" aria-expanded={orgMenu} title={t('org.switch')}>
            {isPersonal ? <PersonalMark /> : <Av name={org?.name ?? '?'} />}<span className="name">{isPersonal ? t('personal.space') : (org?.name ?? t('org.pick'))}</span><SpaceBadge c={elsewhere} /><I name="caret" size={14} className="caret" />
          </button>
          <form className="msgr-search" onSubmit={(e) => { e.preventDefault(); runSearch(searchQ); }}><I name="search" size={13} /><input ref={searchRef} value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); leaveSearch(); e.currentTarget.blur(); } }} placeholder={t('search.ph', { key: shortcutLabel('K') })} aria-label={t('search.title')} />{searchQ.trim() && !searchBusy && searchRes?.q !== searchQ.trim() && <span className="msgr-search-enter" aria-hidden="true">{t('search.enter')}</span>}{searchQ && <button type="button" className="clear" onClick={leaveSearch} aria-label={t('ui.close')}><I name="x" size={12} /></button>}</form>{/* 입력만으로는 반응이 없어 Enter를 몰랐다(UXM-21) — 매 글자 검색은 조회가 늘어 하지 않는다 */}
          {orgMenu && (<>
            <div className="msgr-scrim clear" onClick={() => setOrgMenu(false)} />
            <div className="msgr-menu-pop" role="menu">
              <button type="button" role="menuitemradio" aria-checked={isPersonal} className={isPersonal ? 'on' : ''} onClick={() => { setOrgId(PERSONAL); setOrgMenu(false); }}><PersonalMark sm /><span className="label">{t('personal.space')}</span><SpaceBadge c={spaceCount('personal')} /></button>
              <div className="sep" />
              {orgs.map((o) => <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === orgId} className={o.id === orgId ? 'on' : ''} onClick={() => { setOrgId(o.id); setOrgMenu(false); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t(`role.${o.role}`)}</span><SpaceBadge c={spaceCount(o.id)} /></button>)}
              {joinable.map((o) => <button key={`j-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); joinDomain(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.join.cta')}</span></button>)}
              {deletedOrgs.map((o) => <button key={`d-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); restoreOrg(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.restore.cta', { days: Math.max(0, Math.ceil((Date.parse(o.purge_at) - Date.now()) / 86_400_000)) })}</span></button>)}
              <div className="sep" />
              {isAdmin && <button type="button" role="menuitem" onClick={() => { setOrgMenu(false); orgInvite(); }}><span className="msgr-av sm ghost"><I name="copy" size={13} /></span><span className="label">{t('inv.org')}</span></button>}
              {orgJoinForms()}
            </div>
          </>)}
        </div>
        <div className={`msgr-railbody${dmTab && dmAnim ? ` anim-list-${dmAnim}` : ''}`} ref={pullList.setRef}><PullIndicator phase={pullList.phase} pulse={pullList.pulse} t={t} /><div className="msgr-railinner">
          {isPhone && (dmTab ? <h1 className="msgr-bigtitle">{t('phone.tab.dm')}</h1> : <button type="button" className="msgr-bigtitle" onClick={() => setOrgMenu((v) => !v)} aria-haspopup="menu" aria-expanded={orgMenu} title={t('org.switch')}><span className="name">{isPersonal ? t('personal.space') : (org?.name ?? t('org.pick'))}</span><SpaceBadge c={elsewhere} /><I name="caret" size={18} className="caret" /></button>)}{/* 폰 큰 제목(유건 승인 초안 2026-09-29) — 스크롤하면 머리의 작은 제목으로 접힌다. 홈은 조직 전환 단추를 겸한다 */}{/* 내용 래퍼 — 폰에서 min-height: 100%+1px로 늘 1px 넘치게 해 짧은 목록도 iOS 바운스가 된다(유건 2026-09-14) */}
        {railRoom.showFavs && (<RailSection id="fav" label={`${t('rail.fav')} · ${favs.length}`}>{/* 즐겨찾기 — 채널·1:1 대화 한 목록, 끌어서 순서(유건 지시 2026-09-12) */}
          <div className="msgr-list">{favs.map((c) => c.kind === 'target' ? targetRow(c) : c.kind === 'dm' ? dmRow(c) : chRow(c))}</div>
        </RailSection>)}
        {!isPersonal && isPhone && orgGateActive && ( // M-5: 폰은 레일이 화면 전체라 여기서 bare 게이트. 넓은 배치는 본문만(iPad 중복 표시 실측 2026-09-27)
          <AiConsentGate t={t} onMenu={openNav} onError={setErr} onDecline={() => setOrgId(PERSONAL)} bare />
        )}
        {!isPersonal && isPhone && aiConsentLoading && ( // L-3: 조회 중 로딩(같은 이유로 폰만 bare)
          <OrgGateLoading t={t} bare />
        )}
        {!isPersonal && !orgBlocked && <RailSection id={orgId ? 'channels' : 'start'} label={orgId ? t('ch.list') : t('org.start')} right={!orgId ? null : <span className="right">
          <button type="button" className="btn msgr-chbrowse" onClick={() => browse ? setBrowse(null) : openBrowse()} disabled={!orgId} title={t('ch.browse')} aria-label={t('ch.browse')} aria-expanded={!!browse}><I name="hash" size={14} /></button>
          {canNewCh && <button type="button" className="btn msgr-chnew" onClick={() => newCh ? setNewCh(null) : openNewCh()} disabled={!orgId} title={t('ch.new')} aria-label={t('ch.new')} aria-expanded={!!newCh}><I name={newCh ? 'x' : 'plus'} size={14} /></button>}
        </span>}>
          {browse && (<div className="msgr-browse">
            {browse.length === 0
              ? <p className="empty">{t('ch.browse.none')}</p>
              : browse.map((c) => (<div key={c.id} className="row">
                  <span className="name"><I name="hash" size={13} />{c.name}</span>
                  <span className="msgr-klabel">{t('ch.browse.members', { n: c.members })}</span>
                  <button type="button" className="btn btn-primary sm" onClick={() => joinChannel(c)}>{t('ch.browse.join')}</button>
                </div>))}
          </div>)}
        {newCh && (
          <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); createChannel(); }}>
            <input className="msgr-input" placeholder={t('ch.name')} value={newCh.name} onChange={(e) => setNewCh((c) => ({ ...c, name: e.target.value }))} autoFocus maxLength={80} />
            <Seg label={t('ch.new.kind')} value={newCh.kind} onPick={(v) => setNewCh((c) => ({ ...c, kind: v }))} options={[['public', t('ch.new.public')], ['private', t('ch.new.private')]].map(([v, l]) => ({ v, label: l, icon: <I name={v === 'private' ? 'lock' : 'hash'} size={12} /> }))} />
            <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!newCh.name.trim()}><I name="check" size={13} />{t('ui.create')}</button><button type="button" className="btn sm" onClick={() => setNewCh(null)}>{t('ui.cancel')}</button></div>
          </form>
        )}
        {hasChannelRows(channels) ? ( // 조직 1:1(dm)은 채널이 아니다 — channels.length로 세면 1:1만 있는 멤버에게 둘러보기 안내가 숨는다(점검 A·B #2)
          <div className="msgr-list">
            {sortedCh.map(chRow)}
          </div>
        ) : isPhone && org && isAdmin && !isPersonal && !previewChannels.length ? <div className="msgr-phsteps"><OrgStepList steps={orgSteps({ t, ...onboard, hasChannel: false, createChannel: chOffer.can ? openNewCh : null, newWhy: chOffer.why, invite: orgInvite })} /></div>
          : org && previewChannels.length ? <div className="msgr-hint">{t('inv.empty.title')} <button type="button" className="btn sm" onClick={() => { setRail(true); openBrowse(); }}><I name="hash" size={13} />{t('inv.empty.browse')}</button></div>
          : isPhone && !orgId ? <div className="msgr-phsteps"><OrgStepList steps={noOrgSteps({ t, createOrg: () => { setOrgMenu(true); setNewOrg(''); }, joinWithCode, joinable, joinDomain, deletedOrgs, restoreOrg })} /></div>
          : <div className="msgr-hint">{orgId ? t(chOffer.can ? 'ch.noneYet' : chOffer.why ?? 'ch.noneYet.short') : t('org.none')}</div>}{/* 폰 홈에는 빈 조직 안내(본문)가 안 보인다 — 같은 시작 단계를 목록 자리에(D3) */}
                  {isPhone && org && <button type="button" className="item msgr-addrow" onClick={() => setNewCh({ name: '', kind: newChKind })}><I name="plus" size={18} /><span className="name">{t('ch.new')}</span></button>}
                  {isPhone && org && previewChannels.length > 0 && <button type="button" className="item msgr-addrow msgr-chbrowse" onClick={() => browse ? setBrowse(null) : openBrowse()} aria-expanded={!!browse}><I name="hash" size={18} /><span className="name">{t('ch.browse.row')}</span></button>}{/* 폰은 구역 머리의 둘러보기 단추가 숨는다(.right display:none) — 참여할 수 있는 공개 채널이 있으면 새 채널 옆 행으로(점검 A·B #2) */}
</RailSection>}
        {dmTab && <Seg className="msgr-dmfilter" label={t('dm.filter')} value={dmFilter} onPick={pickDmFilter} options={DM_FILTERS.map((k) => ({ v: k, label: t(`dm.filter.${k}`) }))} />}
        {dmPinnedShown.length > 0 && (<RailSection id="dmpin" label={t('dm.pinned')} forceOpen><div className="msgr-list">{dmPinnedShown.map(dmRow)}</div></RailSection>)}
        {railRoom.showDms && (<RailSection id="dms" label={t('ch.dms')} forceOpen={dmTab} right={<span className="right">{dmTab && <span className="msgr-sortwrap msgr-dmsort"><button type="button" className={`msgr-sortbtn${dmSortMenu ? ' on' : ''}`} onClick={() => setDmSortMenu((v) => !v)} title={t('dm.sort')} aria-label={t('dm.sort')} aria-haspopup="menu" aria-expanded={dmSortMenu}><I name="sort" size={14} /></button>{dmSortMenu && <div className="msgr-rowmenu" role="menu" onMouseLeave={() => setDmSortMenu(false)}>{DM_SORTS.map((v) => <button key={v} type="button" role="menuitemradio" aria-checked={dmSort === v} onClick={() => { pickDmSort(v); setDmSortMenu(false); }}>{dmSort === v ? <I name="check" size={13} /> : <span className="mi" style={{ width: 13 }} />}{t(`dm.sort.${v}`)}</button>)}</div>}</span>}
          <button type="button" className="btn" onClick={() => setDmGroup(true)} disabled={!orgId} title={t('dm.new')} aria-label={t('dm.new')}><I name="plus" size={14} /></button>{/* 새 대화 — 종전에는 폰에만 있어서 PC에서는 멤버 목록을 거쳐야 했다(유건 2026-09-16) */}
        </span>}>{/* 폰 DM 탭은 비어 있어도 안내를 띄운다 — 빈 화면이 되지 않게 */}
          <div className="msgr-list">{dmList.map(dmRow)}</div>
          {!dmList.length && dmEmptyKey({ filter: dmTab ? dmFilter : 'all', total: channels.filter((c) => c.kind === 'dm').length }) && <div className="msgr-hint">{t(dmEmptyKey({ filter: dmTab ? dmFilter : 'all', total: channels.filter((c) => c.kind === 'dm').length }))}</div>}{/* 필터 결과가 비었을 때 대화가 사라진 것처럼 "아직 채팅이 없습니다"라고 하지 않는다(점검 A·B #6) */}
        </RailSection>)}
        {isPersonal && !dmTab && (<RailSection id="friends" label={`${t('rail.friends')} · ${withoutHidden(members, hiddenUserIds).length}`} forceOpen right={<button type="button" className="btn" onClick={() => setFriendAdd(true)} title={t('friends.add')} aria-label={t('friends.add')}><I name="plus" size={14} /></button>}>{/* 채팅 → 친구 순서(유건 2026-09-18 — 대화가 먼저, 조직의 채널/채팅 → 멤버와 같은 순서). 개인 공간 홈 = 친구 목록, 채팅 탭 = 채팅 목록(카톡식, 유건 2026-09-17). 개인 공간의 members는 수락된 친구다(loadPersonal) */}
          <div className="msgr-list dir">
            {[...withoutHidden(members, hiddenUserIds)].sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''))).map((m) => (
              <button key={m.user_id} type="button" className="item" onClick={() => { openPersonalDm(m.user_id); setRail(false); }} title={t('friends.dm')}>
                <Av name={m.display_name || '?'} size="xs" userId={m.user_id} /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span>
              </button>))}
          </div>
          {!members.length && <div className="msgr-hint">{t('friends.none')} {t('phone.friends.add.hint')}</div>}
        </RailSection>)}
        {!isPersonal && !orgBlocked && org && members.length > 0 && (<RailSection id="people" label={`${t('rail.people')} · ${members.length}`}>{/* 멤버 디렉터리(유건 2026-09-12) — 나 먼저, 이름순. 누르면 DM */}
          <div className="msgr-list dir">
            {peopleSorted.map((m) => (
              <button key={m.user_id} type="button" data-drag-id={m.user_id} className={`item${m.user_id === uid ? ' me' : ''}`} {...(isPhone ? rowLongPress({ id: m.user_id }, personCtx(m), { onDrop: reorderPeople }) : {})} onClick={() => { if (m.user_id !== uid) { openDm('user', m.user_id); setRail(false); } }} onContextMenu={(e) => { if (Date.now() - (lpStates.current[m.user_id]?.firedAt ?? 0) < 800) { e.preventDefault(); return; } openCtx(e, personCtx(m)); }} title={m.user_id === uid ? t('rail.me') : t('ui.dm')}>
                <Av name={m.display_name || '?'} size="xs" userId={m.user_id} /><span className="name">{m.display_name || m.user_id.slice(0, 8)}{m.user_id === uid && <span className="msgr-klabel"> · {t('rail.me')}</span>}</span><span className="msgr-klabel tag">{t(`role.${m.role}`)}</span>
              </button>))}
          </div>
        </RailSection>)}
        {(isPersonal ? railVisible.length > 0 : !orgBlocked && org) && (<RailSection id="mine" label={`${t('rail.agents')} · ${railVisible.length}`} right={<span className="right">{railVisible.length > 0 && <span className="msgr-sortwrap msgr-railsort"><button type="button" className={`msgr-sortbtn${sortMenu ? ' on' : ''}`} onClick={() => setSortMenu((v) => !v)} title={t('rail.sort')} aria-label={t('rail.sort')} aria-haspopup="menu" aria-expanded={sortMenu}><I name="sort" size={14} /></button>{sortMenu && <div className="msgr-rowmenu" role="menu" onMouseLeave={() => setSortMenu(false)}>{['name', 'added', 'custom'].map((v) => <button key={v} type="button" role="menuitemradio" aria-checked={railSort === v} onClick={() => { pickSort(v); setSortMenu(false); }}>{railSort === v ? <I name="check" size={13} /> : <span className="mi" style={{ width: 13 }} />}{t(`rail.sort.${v}`)}</button>)}</div>}</span>}{myAvailable.length > 0 && <span className="msgr-klabel">{myCrews.length}/{myCrews.length + myAvailable.length}</span>}</span>}>
          <div className="msgr-list mine">
            {!isPersonal && !myAvailable.length && !railVisible.length && <p className="msgr-rail-empty">{t('phone.agents.none')} <RunnerButton /></p>}{/* 비어도 구역과 연결 단추를 둔다 — 통째로 사라져 에이전트를 붙일 곳이 안 보였다(UXM-08) */}
            {/* 묶음마다 접었다 편다(유건 2026-09-16) — 조직의 다른 에이전트는 한 절에서(유건 제보 2026-09-12: 절이 둘로 중복) */}
            {[['mine.argo', 'rail.agents.mine', railArgo], ['mine.ext', 'rail.src.custom', railExt], ['mine.company', 'rail.agents.company', railCompany]]
              .map(([id, k, list]) => list.length > 0 && <RailFold key={id} id={id} label={t(k)} count={list.length}>{list.map(railRow)}</RailFold>)}
            {myAvailable.map((c) => { // 목록에서 그 자리 파견(유건 지시 2026-09-08) — 채널을 보고 있으면 그 채널까지(DM은 조직만), 아니면 조직만
              const target = channel && (channel.personal_crews ?? 'approval') !== 'blocked' ? channel : null; // 대화방도 그 자리 파견 대상이다(유건 2026-09-16)
              const go = async () => { if (railBusy) return; setRailBusy(c.id); try { const r = await dispatchCrew(c, target?.id ?? null); if (target && (r === 'joined' || r === 'already')) bumpMembers(); /* 넣은 직후 @이름이 '없어요'로 나가지 않게(검수 #826 LOW-4) */ setNote(t(r === 'requested' ? 'ch.crew.join.requested' : target ? 'ch.add.mine.done' : 'rail.mine.dispatched', { name: c.display_name })); } catch (e) { setErr(e.message); } finally { setRailBusy(null); } };
              return (
                <div key={c.id} className="msgr-railrow dim">
                  <button type="button" className="item dim" onClick={() => setSheet(c.id)} onContextMenu={(e) => openCtx(e, [{ icon: 'gear', label: t('ctx.crew.card'), run: () => setSheet(c.id) }, { icon: 'plus', label: t('rail.mine.dispatch'), run: go }])} disabled={railBusy === c.id} title={t('rail.mine.off')}><Av name={c.display_name} crew size="xs" crewId={c.id} /><span className="name">{c.display_name}</span><span className="msgr-klabel">{t('rail.mine.offShort')}</span></button>
                  <button type="button" className="dispatch" onClick={go} disabled={railBusy === c.id} title={target ? t('rail.mine.off.ch', { ch: target.name }) : t('rail.mine.dispatch')} aria-label={t('rail.mine.dispatch')}><I name="plus" size={12} />{railBusy === c.id ? t('rail.mine.dispatching') : t('rail.mine.dispatch')}</button>
                </div>
              ); })}
          </div>
        </RailSection>)}

        </div></div>
        </>)}
        {ctx && <CtxMenu at={ctx} items={ctx.items} onClose={() => setCtx(null)} />}
        {railAction && createPortal(<div ref={actionDialog} onKeyDown={trapActionFocus} className="shell msgr-action-dialog" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t(railActionKey)}>
          {railAction.kind === 'delete'
            ? <DangerModal title={t(railActionKey)} description={<>{t(railActionKey === 'ch.leave' && railAction.channel.kind === 'public' ? 'ch.leave.confirm.note.public' : `${railActionKey}.confirm.note`)}{actionError && <span role="alert" style={{ display: 'block', color: 'var(--danger)', marginTop: 8 }}>{actionError}</span>}</>} requireText={railAction.channel.kind === 'dm' ? dmName(railAction.channel) : railAction.channel.name} confirmLabel={t(railActionKey)} busy={actionBusy} onConfirm={confirmRailAction} onClose={() => { if (!actionLock.current) setRailAction(null); }} />
            : <ConfirmModal title={t(railActionKey)} description={<>{t(railActionKey === 'ch.leave' && railAction.channel.kind === 'public' ? 'ch.leave.confirm.note.public' : `${railActionKey}.confirm.note`)}{actionError && <span role="alert" style={{ display: 'block', color: 'var(--danger)', marginTop: 8 }}>{actionError}</span>}</>} confirmLabel={t(railActionKey)} busy={actionBusy} onConfirm={confirmRailAction} onClose={() => { if (!actionLock.current) setRailAction(null); }} />}
        </div>, document.body)}
        {!isPhone && <div className="msgr-foot">
          {isPhone && !orgBlocked && nodeInd && <button type="button" className={`ph-node${nodeInd.state === 'on' ? ' on' : nodeInd.state === 'down' ? ' down' : ''}`} onClick={() => { setSettingsTab('crews'); setPage('settings'); setRail(false); }} title={nodeLabel} aria-label={nodeLabel}><I name={nodeInd.state === 'on' ? 'node' : 'nodeoff'} size={18} /></button>}{/* 서버를 연결하는 사람(관리자)에게만, 없음은 중립색·끊김만 경고색(점검 A·B #11) */}
          <button type="button" className="me" onClick={() => { if (isPhone) { setSettingsTab('me'); setPage('settings'); setRail(false); } else setMeMenu((v) => !v); }} aria-haspopup={isPhone ? undefined : 'menu'} aria-expanded={isPhone ? undefined : meMenu} title={t(isPhone ? 'ui.settings' : 'ui.me.menu')}>
            <Av name={me?.display_name || session.user.email} size="sm" userId={uid} /><span className="name">{me?.display_name || session.user.email}</span>
          </button>
          {meMenu && (<div className="msgr-rowmenu me" role="menu" onMouseLeave={() => setMeMenu(false)}>
            <button type="button" role="menuitem" onClick={() => { setMeMenu(false); setSettingsTab('me'); setPage('settings'); setRail(false); }}><I name="gear" size={13} />{t('set.tab.me')}</button>
            <button type="button" role="menuitem" className="danger" disabled={signingOut} onClick={() => { setMeMenu(false); signOut(); }}><I name="out" size={13} />{t('auth.signOut')}</button>
          </div>)}
          {org && !orgBlocked && <button type="button" className={`btn ghost bell${page === 'inbox' ? ' on' : ''}`} onClick={() => page === 'inbox' ? setPage('chat') : openInbox()} title={t('inbox.title')} aria-label={t('inbox.title')}><I name="bell" size={15} />{inboxUnread > 0 && <span className="n">{inboxUnread > 99 ? '99+' : inboxUnread}</span>}</button>}
          {org && isPersonal && !orgBlocked && !isPhone && <span className="btn ghost msgr-foot-slot" aria-hidden="true" />}{/* 개인 공간엔 기억이 없다 — 자리는 비워 둬 알림·설정 아이콘이 조직 공간과 같은 x에 있게(공간을 오갈 때 45px씩 움직이지 않는다, LA-22). 폰은 이 줄이 머리 오른쪽 원이라 해당 없음 */}
          {org && !isPersonal && !orgBlocked && <button type="button" className={`btn ghost${page === 'activity' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'activity' ? 'chat' : 'activity'); setRail(false); }} title={t('act.title')} aria-label={t('act.title')}><I name="folder" size={15} /></button>}{/* 기억 = 폴더(폰 아래 탭과 같은 뜻 — 반짝이는 에이전트, UXM-10) */}
          <button type="button" className={`btn ghost${page === 'settings' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'settings' ? 'chat' : 'settings'); setRail(false); }} title={t('ui.settings')} aria-label={t('ui.settings')} aria-pressed={page === 'settings'}><I name="gear" size={15} /></button>
        </div>}
      </aside>
      <main className="msgr-main" {...edgeBack}>
        {personalCard && <PersonalAgentCard crewId={personalCard} uid={uid} saveLook={saveLook} onClose={() => setPersonalCard(null)} onNote={setNote} onError={setErr} onChanged={() => { loadMyAgents().catch(() => {}); if (isPersonal) loadPersonal().catch(() => {}); }} />}
        {sheet && crewOf(sheet) && !orgBlocked && !isPersonal && <CrewSheet crew={crewOf(sheet)} saveLook={saveLook} org={org} uid={uid} me={me} members={members} policy={policy} channelId={chId} channelName={channel?.kind === 'dm' ? null : channel?.name} nameOfUser={nameOfUser} onClose={() => setSheet(null)} onChanged={() => loadOrg(orgId).catch(() => {})} onPosted={() => setEvent({ kind: 'message', channel_id: chId, at: Date.now() })} onNote={setNote} onError={setErr} onDm={() => dmWithCrew(sheet)} dmPersonal={dmGoesPersonal(crewOf(sheet))} />}
        {chSheet && channel && !orgBlocked && <ChannelSheet muted={muted.has(channel.id)} onToggleMute={() => toggleMute(channel)} myAvailable={myAvailable} onDispatch={dispatchCrew} channel={channel} dmName={dmName} org={org} uid={uid} isAdmin={isAdmin} policy={policy} members={members} crews={crews} chMembers={chMembers} people={chPeople} chCrews={chCrews} ent={ent} onInvite={isAdmin ? orgInvite : null} onInviteHere={(role) => setInviteFor({ channelIds: [channel.id], role })} askAdmin={askAdmin} onCrew={(id) => { setChSheet(false); setSheet(id); }} onDm={(id) => openDm('user', id)} onWiden={widenDm} isPersonal={isPersonal} needConsent={isPersonal ? needPersonalConsent : null} refreshKey={`${membersEpoch}:${sheetReqTick}`} nameOfUser={nameOfUser} initialAdd={chSheetAdd} onMention={(c) => { setChSheet(false); setChSheetAdd(null); setMentionReq(c); }} onClose={() => { setChSheet(false); setChSheetAdd(null); }} onChanged={async () => { await (isPersonal ? loadPersonal() : loadOrg(orgId)).catch(() => {}); await loadChMembers(chId).catch(() => {}); }} onArchived={() => { setChSheet(false); setChId(null); loadOrg(orgId).catch(() => {}); }} onNote={setNote} onError={setErr} />}
        {inviteFor && org && !isPersonal && <InviteDialog org={org} channels={inviteChannels} isAdmin={!!isAdmin} hostOf={hostChannels} initialChannelIds={inviteFor.channelIds} initialRole={inviteFor.role} create={createInviteCode} loadCurrent={isAdmin ? currentMemberLink : null} confirmReplace={confirmReplace} discard={async (id) => { inviteSync.current.start(); let gone = 0; try { const r = await discardInvite(supabase, id); gone = r ? -1 : 0; return r; } finally { inviteSync.current.finish(gone); } }} shareText={inviteShare} linkOf={inviteLinkOf} errorText={inviteErr} onClose={() => setInviteFor(null)} onManage={isAdmin ? manageInvites : null} t={t} phone={isPhone} />}
        {joinPreview && <InvitePreview p={joinPreview} avatar={<Av name={joinPreview.org_name} size="lg" />} busy={joinBusy} err={joinErr} onJoin={joinFromPreview} onOpen={() => { const p = joinPreview; setJoinPreview(null); if (p.org_id) setOrgId(p.org_id); if (p.channels?.[0]) requestNav(p.channels[0].id, 'invite'); }} onClose={() => setJoinPreview(null)} fmtWhen={(iso) => fmtWhen(iso, lang)} t={t} phone={isPhone} />}
        {orgLocked && <div className="msgr-notice locked"><span>{t(isAdmin ? 'org.locked.admin' : 'org.locked')}</span></div>}
        {pushCard && createPortal(<button type="button" className="msgr-pushcard" onClick={() => { if (pushCard.channel_id) requestNav(pushCard.channel_id, 'card'); setPushCard(null); }}><span className="t">{pushCard.title}</span><span className="b">{pushCard.body}</span></button>, document.body)}
        {(err || note) && createPortal( /* 토스트 — 상단 바는 레이아웃을 밀었다(유건 2026-09-09). 자동 소멸(안내 4초·오류 8초), 클릭하면 즉시 */
          <button type="button" ref={toastRef} className={`msgr-toast${err ? ' err' : ''}`} onClick={tapToast} role="status" aria-live="polite">{err ? (/msgr_session_refreshing/.test(err) || err === t('err.sessionRefreshing') ? t('err.sessionRefreshing') : `${t('ui.error')}: ${toastError(err, { t, phone: isPhone })}`) : note}</button>,
          document.body,
        )}
        <PageBoundary key={`${page}:${chId ?? ''}`} title={t('ui.pageError')} retry={t('ui.pageError.retry')} onReset={() => setPage('chat')}>
        {aiConsentLoading && page !== 'settings' ? ( // 3차 검수 L-3(2026-09-27) — 동의 여부를 아직 모르는 동안엔 조직 화면(채널 등) 대신 로딩 표시. 실패 시엔 fail-open이라 여기로 안 온다
          <OrgGateLoading t={t} onMenu={openNav} />
        ) : orgGateActive && page !== 'settings' ? ( // App Store 5.1.2 재설계 — 조직 공간 진입 전 필수 동의(설정은 예외 — 거기서도 동의할 수 있어야 한다)
          <AiConsentGate t={t} onMenu={openNav} onError={setErr} onDecline={() => setOrgId(PERSONAL)} />
        ) : personalConsentAsk && isPersonal && page !== 'settings' ? ( // 개인 공간은 에이전트를 부르려는 순간에만 묻는다 — 거부하면 사람끼리 대화는 그대로
          <AiConsentGate t={t} onMenu={openNav} onError={setErr} onDecline={() => setPersonalConsentAsk(false)} personal />
        ) : page === 'activity' && isPersonal ? (
          <><div className="msgr-top"><NavButton onMenu={openNav} /><span className="title">{t('personal')}</span></div><div className="msgr-thread" style={{ display: 'flex' }}><div className="msgr-empty"><p>{t('personal.noActivity')}</p></div></div></>
        ) : isPhone && page === 'approvals' ? (
          <PhoneApprovals items={approvalItems} uid={uid} orgs={orgs} crewName={(it) => myAgents?.find((c) => c.id === it.crew_id)?.display_name ?? crewOf(it.crew_id)?.display_name ?? it.crewName ?? null} spaceName={spaceName} onBack={backFromPage} onMenu={openNav} onOpen={openApproval} onDecided={() => { approvalsSoon.current(); }} onNote={setNote} onError={setErr} />
        ) : isPhone && page === 'memdoc' && memDoc ? (
          <PhoneMemDoc doc={memDoc.doc} label={memDoc.label} nameOfUser={nameOfUser} onBack={backFromPage} onMenu={openNav} />
        ) : page === 'activity' && org ? (
          <Activity org={org} uid={uid} isAdmin={!!isAdmin} channels={channels} previewChannels={previewChannels} members={members} crews={crews} nameOfUser={nameOfUser} dmName={dmName} onNote={setNote} onError={setErr} onBack={backFromPage} onMenu={openNav} onOpenChannel={(id) => { setChId(id); setPage('chat'); }} />
        ) : page === 'search' && org ? (
          <SearchPage res={searchRes} busy={searchBusy} channels={[...channels, ...previewChannels]} members={members} crews={crews} nameOfUser={nameOfUser} dmName={dmName} onOpen={(id, mid) => { setChId(id); setPage('chat'); setJump(mid ? { ch: id, mid } : null); }} onCrew={openers.search} onDm={(id) => openDm('user', id)} onBack={backFromPage} onMenu={openNav} phoneQ={isPhone ? { q: searchQ, set: setSearchQ, run: runSearch } : null} />
        ) : page === 'inbox' && org ? (
          <Inbox items={inbox} prevSeen={inboxPrev} initialKind={inboxKind} onReadAll={() => { const now = Date.now(); setInboxPrev(now); const next = { ...inboxSeen, [org.id]: now }; setInboxSeen(next); writeInboxSeen(next); const dmIds = new Set(channels.filter((c) => c.kind === 'dm').map((c) => c.id)); const top = new Map(); for (const it of inbox) { const mid = Number(it.key.split(':')[1]); if (it.channel_id && dmIds.has(it.channel_id) && it.kind !== 'approval' && it.kind !== 'friend' && Number.isInteger(mid) && mid > (top.get(it.channel_id) ?? 0)) top.set(it.channel_id, mid); } for (const [cid, mid] of top) markRead(cid, mid); resyncBadge(); }} channels={channels} crews={crews} nameOfUser={nameOfUser} dmName={dmName} onOpen={(id, it) => { if (!id) { if (it?.kind === 'system') { if (isAdmin) { setPage('settings'); setSettingsTab('org'); } return; } setPage('settings'); setSettingsTab('friends'); return; } if (!it?.joinReq && openAgentDmInstead(id, 'inbox')) return; if (it?.joinReq) { if (id === chId) { setChSheet(true); setSheetReqTick((x) => x + 1); } else sheetAfterNav.current = true; } setChId(id); setPage('chat'); }} onBack={backFromPage} onMenu={openNav} />
        ) : page === 'settings' || page === 'orgsettings' || (isPhone && page.startsWith('set-')) ? (
          <Settings phoneView={isPhone ? (page === 'settings' ? 'list' : page === 'orgsettings' ? 'orgadmin' : page.slice(4)) : null} onSub={(k) => setPage(`set-${k}`)} crews={crews} myName={profileName} myAgents={myAgents} onOpenAgent={(g) => openAgentCard(rowForSpace(g, orgId, PERSONAL))} onOrgSub={openOrgSub} onPickOrg={pickSettingsOrg} onOrgAdmin={() => setPage('orgsettings')} onToggleMemory={toggleMemory} spaceReady={loadedOrg.current === orgId} memSort={memSort} onMemSort={pickMemSort} focusGroup={settingsFocus} onFocusUsed={() => setSettingsFocus(null)} chOrgId={chOrg} session={session} me={me} uid={uid} onAvatar={() => { avatarAsked.current.delete(uid); loadAvatars(); }} onProfileSaved={() => { askName(uid, true); setProfileTick((x) => x + 1); }} invitesTick={invitesTick} org={isPersonal ? null : org} orgs={orgs} isAdmin={!!isAdmin} gated={orgBlocked} policy={policy} ent={isPersonal ? null : ent} members={isPersonal ? [] : members} nameOfUser={nameOfUser} onOpenCrew={setSheet} friends={friends} onFriendsChanged={onFriendsChanged} onDm={(id) => openDm('user', id)} onPersonalDm={openPersonalDm} channels={inviteChannels} onInvite={isAdmin && !isPersonal ? orgInvite : null} initialTab={settingsTab} onTabUsed={() => setSettingsTab(null)} onChanged={() => (isPersonal ? loadPersonal() : loadOrg(orgId)).catch((e) => setErr(e.message))} onOrgsChanged={() => loadOrgs().catch((e) => setErr(e.message))} onNote={setNote} onError={setErr} onBack={backFromPage} onMenu={openNav} />
        ) : dmDraft && isPersonal && page === 'chat' ? (
          <DmDraft key={dmDraft.userId} userId={dmDraft.userId} name={nameOfUser(dmDraft.userId)} initialText={dmDraft.text} onSend={(body) => sendFirstDm(dmDraft.userId, body)} onMenu={openNav} />
        ) : isPhone && page !== 'chat' ? null /* 폰 목록·설정 뒤에 숨은 대화방을 그리지 않는다 — 공간을 바꿀 때마다 보이지 않는 방의 글·첨부·반응을 읽던 것(기능 점검 D3) */ : channel ? (
          <Channel key={chId} movedBar={legacyDm?.known ? <LegacyDmBar key={legacyDm.crew.id} onGo={() => dmWithCrew(legacyDm.crew.id)} t={t} /> : earlierCrew ? <EarlierDmBar key={earlierCrew} find={() => findEarlier(earlierCrew)} ready={!!ownCrews} orgs={orgs} onOpen={openEarlier} t={t} /> : null} onCrewJoined={bumpMembers} onCrewFailed={noteCrewFailed} onPersonalChanged={async () => { await loadPersonal().catch(() => {}); await loadChMembers(chId).catch(() => {}); }} onScreen={channelOnScreen({ isPhone, page })} namePrompt={org && !isPersonal && me && !orgLocked ? <NamePrompt key={orgId} org={org} me={me} email={session.user.email} onChanged={() => loadOrg(orgId).catch(() => {})} onNote={setNote} onError={setErr} /> : null} onOutsideDm={dmWithCrew} outsideDmPersonal={dmGoesPersonal} startCard={org && !isPersonal && org.role !== 'guest' && channel.kind !== 'dm' ? <OnboardCard key={orgId} orgId={orgId} t={t} steps={orgSteps({ t, ...onboard, hasChannel: true, invite: isAdmin ? orgInvite : null })} /> : null} jumpTo={jump?.ch === chId ? jump.mid : null} jumpStart={!!jump?.start} onJumped={() => setJump(null)} channel={channel} preview={!!previewing} onJoin={() => joinChannel(channel)} orgId={orgId} org={org} uid={uid} isAdmin={!!isAdmin} locked={orgLocked} policy={policy} members={members} crews={crews} people={chPeople} mentionPeople={mentionPeople} chCrews={chCrews} nameOfUser={nameOfUser} crewOf={crewOf} event={event} typing={typing} typingStart={typingStartRef.current} progress={progress} received={received} onRead={markRead} muted={muted.has(channel.id)} onToggleMute={() => toggleMute(channel)} onToggleMemory={() => toggleMemory(channel)} broadcast={(ev, payload) => (roomTopic ? roomSubs.current.get(chId) : rt.current)?.send({ type: 'broadcast', event: ev, payload }).catch?.(() => {})} onError={setErr} onNote={setNote} onMenu={openNav} onCrew={openers.channel} onTitle={() => setChSheet(true)} onCrewAdd={() => { setChSheetAdd('crew'); setChSheet(true); }} mentionReq={mentionReq} onMentionDone={() => setMentionReq(null)} dmName={dmName} channels={channels} onOpenRelay={openRelay} isPersonal={isPersonal} crewPosts={crewPosts} seenAt={seenMine} onCrewPosted={(crewId) => settleCrew({ channel_id: chId, crew_id: crewId })} />
        ) : isPersonal ? (
          <><div className="msgr-top"><NavButton onMenu={openNav} /><span className="title">{t('personal')}</span><span className="topic">{t('personal.space')}</span></div><div className="msgr-thread" style={{ display: 'flex' }}><div className="msgr-empty"><p>{t('personal.empty')}</p><button type="button" className="btn btn-primary sm" onClick={() => setFriendAdd(true)}><I name="plus" size={13} />{t('friends.add')}</button></div></div></>
        ) : (
          <EmptyOrg org={org} onMenu={openNav} createOrg={() => { setOrgMenu(true); setNewOrg(''); }} createChannel={chOffer.can ? openNewCh : null} newWhy={chOffer.why} invite={isAdmin ? orgInvite : null} askAdmin={askAdmin} browse={previewChannels.length ? () => { setRail(true); openBrowse(); } : null} joinable={joinable} joinDomain={joinDomain} deletedOrgs={deletedOrgs} restoreOrg={restoreOrg} joinWithCode={joinWithCode} onboard={onboard} />
        )}
        </PageBoundary>
      </main>
      {runnerOpen && <RunnerSheet hasOrg={(orgs ?? []).length > 0} onClose={() => setRunnerOpen(false)} onAgents={runnerAgents} onNote={setNote} onError={setErr} />}
      {friendAdd && <FriendAddSheet onClose={() => setFriendAdd(false)} uid={uid} friends={friends} members={isPersonal ? [] : members} onChanged={onFriendsChanged}
        onDm={(id) => { setFriendAdd(false); openDm('user', id); }} onPersonalDm={(id) => { setFriendAdd(false); openPersonalDm(id); setRail(false); }} onNote={setNote} onError={setErr} />}
      {dmGroup && <DmGroupSheet personal={isPersonal} onAddFriend={() => { setDmGroup(false); setFriendAdd(true); }} members={withoutHidden(members.filter((m) => m.user_id !== uid && (!m.expires_at || Date.parse(m.expires_at) > Date.now())), isPersonal ? hiddenUserIds : null)} crews={railVisible} hints={crewHints} uid={uid} nameOfUser={nameOfUser} onCreate={createGroupDm} onClose={() => setDmGroup(false)} />}
      {grpSheet && isPhone && !isPersonal && <ChannelGroupSheet {...grpSheet} groups={sortGroups(grp.groups)} links={grp.links} channels={chChannels} onCreate={createGroup} onSave={saveGroup} onDelete={deleteGroup} onMove={moveChannel} onPicked={(k) => setChMenu(k)} onClose={() => setGrpSheet(null)} />}
      {isPhone && <PhoneTabs active={rootTab} badges={tabBadgeN} onPick={pickRoot} />}
    </div>
    </RunnerCtx.Provider></SafetyCtx.Provider></AvatarCtx.Provider>
  );
}

/* ─── 크루 시트: 소유자·실행 위치·접속 + 누가 시킬 수 있나(소유자만 편집, RLS msgr_crews_update_owner) + 허용 요청 ─── */
/* ─── DM 미리보기 시트(유건 2026-09-15): 길게 눌러 마지막 12개 글을 읽기 전용으로. 열기 = 대화로. ─── */
function DmPeekSheet({ channel, name, uid, whoOf, onOpen, onClose }) {
  const { t, lang } = useT();
  const { blocked } = useContext(SafetyCtx);
  const [rows, setRows] = useState(null);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  useEffect(() => { let live = true; supabase.from('msgr_messages').select('id, body, author_kind, author_user_id, crew_id, created_at').eq('channel_id', channel.id).is('deleted_at', null).order('id', { ascending: false }).limit(12)
    .then(({ data }) => { if (live) setRows((data ?? []).reverse()); }); return () => { live = false; }; }, [channel.id]);
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <section className="msgr-crewsheet msgr-dmpeek" role="dialog" aria-label={t('dm.preview')}>
        <header className="head"><strong>{name}</strong><button type="button" className="btn sm" onClick={onOpen}>{t('dm.preview.open')}</button><button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek">
          {rows === null ? <p className="note">{t('ui.loading')}</p> : !rows.length ? <p className="note">{t('dm.preview.empty')}</p> : rows.map((m) => (
            <div key={m.id} className={`pk${m.author_user_id === uid ? ' me' : ''}`}><span className="who">{whoOf(m)}</span><span className="body">{m.author_kind === 'user' && m.author_user_id !== uid && blocked.has(m.author_user_id) ? t('msg.blockedUser') : m.body}</span><span className="when">{fmtDmWhen(t('time.yesterday'), Date.parse(m.created_at), lang)}</span></div>
          ))}
        </div>
      </section>
    </div>
  );
}
/* ─── 새 그룹 대화 시트(유건 2026-09-15): 조직 멤버·파견 크루를 여럿 골라 그룹 DM. 한 명이면 1:1. ─── */
function DmGroupSheet({ members, crews, uid, nameOfUser, onCreate, onClose, personal = false, onAddFriend, hints = null }) {
  const { t } = useT();
  const [picks, setPicks] = useState(() => new Map()); const [busy, setBusy] = useState(false); const [qs, setQs] = useState('');
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const key = (kind, id) => `${kind}:${id}`;
  const toggle = (kind, id) => setPicks((m) => { const n = new Map(m); const k = key(kind, id); if (n.has(k)) n.delete(k); else n.set(k, { kind, id }); return n; });
  const needle = qs.trim().toLowerCase();
  const rows = [...members.map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8) })), ...crews.filter((c) => c.status === 'active' && crewAddable(c)).map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, crew: true, own: c.owner_user_id === uid, owner: c.owner_user_id }))]
    .filter((r) => !needle || r.name.toLowerCase().includes(needle));
  // 남의 크루를 고르면 그 소유자가 함께 들어온다(소유자 동반 규칙) — 고른 수와 실제 들어오는 사람이 다르므로 알린다(검수 M-4)
  const joiners = [...new Set([...picks.values()].filter((p) => p.kind === 'crew').map((p) => crews.find((c) => c.id === p.id)?.owner_user_id).filter((o) => o && o !== uid && !picks.has(`user:${o}`)))];
  const submit = async () => { setBusy(true); try { await onCreate([...picks.values()]); } finally { setBusy(false); } };
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <section className="msgr-crewsheet msgr-dmpeek msgr-dmgroup" role="dialog" aria-label={t('dm.group.new')}>
        <header className="head"><strong>{t('dm.group.new')}</strong><span className="msgr-klabel">{picks.size ? t('dm.group.count', { n: picks.size }) : t(personal ? 'dm.group.pick.personal' : 'dm.group.pick')}</span><button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek">
          <input className="msgr-input sm" placeholder={t('dm.group.search')} value={qs} onChange={(e) => setQs(e.target.value)} />
          {rows.map((r) => (<label key={key(r.kind, r.id)} className="msgr-check pickrow"><input type="checkbox" checked={picks.has(key(r.kind, r.id))} onChange={() => toggle(r.kind, r.id)} /><Av name={r.name} size="xs" crew={r.crew} crewId={r.crew ? r.id : null} userId={r.crew ? null : r.id} /><span className="name">{r.name}{r.crew && hints?.get(r.id) && <small className="msgr-namehint">{hints.get(r.id)}</small>}</span>{r.crew && <span className="msgr-klabel">{r.own ? t('dm.group.myCrew') : `${t('dm.group.crew')} · ${nameOfUser(r.owner)}`}</span>}</label>))}
          {!rows.length && <p className="note">{t(personal ? 'dm.group.none.personal' : 'dm.group.none')}{personal && onAddFriend && <> <button type="button" className="btn sm" onClick={onAddFriend}><I name="plus" size={12} />{t('friends.add')}</button></>}</p>}{/* 개인 공간 친구 0명이면 막다른 길이었다(검수 MEDIUM-3) */}
        </div>
        <footer className="foot">{joiners.length > 0 && <p className="note">{t('dm.group.joiners', { names: joiners.map(nameOfUser).join(', ') })}</p>}<button type="button" className="btn btn-primary" disabled={busy || picks.size === 0} onClick={submit}>{picks.size >= 2 ? t('dm.group.create') : t('ui.dm')}</button></footer>
      </section>
    </div>
  );
}
/* 채널 탭 메뉴 칩 — 누르면 고르고, 길게 누르면(터치) 또는 오른쪽 클릭하면 onHold(그룹 편집 시트). 길게 누른 뒤 손을 뗄 때 오는 클릭은 고르기로 치지 않는다 */
function HoldChip({ on, label, onPick, onHold }) {
  const held = useRef(0); const fired = useRef(false);
  const lp = useLongPress(() => { held.current = Date.now(); fired.current = true; onHold?.(); });
  // 길게 눌러 시트가 뜬 뒤 손을 떼면 그 클릭이 시트 뒤 배경에 떨어져 시트를 바로 닫았다(2026-10-02 실측) — 행 길게 누르기(rowLongPress)와 같이 pointerup 직후 300ms 안 클릭 한 번을 삼킨다
  const swallowNext = () => { if (!fired.current) return; fired.current = false; const swallow = (e) => { e.preventDefault(); e.stopPropagation(); }; document.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 300); };
  const hold = onHold ? { ...lp, onPointerDown: (e) => { fired.current = false; lp.onPointerDown(e); }, onPointerUp: (e) => { lp.onPointerUp(e); swallowNext(); } } : {};
  return <button type="button" role="radio" aria-checked={on} className={on ? 'active' : ''} {...hold}
    onContextMenu={onHold ? (e) => { e.preventDefault(); if (Date.now() - held.current > 800) { held.current = Date.now(); onHold(); } } : undefined}
    onClick={() => { if (Date.now() - held.current < 800) return; onPick(); }}>{label}</button>;
}
/* 채널 그룹 시트(유건 확정 2026-10-02 — 나만 보이는 그룹, 채널 하나는 그룹 하나에만)
   new: 이름 + 넣을 채널 → 만들기 / edit: 이름 바꾸기 + 채널 넣고 빼기 + 지우기(채널은 '채널'로 돌아간다) / pick: 채널 줄 '그룹에 넣기' — 그룹 고르기·빼기·새 그룹 만들어 넣기 */
function ChannelGroupSheet({ mode, id = null, channelId = null, groups, links, channels, onCreate, onSave, onDelete, onMove, onPicked, onClose }) {
  const { t } = useT();
  const group = mode === 'edit' ? groups.find((g) => g.id === id) : null;
  const [name, setName] = useState(group?.name ?? '');
  const [checked, setChecked] = useState(() => new Set(group ? links.filter((l) => l.group_id === group.id).map((l) => l.channel_id) : []));
  const [busy, setBusy] = useState(false); const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  useEffect(() => { if (mode === 'edit' && !group) onClose(); }, [mode, group, onClose]); // 다른 기기에서 지운 그룹
  const clean = cleanGroupName(name); const taken = !!clean && groupNameTaken(groups, clean, group?.id ?? null);
  const run = async (fn) => { setBusy(true); try { return await fn(); } finally { setBusy(false); } };
  if (mode === 'edit' && !group) return null;
  if (mode === 'pick') {
    const c = channels.find((x) => x.id === channelId); const cur = groupOfChannel(links, groups, channelId)?.id ?? null;
    const pick = (gid) => run(async () => { await onMove(channelId, gid); onClose(); });
    return (
      <div className="msgr-sheetwrap">
        <div className="msgr-scrim clear" onClick={onClose} />
        <section className="msgr-crewsheet msgr-dmpeek msgr-dmgroup ph-grpsheet" role="dialog" aria-label={t('grp.pick')}>
          <header className="head"><strong>{t('grp.pick')}</strong>{c && <span className="msgr-klabel"># {c.name}</span>}<button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
          <div className="peek" role="radiogroup" aria-label={t('grp.pick')}>
            {[{ id: null, name: t('grp.pick.none') }, ...groups].map((g) => (
              <button key={g.id ?? 'none'} type="button" role="radio" aria-checked={cur === g.id} className={`ph-grprow${cur === g.id ? ' on' : ''}`} disabled={busy} onClick={() => pick(g.id)}>
                <I name={g.id ? 'folder' : 'hash'} size={16} /><span className="name">{g.name}</span>{cur === g.id && <I name="check" size={16} className="ok" />}
              </button>))}
            <form className="ph-grpnew" onSubmit={(e) => { e.preventDefault(); if (!clean || taken) return; run(async () => { const row = await onCreate(clean, [channelId]); if (row) onClose(); }); }}>
              <input className="msgr-input" placeholder={t('grp.name')} aria-label={t('grp.pick.new')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <button type="submit" className="btn btn-primary sm" disabled={busy || !clean || taken}><I name="plus" size={13} />{t('grp.pick.new')}</button>
            </form>
            {taken && <p className="msgr-inline-err" role="alert">{t('grp.name.taken')}</p>}
          </div>
        </section>
      </div>
    );
  }
  const toggle = (cid) => setChecked((st) => { const n = new Set(st); if (n.has(cid)) n.delete(cid); else n.add(cid); return n; });
  const submit = () => run(async () => {
    if (mode === 'new') { const row = await onCreate(clean, [...checked]); if (row) { onPicked(`g:${row.id}`); onClose(); } return; }
    if (await onSave(group, clean, [...checked])) onClose();
  });
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <section className="msgr-crewsheet msgr-dmpeek msgr-dmgroup ph-grpsheet" role="dialog" aria-label={t(mode === 'new' ? 'grp.new' : 'grp.edit')}>
        <header className="head"><strong>{t(mode === 'new' ? 'grp.new' : 'grp.edit')}</strong><button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek">
          <input className="msgr-input" placeholder={t('grp.name')} aria-label={t('grp.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus={mode === 'new' && !('ontouchstart' in window)} />
          {taken && <p className="msgr-inline-err" role="alert">{t('grp.name.taken')}</p>}
          <h3 className="ph-grph">{t('grp.channels')}</h3>
          {channels.map((c) => { const other = groupOfChannel(links, groups, c.id); const inOther = other && other.id !== group?.id; return (
            <label key={c.id} className="msgr-check pickrow"><input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} /><I name={c.kind === 'private' ? 'lock' : 'hash'} size={14} /><span className="name">{c.name}</span>{inOther && <span className="msgr-klabel">{t('grp.in', { name: other.name })}</span>}</label>); })}
        </div>
        <footer className="foot">
          {mode === 'edit' && (confirmDel
            ? <><p className="note">{t('grp.delete.note')}</p><button type="button" className="btn btn-primary danger" disabled={busy} onClick={() => run(async () => { if (await onDelete(group)) onClose(); })}><I name="trash" size={14} />{t('grp.delete.confirm')}</button><button type="button" className="btn" onClick={() => setConfirmDel(false)}>{t('ui.cancel')}</button></>
            : <button type="button" className="btn ph-grpdel" disabled={busy} onClick={() => setConfirmDel(true)}><I name="trash" size={14} />{t('grp.delete')}</button>)}
          {!confirmDel && <button type="button" className="btn btn-primary" disabled={busy || !clean || taken} onClick={submit}>{t(mode === 'new' ? 'grp.create' : 'grp.save')}</button>}
        </footer>
      </section>
    </div>
  );
}
function CrewSheet({ crew, org, uid, me, members, policy, channelId, channelName = null, nameOfUser, onClose, onChanged, onPosted, onNote, onError, onDm, dmPersonal = false, saveLook = null }) {
  const { t, lang } = useT();
  const owner = crew.owner_user_id === uid;
  const tier = crewTier(crew, org); // H-3: 회사 크루 / 개인(파견) 크루 — 판정 정본은 서버 msgr_crew_tier
  const locked = !!policy?.allow_locked; // H-0: 조직 정책이 잠그면 소유자도 못 바꾼다(서버 트리거 msgr_crew_policy_gate가 최종)
  const [allow, setAllow] = useState(crew.allow); const [list, setList] = useState(crew.allow_users ?? []); const [busy, setBusy] = useState(false);
  useEffect(() => { setAllow(crew.allow); setList(crew.allow_users ?? []); }, [crew.id, crew.allow, crew.allow_users]);
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  const avail = crewAvailability(crew, { awayMs: AWAY_MS }); // 파견 여부와 접속 여부를 합친 한 줄 상태 — 지금 대화할 수 있는지(crew-status.mjs)
  const canMe = owner || crew.allow === 'all' || (crew.allow === 'list' && (crew.allow_users ?? []).includes(uid));
  // 파견·해제는 메신저에서(유건 지시 2026-09-08). 서버는 status만 본다: available = 지시·답글·채널 멤버 불가(20260907120000 게이트), active = 파견 중.
  const dispatched = crew.status !== 'available'; const [confirmRecall, setConfirmRecall] = useState(false);
  const setDispatch = async (next) => {
    setBusy(true); setConfirmRecall(false);
    const res = await supabase.from('msgr_crews').update({ status: next ? 'active' : 'available' }).eq('id', crew.id).select('id'); // 다시 파견은 복귀 — 허용 범위 유지(D31, dispatchCrew 주석)
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('crew.allow.readonly', { name: nameOfUser(crew.owner_user_id) }));
    onNote(t(next ? 'crew.dispatch.done' : 'crew.recall.done', { name: crew.display_name })); onChanged();
  };
  const [confirmOut, setConfirmOut] = useState(false);
  const leaveHere = async () => { // 규칙 14: 데려온 것이 동의라면 빼는 것은 동의 철회 — 주인은 방장 동의 없이 이 방에서만 뺄 수 있다
    setBusy(true); setConfirmOut(false);
    const { data, error } = await supabase.rpc('msgr_crew_leave_channel', { ch: channelId, crew: crew.id });
    setBusy(false);
    if (error) return onError(missingSchema(error) ? t('crew.leaveHere.upgrade') : friendlyErr(error.message, t));
    if (data === 'owner_only') return onError(t('err.crewRemoveOwnerOnly')); // 남의 에이전트 — 서버가 아무것도 하지 않았다(20261002120000)
    onNote(t(data === 'removed' ? 'crew.leaveHere.done' : 'crew.leaveHere.absent', { name: crew.display_name, channel: channelName })); onChanged();
  };
  const save = async (nextAllow, nextList) => {
    setBusy(true);
    const res = await supabase.from('msgr_crews').update({ allow: nextAllow, allow_users: nextAllow === 'list' ? nextList : [] }).eq('id', crew.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_policy_locked/.test(res.error.message) ? t('err.policyLocked') : res.error.message);
    if (!res.data?.length) return onError(t('crew.allow.readonly', { name: nameOfUser(crew.owner_user_id) })); // RLS 0행
    onNote(t('crew.allow.saved')); onChanged();
  };
  const pickAllow = (v) => { setAllow(v); if (v !== 'list') save(v, []); };
  const toggle = (id) => { const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]; setList(next); save('list', next); };
  const request = async () => {
    if (!channelId) return;
    const ownerName = nameOfUser(crew.owner_user_id); const meName = me?.display_name || uid.slice(0, 8);
    const body = t('crew.request.body', { owner: ownerName, me: meName, crew: crew.display_name });
    const { error } = await supabase.from('msgr_messages').insert({ channel_id: channelId, author_kind: 'user', author_user_id: uid, body, mentions: [{ kind: 'user', id: crew.owner_user_id }], client_msg_id: crypto.randomUUID() });
    if (error) return onError(error.message);
    onNote(t('crew.request.sent')); onPosted?.(); onClose();
  };
  const others = members.filter((m) => m.user_id !== crew.owner_user_id);
  // 얼굴·사진은 같은 에이전트의 내 행 전부에(유건 2026-10-05, Shell saveLook) — 받지 못했으면(다른 부모) 이 행만(종전)
  const writeLook = (patch) => (saveLook ? saveLook(crew.id, patch) : supabase.from('msgr_crews').update(patch).eq('id', crew.id).select('id'));
  const lookNote = (r) => (r.onlyHere ? 'crew.look.onlyHere' : 'crew.profile.saved'); // 여러 행 저장이 거절돼 대표가 아닌 이 행만 저장했으면 — 화면 얼굴은 대표 기준이라 안 바뀐다(분리 검수 2026-10-05 #6)
  const lookPhoto = agentLook(crew.id, useContext(AvatarCtx).looks, crew.face, crew.avatar_url ?? null).photo ?? null; // 목록·대화와 같은 사진(그 행 → 대표 행)
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <aside className="msgr-crewsheet" role="dialog" aria-label={t('crew.sheet')}>
        <div className="head">
          <Av name={crew.display_name} crew size="lg" company={tier === 'company'} crewId={crew.id} />
          <div style={{ minWidth: 0 }}><div className="name">{crew.display_name}</div><div className="msgr-klabel">{crew.role_text}</div>{crew.bio && <p className="bio">{crew.bio}</p>}</div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={15} /></button>
        </div>
        <div className="facts">
          <div><span className="msgr-klabel">{t('crew.tier')}</span><span className={`msgr-tier ${tier}`}>{tier === 'company' ? t('crew.tier.company') : t('crew.tier.personal')}</span></div>
          <div><span className="msgr-klabel">{t('crew.owner')}</span><span><Av name={nameOfUser(crew.owner_user_id)} size="sm" userId={crew.owner_user_id} /> {tier === 'company' && crew.hosting !== 'bot' ? t('crew.tier.company.owner', { org: org?.name ?? '' }) : nameOfUser(crew.owner_user_id)}</span></div>
          <div><span className="msgr-klabel">{t('tab.crew')}</span><span>{t(`crew.hosting.${crew.hosting === 'resident' ? 'resident' : crew.hosting === 'bot' ? 'bot' : 'local'}`)}</span></div>
          <div className="state"><span className="msgr-klabel">{t('crew.state.label')}</span><span><span className={`msgr-dot${avail.ready ? ' ok' : ''}`} /> <span className="state-text">{avail.state === 'away' && !avail.lastSeen ? t('crew.state.away.never') : t(`crew.state.${avail.state}`, { when: avail.lastSeen ? fmtTs(avail.lastSeen, lang) : '' })}</span>
            {owner && crew.hosting !== 'bot' && !confirmRecall && (dispatched
              ? <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => setConfirmRecall(true)}>{t('crew.recall')}</button>
              : <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => setDispatch(true)}>{t('crew.dispatch')}</button>)}
          </span></div>
          {owner && channelId && channelName && !confirmOut && <div><span className="msgr-klabel">{t('crew.leaveHere.label')}</span><span><button type="button" className="btn sm ghost text" disabled={busy} onClick={() => setConfirmOut(true)}>{t('crew.leaveHere', { channel: channelName })}</button></span></div>}
          {confirmOut && <div className="confirm-row"><span className="confirm-inline"><span>{t('crew.leaveHere.confirm', { channel: channelName })}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={leaveHere}>{t('crew.leaveHere', { channel: channelName })}</button><button type="button" className="btn sm" onClick={() => setConfirmOut(false)}>{t('ui.cancel')}</button></span></div>}
          {confirmRecall && <div className="confirm-row"><span className="confirm-inline"><span>{t('crew.recall.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => setDispatch(false)}>{t('crew.recall')}</button><button type="button" className="btn sm ghost text" onClick={() => setConfirmRecall(false)}>{t('ui.cancel')}</button></span></div>}
        </div>
        <p className="note tier">{tier === 'company' ? t('crew.tier.company.note', { org: org?.name ?? '' }) : t('crew.tier.personal.note', { name: nameOfUser(crew.owner_user_id) })}</p>
        {owner && (<section className="msgr-crewprofile">
          <h3>{t('crew.profile')}</h3>
          <AvatarEdit name={crew.display_name} crew crewId={crew.id} url={lookPhoto} busy={busy} t={t} onUpload={async (f) => { try { setBusy(true); const url = await uploadAvatar(uid, `crew-${crew.id}`, f); const r = await writeLook({ avatar_url: url }); setBusy(false); if (r.error) return onError(r.error.message); onNote(t(lookNote(r))); onChanged(); } catch (e) { setBusy(false); onError(e.message); } }} onRemove={async () => { const r = await writeLook({ avatar_url: null }); if (r.error) return onError(r.error.message); onNote(t(lookNote(r))); onChanged(); }} />
          <label className="msgr-klabel">{t('crew.face')}</label>
          <FacePicker crew={crew} busy={busy} t={t} onSave={async (face) => { setBusy(true); const r = await writeLook({ face }); setBusy(false); if (r.error) return onError(r.error.message); onNote(t(lookNote(r))); onChanged(); }} />
          <label className="msgr-klabel" htmlFor={`role-${crew.id}`}>{t('crew.role')}</label>
          <input id={`role-${crew.id}`} className="msgr-input" maxLength={60} defaultValue={crew.role_text ?? ''} placeholder={t('crew.role.ph')} onBlur={async (e) => { const v = e.target.value.trim() || null; if (v === (crew.role_text ?? null)) return; const r = crew.hosting === 'bot' ? await supabase.rpc('msgr_bot_set_role', { bot_crew: crew.id, new_role_text: v }) : await supabase.from('msgr_crews').update({ role_text: v }).eq('id', crew.id).select('id'); if (r.error) return onError(r.error.message); onNote(t('crew.profile.saved')); onChanged(); }} />
          <label className="msgr-klabel" htmlFor={`bio-${crew.id}`}>{t('crew.bio')}</label>
          <textarea id={`bio-${crew.id}`} className="msgr-input" rows={2} maxLength={300} defaultValue={crew.bio ?? ''} placeholder={t('crew.bio.ph')} onBlur={async (e) => { const v = e.target.value.trim() || null; if (v === (crew.bio ?? null)) return; const r = await supabase.from('msgr_crews').update({ bio: v }).eq('id', crew.id).select('id'); if (r.error) return onError(r.error.message); onNote(t('crew.profile.saved')); onChanged(); }} />
        </section>)}
        <section>
          <h3>{t('crew.allow')}</h3>
          <p>{t('crew.allow.desc')}</p>
          <Seg label={t('crew.allow')} value={allow} onPick={pickAllow} disabled={!owner || busy || locked} options={['all', 'list', 'owner'].map((v) => ({ v, label: t(`crew.allow.${v}`) }))} />
          {allow === 'list' && (
            <div className="picks">
              <span className="msgr-klabel">{t('crew.allow.pick')}</span>
              {others.map((m) => <label key={m.user_id} className={`pick${list.includes(m.user_id) ? ' on' : ''}`}><input type="checkbox" checked={list.includes(m.user_id)} disabled={!owner || busy} onChange={() => toggle(m.user_id)} /><Av name={m.display_name || m.user_id} size="sm" userId={m.user_id} /><span>{m.display_name || m.user_id.slice(0, 8)}</span><span className="msgr-klabel">{t(`role.${m.role}`)}</span></label>)}
            </div>
          )}
          {locked ? <p className="note">{t('crew.allow.locked')}</p> : !owner && <p className="note">{t('crew.allow.readonly', { name: nameOfUser(crew.owner_user_id) })}</p>}
          <div className="me">
            <span className={`msgr-dot${canMe ? ' ok' : ''}`} /><span>{canMe ? t('crew.allow.me.yes') : t('crew.allow.me.no')}</span>
            {canMe && <button type="button" className="btn btn-primary sm" onClick={onDm} title={t('dm.crewNote')}><I name="at" size={13} />{t(dmPersonal ? 'ui.dm.personal' : 'ui.dm')}</button>}
            {!owner && !canMe && <button type="button" className="btn btn-primary sm" onClick={request} disabled={!channelId}><I name="at" size={13} />{t('crew.request')}</button>}
          </div>
        </section>
      </aside>
    </div>
  );
}

/* ─── 채널 시트: 이름·주제(관리자·생성자) · 크루 기억 스위치 · 멤버(비공개·DM: 사람·크루 추가/내보내기, 크루=소유자 동반) · 보관 ─── */
function ChannelSheet({ channel, muted = false, onToggleMute, dmName = null, org, uid, isAdmin, policy, members, crews, chMembers, people = [], chCrews = [], ent, myAvailable = [], onDispatch, onInvite, onInviteHere, askAdmin = null, onCrew, onDm, onMention, onWiden, isPersonal = false, needConsent = null, refreshKey = 0, initialAdd = null, nameOfUser, onClose, onChanged, onArchived, onNote, onError }) {
  const { t } = useT();
  const chAdmins = channel.admin_user_ids ?? [];
  const canEdit = isAdmin || channel.created_by === uid || chAdmins.includes(uid); // J-1: 채널 관리자도 설정·멤버 관리(최종은 RLS msgr_can_manage_channel)
  const canAssignAdmins = (isAdmin || channel.created_by === uid) && channel.kind !== 'dm'; // 지정은 조직 관리자·생성자만(자기 증식 방지 — 서버 트리거와 동일)
  const toggleChAdmin = async (userId) => { const next = chAdmins.includes(userId) ? chAdmins.filter((x) => x !== userId) : [...chAdmins, userId]; await upd({ admin_user_ids: next }, t('ch.admin.saved')); };
  const memLocked = !!policy?.crew_memory_locked; // H-0: 서버 트리거 msgr_channel_policy_gate가 최종
  const [name, setName] = useState(channel.name); const [topic, setTopic] = useState(channel.topic ?? ''); const [busy, setBusy] = useState(false); const [add, setAdd] = useState(initialAdd); // null | 'menu' | 'user' | 'crew' | 'guest' | 'newcrew' — '+ 추가' 하나로 모은다(UX 재구성)
  const [rowMenu, setRowMenu] = useState(null); const [more, setMore] = useState(false);
  const openRowMenu = (e, key, items) => { e.stopPropagation(); if (rowMenu?.key === key) return setRowMenu(null); const r = e.currentTarget.getBoundingClientRect(); setRowMenu({ key, items, at: { x: r.right - 180, y: r.bottom + 4, returnFocus: e.currentTarget } }); }; // 시트 밖(화면 기준)에 띄운다 — 시트의 스크롤 영역 안에서는 아래가 잘렸다(유건 제보 2026-09-16) // 행 '…' 메뉴 · '채널 설정' 접힘
  useEffect(() => { setName(channel.name); setTopic(channel.topic ?? ''); }, [channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  const upd = async (patch, okMsg) => {
    setBusy(true);
    const res = await supabase.from('msgr_channels').update(patch).eq('id', channel.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_policy_locked/.test(res.error.message) ? t('err.policyLocked') : res.error.message);
    if (!res.data?.length) return onError(t('ch.noEdit'));
    if (okMsg) onNote(okMsg); await onChanged();
  };
  const saveText = () => upd({ name: name.trim() || channel.name, topic: topic.trim() || null }, t('ch.saved'));
  const addMember = async (kind, id) => {
    setBusy(true);
    const rows = [{ channel_id: channel.id, member_kind: kind, member_id: id, added_by: uid }]; // 사람만 — 에이전트는 joinCrew(서버 규칙)
    const res = await supabase.from('msgr_channel_members').upsert(rows, { onConflict: 'channel_id,member_kind,member_id' });
    setBusy(false); setAdd(null);
    if (res.error) return onError(/msgr_channel_personal_blocked/.test(res.error.message) ? t('err.channelPersonalBlocked') : res.error.message); // I-3: 서버 게이트의 거절을 정직한 문구로
    await onChanged();
  };
  // 에이전트 데려오기 — 방장이면 바로, 참여자는 채널 정책대로(바로/방장 승인), 채팅은 결재자(방을 연 사람 — 나갔으면 남은 사람 중 가장 먼저 들어온 사람)면 바로,
  // 다른 참여자는 결재자에게 요청(20260918170000). 주인 동반까지 서버가 한다(msgr_crew_join). 결재자는 서버 판정(msgr_dm_approver)을 그대로 받는다 — 한 벌.
  const [joinReqs, setJoinReqs] = useState([]);
  // 결재자 RPC가 없는 서버(20260918170000 적용 전 라이브)는 채팅에 결재가 없다 — dmApprovalState가 '결재자 모름'으로 보고 '승인 필요'를 띄우지 않는다.
  // 일시 오류여도 같은 쪽으로 물러난다: 최종 판정은 서버가 하고, 요청이 되면 addCrews가 '요청을 보냈다'로 알린다.
  const [dmSt, setDmSt] = useState(() => dmApprovalState(null, uid));
  const dmApprover = dmSt.approver;
  const loadJoinReqs = useCallback(async () => {
    if (channel.kind === 'dm') setDmSt(dmApprovalState(await supabase.rpc('msgr_dm_approver', { ch: channel.id }), uid));
    const rows = await q(supabase.from('msgr_channel_crew_requests').select('id, crew_id, requested_by, created_at').eq('channel_id', channel.id).eq('status', 'pending').order('created_at')).catch(() => []);
    setJoinReqs(rows ?? []);
  }, [channel.id, channel.kind, uid]);
  useEffect(() => { loadJoinReqs(); }, [loadJoinReqs, refreshKey]); // 열려 있는 동안에도 — 알림함에서 같은 채널을 누를 때·그 방의 넣기 요청·안내 글 방송 때(검수 M-3, 주기 재조회는 없앴다 — 기능 점검 D2)
  const joinCrew = async (id) => { // 반환 'joined' | 'requested' | 'already' — 여러 명을 한 번에 넣을 때 한 명씩 부른다(서버 판정은 에이전트마다 다르다)
    const res = await supabase.rpc('msgr_crew_join', { ch: channel.id, crew: id });
    if (res.error) throw new Error(joinErr(res.error.message, t));
    return res.data;
  };
  // 에이전트 일괄 추가(유건 2026-09-17: 칩을 하나씩 누르지 않고 목록에서 여러 명을 골라 한 번에). 파견 전인 내 에이전트는 파견까지 한다.
  const [crewPicks, setCrewPicks] = useState(() => new Set());
  const addCrews = async (rows) => {
    const picked = rows.filter((r) => crewPicks.has(r.c.id)); if (!picked.length) return;
    if (needConsent?.()) { onClose(); return; } // 개인 공간 — AI 이용 동의 전이면 동의부터(2026-09-30)
    setBusy(true); let joined = 0; const asked = []; const already = []; const fails = [];
    for (const r of picked) { // 순서대로 — 파견은 브리지 미러를 기다리고, 한 명이 실패해도 나머지는 들어간다
      try { const res = r.dispatch ? await onDispatch(r.c, channel.id) : await joinCrew(r.c.id); if (res === 'requested') asked.push(r.c.display_name); else if (res === 'already') already.push(r.c.display_name); else joined++; }
      catch (e) { fails.push(`${r.c.display_name}: ${e.message}`); }
    }
    setBusy(false); setAdd(null); setCrewPicks(new Set());
    if (joined || already.length) await onChanged(); // 이미 있던 에이전트(다른 기기에서 넣음)도 다시 읽어야 추가 후보에서 빠지고 @이름이 닿는다(검수 #826 LOW-4)
    if (asked.length) loadJoinReqs();
    // 한 알림에 모은다 — 오류와 안내를 따로 띄우면 오류가 성공 안내를 덮어 "넣었는지"를 알 수 없었다(검수 MEDIUM-2)
    const notes = [joined && t('ch.add.crew.added', { n: joined }), already.length && t('ch.crew.join.already', { name: already.join(', ') }), asked.length && t('ch.crew.join.requested', { name: asked.join(', ') })].filter(Boolean);
    if (fails.length) onError([...notes, t('ch.add.crew.failed', { list: fails.join(' · ') })].join(' '));
    else if (notes.length) onNote(notes.join(' '));
  };
  const decideJoin = async (r, ok) => {
    setBusy(true);
    const res = await supabase.rpc('msgr_crew_join_decide', { req: r.id, approve: ok });
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
    onNote(koJosa(t(ok ? 'ch.crew.join.approved' : 'ch.crew.join.rejected', { name: pendingCrewLabel({ crewId: r.crew_id, crews, requesterName: nameOfUser(r.requested_by), t }) }))); // 조사는 이름에 맞춰(영문 문장엔 바꿀 조사가 없다)
    await loadJoinReqs(); await onChanged();
  };
  // 규칙 14: 사람이 빠지면 그 사람의 에이전트도 같이 빠진다 — 서버 트리거(20260918130000 msgr_crews_follow_owner_out·_excluded)가 한다.
  // 앱이 먼저 빼는 것은 내 에이전트뿐이다(남의 에이전트 빼기는 주인만 — 20261002120000. 방장이 부르면 서버가 'owner_only'로 아무것도 안 한다).
  // 빼는 함수가 없는 서버면 'old'를 돌려 종전 차단으로 돌아간다.
  const dropCrews = async (ids) => {
    for (const id of ids) {
      const r = await supabase.rpc('msgr_crew_leave_channel', { ch: channel.id, crew: id });
      if (r.error) return missingSchema(r.error) ? 'old' : friendlyErr(r.error.message, t);
      if (r.data === 'owner_only') return t('err.crewRemoveOwnerOnly');
    }
    return null;
  };
  const myCrewsHere = (id, inHere) => (id === uid ? crews.filter((c) => c.owner_user_id === uid && inHere(c.id)).map((c) => c.id) : []); // 내보내는 사람이 나일 때만 — 남의 에이전트는 서버 트리거가 사람과 함께 뺀다(분리 검수 HIGH 2026-10-02)
  const leaveCrew = async (id) => { // 주인이 방장이 아니어도 자기 에이전트는 이 방에서 뺄 수 있다(데려온 것이 동의라면 빼는 것은 동의 철회)
    setBusy(true); const err = await dropCrews([id]); setBusy(false);
    if (err) return onError(err === 'old' ? t('crew.leaveHere.upgrade') : err);
    await onChanged();
  };
  const removeMember = async (kind, id) => {
    const owned = kind === 'user' ? myCrewsHere(id, (cid) => chMembers.some((m) => m.member_kind === 'crew' && m.member_id === cid)) : [];
    if (owned.length) { setBusy(true); const err = await dropCrews(owned); setBusy(false); if (err) return onError(err === 'old' ? t('ch.remove.ownerBlocked') : err); }
    setBusy(true);
    const res = await supabase.from('msgr_channel_members').delete().eq('channel_id', channel.id).eq('member_kind', kind).eq('member_id', id).select('member_id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('ch.noEdit'));
    await onChanged();
  };
  // 공개 채널 '내보내기' = 채널 제외 목록(행 삭제가 아님 — 공개 채널 구성원은 암묵). 되돌리기는 목록에서 뺀다. 최종은 RLS(msgr_can_manage_channel·msgr_can_read_channel).
  const excludedUsers = channel.excluded_user_ids ?? []; const excludedCrews = channel.excluded_crew_ids ?? [];
  const excludeMember = async (kind, id) => {
    const owned = kind === 'user' ? myCrewsHere(id, (cid) => chCrews.some((x) => x.id === cid)) : [];
    if (owned.length) { setBusy(true); const err = await dropCrews(owned); setBusy(false); if (err) return onError(err === 'old' ? t('ch.remove.ownerBlocked') : err); } // 규칙 14 — removeMember와 같은 처리
    const key = kind === 'user' ? 'excluded_user_ids' : 'excluded_crew_ids'; const cur = kind === 'user' ? excludedUsers : excludedCrews;
    if (!cur.includes(id)) await upd({ [key]: [...cur, id] }, t('ch.exclude.done'));
    if (kind === 'user') { // 참여 행도 지운다 — 남기면 목록에는 있는데 열리지 않는 채널이 된다(읽기 판정은 제외 목록을 본다)
      const res = await supabase.from('msgr_channel_members').delete().eq('channel_id', channel.id).eq('member_kind', 'user').eq('member_id', id);
      if (res.error) return onError(res.error.message);
      await onChanged();
    }
  };
  const restoreMember = async (kind, id) => {
    const key = kind === 'user' ? 'excluded_user_ids' : 'excluded_crew_ids'; const cur = kind === 'user' ? excludedUsers : excludedCrews;
    if (kind === 'user') { // 내보내기가 참여 행까지 지웠으니 되돌리기는 행을 먼저 되살린다 — 제외만 풀면 "다시 들어왔습니다"라고 하고 목록에는 없다(D30)
      setBusy(true);
      const res = await supabase.from('msgr_channel_members').upsert([{ channel_id: channel.id, member_kind: 'user', member_id: id, added_by: uid }], { onConflict: 'channel_id,member_kind,member_id' });
      setBusy(false);
      if (res.error) return onError(friendlyErr(res.error.message, t)); // 실패하면 제외도 그대로 둔다 — 성공 알림 없이
    }
    await upd({ [key]: cur.filter((x) => x !== id) }, t('ch.restore.done'));
  };
  const kick = (kind, id) => (channel.kind === 'public' || (kind === 'user' && kickExcludes(channel)) ? excludeMember(kind, id) : removeMember(kind, id)); // 사람 내보내기는 공개·비공개 모두 제외 목록(유건 결정 2026-10-06 — 재사용 초대로 다시 들어오지 않게, 서버 msgr_channel_kick_excludes가 보장). 비공개 채널 에이전트는 종전대로 행만
  // 비공개 채널 내보내기도 제외 목록에 올라 재사용·게스트 초대로 그 채널에 다시 들어오지 않는다(유건 결정 2026-10-06) — 예전의 '살아 있는 링크를 취소하세요' 확인은 필요 없어 뺐다
  const kickUser = (m) => kick('user', m.user_id);
  const isDmRoom = channel.kind === 'dm';
  const inRoom = people.some((m) => m.user_id === uid);
  const canManage = isDmRoom ? inRoom : canEdit; // 대화방은 그 방에 있는 사람만 — 조직 관리자라도 밖에서는 손대지 못한다(서버 msgr_can_manage_channel과 같은 규칙)
  const canKick = canEdit && channel.kind !== 'dm'; // 사람 내보내기 — 대화방에서는 그대로 막는다(나가는 것은 각자)
  const canKickCrew = canManage && (channel.kind !== 'public' || canEdit); // 부른 에이전트는 다시 내보낼 수 있다
  const [confirmArchive, setConfirmArchive] = useState(false); // 네이티브 confirm 대신 2단계 버튼(QA)
  const archive = async () => { await upd({ archived_at: new Date().toISOString() }); onArchived(); };
  const userIds = new Set(chMembers.filter((m) => m.member_kind === 'user').map((m) => m.member_id));
  const crewIds = new Set(chMembers.filter((m) => m.member_kind === 'crew').map((m) => m.member_id));
  const safety = useContext(SafetyCtx); const { hiddenUserIds } = safety;
  const [hideCrew, setHideCrew] = useState(null); // 남의 에이전트 숨기기 확인 창(D8)
  const addableUsers = withoutHidden(members.filter((m) => !userIds.has(m.user_id) && m.user_id !== org?.service_user_id && addableToChannel(channel, m, excludedUsers)), isPersonal ? hiddenUserIds : null); // 공개 채널은 내보낸 사람·게스트가 후보가 아니다(서버가 거절한다) // 회사 크루 서버(기계 계정)는 사람 후보가 아니다(실측: 첫 칩이 '회사 노드')
  // 누가 무엇을 데려오나 — 추가 후보는 방장이어도 **내 에이전트와 회사 에이전트만**(유건 2026-09-17: 친구·동료 에이전트까지 전부 보여 목록이 두 배로 늘었다).
  // 남의 에이전트는 그 주인이 데려오고(참여자면 방장 승인), 방장은 요청을 허락한다. 방장도 남의 개인 에이전트를 바로 넣지 못한다(서버 msgr_crew_join·msgr_channel_member_ok가 막는다, 2026-09-18). /
  // 채팅: 내 에이전트만 — 들어온 에이전트는 참여자 누구나 부르므로, 넣는 것은 주인만 한다(2026-09-18). 못 데려옴 채널은 회사 에이전트만.
  const isHost = canEdit && !isDmRoom;
  const pendingCrews = new Set(joinReqs.map((r) => r.crew_id));
  const addableCrews = crews.filter((c) => !crewIds.has(c.id) && !pendingCrews.has(c.id) && ((channel.personal_crews ?? 'approval') !== 'blocked' || crewTier(c, org) === 'company')
    && (isDmRoom ? c.owner_user_id === uid : (c.owner_user_id === uid || (!!org?.service_user_id && c.owner_user_id === org.service_user_id))) && crewAddable(c)); // 개인 공간에서 답하지 못하는 봇 쌍둥이는 후보에서 뺀다(2026-10-01) // 봇은 등급이 회사여도 주인은 연결한 멤버다 — 남이 연결한 봇도 빠진다
  const isApprover = isDmRoom ? dmSt.isApprover : isHost; // 참여 요청을 결정하는 사람 — 최종 강제는 서버(msgr_can_decide_crew_join)
  const needsApproval = (c) => (isDmRoom ? dmNeedsApproval(dmSt) : !isHost && (crewTier(c, org) === 'company' || (channel.personal_crews ?? 'approval') === 'approval')); // I-3: 차단 채널엔 회사 크루만 후보(안 될 버튼 노출 금지 — 최종은 서버 게이트)
  const scoped = channel.kind !== 'public';
  const nodeSet = !!org?.service_user_id; const nodeOn = nodeSet && !!org?.node_seen_at && Date.now() - Date.parse(org.node_seen_at) < AWAY_MS; // I-5·검수 M-4: 노드가 살아 있어야 만들 수 있다(죽은 노드면 영원한 '만드는 중')
  const crewCreate = policy?.crew_create ?? 'channel_admin';
  const myRole = members.find((m) => m.user_id === uid)?.role ?? 'member';
  const canCreateCrew = channel.kind !== 'dm' && nodeOn && myRole !== 'guest' && (isAdmin || crewCreate === 'member' || (crewCreate === 'channel_admin' && canEdit)); // 권한 행렬 — 최종은 RLS msgr_can_create_crew // 권한 행렬 — 최종은 RLS msgr_can_create_crew
  const [newCrew, setNewCrew] = useState(null); const [requests, setRequests] = useState([]); const doneSeen = useRef(null);
  const loadRequests = useCallback(async () => {
    const rows = await q(supabase.from('msgr_crew_requests').select('id, name, status, error, crew_id, created_at, done_at').eq('org_id', org.id).eq('channel_id', channel.id).order('created_at', { ascending: false }).limit(10));
    setRequests(rows);
    const done = rows.filter((r) => r.status === 'done').map((r) => r.id).join(',');
    if (doneSeen.current !== null && doneSeen.current !== done) onChanged(); // 노드가 만들었다 → 참여 구성 다시 읽기
    doneSeen.current = done;
  }, [org?.id, channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!nodeOn || channel.kind === 'dm') return; loadRequests().catch(() => {}); const iv = setInterval(() => loadRequests().catch(() => {}), 3000); return () => clearInterval(iv); }, [loadRequests, nodeOn, channel.kind]);
  const submitCrew = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_crew_requests').insert({ org_id: org.id, channel_id: newCrew.orgWide ? null : channel.id, name: newCrew.name.trim(), role_text: newCrew.role.trim(), prompt: newCrew.prompt.trim(), created_by: uid }).select('id');
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
    setNewCrew(null); setAdd(null); onNote(t('ch.crew.new.sent')); loadRequests().catch(() => {});
  };
  // 대화방에서 사람을 고르면 그 사람까지 들어간 **새 방**이 열린다(유건 2026-09-16) — 사적인 지난 대화가 불려 온 사람에게 넘어가지 않게. 에이전트는 지금 방에 바로 들어온다.
  // 공개 채널도 참여 기준이라 초대할 수 있다(유건 제보 2026-09-16). 개인 공간 1:1은 '한 쌍 한 방'이라 사람을 더 부르지 않는다.
  // 판정은 isPersonal로 한다 — 조직 채널 조회는 org_id 열을 가져오지 않아, org_id로 가르면 조직 대화방까지 막혔다(실사고 2026-09-16).
  // 개인 공간도 친구를 더 부르면 새 그룹 방이 열린다(유건 2026-09-17). 친구 아닌 구성원(친구의 친구)이 있는 방은 새 방에 그 사람을 넣을 수 없어 막는다(서버: 친구만)
  const canAddPeople = canManage && addableUsers.length > 0 && !(isPersonal && people.some((m) => m.user_id !== uid && !members.some((f) => f.user_id === m.user_id)));
  const canDispatch = (isHost || inRoom) && myAvailable.length > 0 && (channel.personal_crews ?? 'approval') !== 'blocked'; // 부록 M: 내 파견 전 크루 — 공개 채널은 파견만 하면 자동 참여, 비공개·대화방은 파견+멤버
  const canAddCrew = ((isHost || inRoom) && addableCrews.length > 0) || canDispatch; // 공개 채널도 초대된 에이전트만(2026-09-16) — 종전의 '파견 전원 참여, @로 부르기'는 없어졌다
  const canGuest = channel.kind === 'private' && canEdit;
  const inviteRole = isPersonal || channel.kind === 'dm' ? null : isAdmin ? 'member' : canGuest ? 'guest' : null; // 초대 창 권한(총괄 확정): 조직 관리자 = 멤버, 관리자 아닌 방장 = 이 비공개 채널 게스트만
  const showNewCrewItem = channel.kind !== 'dm' && (canCreateCrew || (isAdmin && !nodeOn)); // 관리자에겐 서버가 없거나 죽어도 항목은 보이되 비활성+이유(안 될 버튼 노출 금지의 예외: 왜 안 되는지 알려줘야 하는 자리)
  const canAddAny = canAddPeople || canAddCrew || canGuest || showNewCrewItem;
  const personalLabel = (v) => t(`ch.personal.${v}`);
  const pendingReqs = requests.filter((r) => r.status !== 'done' || Date.now() - Date.parse(r.done_at ?? r.created_at) < 120_000);
  // 에이전트 행 메뉴 — 항목 규칙은 crew-row-menu.mjs(개인 공간은 에이전트 관리를 그리지 않으므로 메뉴에도 없다, 검수 F)
  const crewMenu = (c) => crewRowMenuKeys({ isPersonal, isDm: channel.kind === 'dm', canKickCrew, ownedByMe: c.owner_user_id === uid, company: crewTier(c, org) === 'company' && c.hosting === 'resident', canHide: !!safety.muteCrew && !safety.mutedCrewIds.has(c.id) }).map((k) => ({
    manage: { icon: 'star', label: t('ch.open.crew'), run: () => onCrew?.(c.id) },
    call: { icon: 'at', label: t('ch.add.crew.call'), run: () => onMention?.(c) },
    remove: { icon: 'x', label: t(isDmRoom ? 'dm.remove.crew' : 'ch.remove.crew'), danger: true, disabled: busy, run: () => kick('crew', c.id) },
    leave: { icon: 'out', label: isDmRoom ? t('dm.remove.crew') : t('crew.leaveHere', { channel: channel.name }), danger: true, disabled: busy, run: () => leaveCrew(c.id) },
    hide: { icon: 'eyeoff', label: t('fm.hideAgent.title'), run: () => setHideCrew(c) }, // 남의 에이전트 — 내보내기 대신 숨기기(확인 창에 안내 한 줄, D8)
  }[k]));
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      {rowMenu && <CtxMenu at={rowMenu.at} items={rowMenu.items} onClose={() => setRowMenu(null)} />}
      {hideCrew && createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t('fm.hideAgent.title')}>
        <ConfirmModal tone="primary" title={t('fm.hideAgent.title')} description={t('fm.hideAgent.note')} confirmLabel={t('fm.hide')} busy={busy}
          onConfirm={async () => { const c = hideCrew; setBusy(true); try { await safety.muteCrew(c.id); setHideCrew(null); } catch { onError(t('crew.mute.failed')); } finally { setBusy(false); } }} onClose={() => { if (!busy) setHideCrew(null); }} />
      </div>, document.body)}
      <aside className="msgr-crewsheet" role="dialog" aria-label={t('ch.sheet')}>
        <div className="head">
          <span className="msgr-av lg" style={{ borderRadius: 12 }}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} /></span>
          <div style={{ minWidth: 0 }}><div className="name">{channel.kind === 'dm' ? (dmName ? dmName(channel) : t('ch.kind.dm')) : `${channel.kind === 'private' ? '' : '#'}${channel.name}`}</div>{/* 1:1은 상대 이름, 공개 채널은 #이름(유건 2026-09-11) */}<div className="msgr-klabel">{channel.kind === 'dm' ? t('ch.kind.dm') : channel.topic || t(`ch.kind.${channel.kind}`)}</div></div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={15} /></button>
        </div>
        <section className="msgr-channel-notifications">
          <button type="button" className="btn" onClick={onToggleMute} aria-pressed={muted} title={t(muted ? 'ch.mute.off.tip' : 'ch.mute.on.tip')}><I name={muted ? 'belloff' : 'bell'} size={16} />{t(muted ? 'ch.unmute' : 'ch.mute')}</button>
        </section>
        {/* 1. 누가 있나 — 패널을 여는 이유가 먼저 */}
        <section>
          <div className="sec-head"><h3>{t(isDmRoom ? 'dm.who' : 'ch.who')}</h3><span className="sub">{t('ch.who.count', { p: people.length, c: chCrews.length })}</span>{inviteRole && onInviteHere && <button type="button" className="btn sm" onClick={() => onInviteHere(inviteRole)}><I name="copy" size={12} />{t(inviteRole === 'guest' ? 'inv.here.guest' : 'inv.here')}</button>}</div>
          {!inviteRole && !isPersonal && channel.kind !== 'dm' && askAdmin && <p className="note">{askAdmin}</p>}
          {!scoped && <p className="note">{t('ch.who.public')}</p>}
          <div className="msgr-rows">
            {people.map((m) => { const isMe = m.user_id === uid; const isCreator = creatorTagVisible({ isCreator: channel.created_by === m.user_id, isPersonal, isGroup: !!channel._personal_group }); /* 개인 1:1은 만든 사람이 따로 없다 — 두 사람 모두 자신을 '방장'으로 보던 표식(검수 F) */ const isChAdmin = chAdmins.includes(m.user_id); const key = `u:${m.user_id}`; return (
              <div key={key} className="row">
                <Av name={m.display_name || m.user_id} size="sm" userId={m.user_id} /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span><span className="sub">{[m.role && t(`role.${m.role}`), isMe && t('ui.me')].filter(Boolean).join(' · ')}{(isChAdmin || isCreator) && <span className="msgr-tag">{isCreator ? t('ch.admin.creator') : t('ch.admin')}</span>}</span>
                {!isMe && (canAssignAdmins || canKick) && (
                  <span className="msgr-rowmenu-wrap" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn sm ghost" onClick={(e) => openRowMenu(e, key, [
                      { icon: 'at', label: t('ui.dm'), run: () => onDm?.(m.user_id) },
                      canAssignAdmins && !isCreator && { icon: 'gear', label: isChAdmin ? t('ch.admin.unset') : t('ch.admin.set'), disabled: busy, run: () => toggleChAdmin(m.user_id) },
                      canKick && { icon: 'x', label: t('ch.remove'), danger: true, disabled: busy, run: () => kickUser(m) },
                    ])} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-haspopup="menu" aria-expanded={rowMenu?.key === key}><I name="dots" size={13} /></button>
                  </span>
                )}
              </div>
            ); })}
            {chCrews.map((c) => { const on = seenWithin(c, AWAY_MS, Date.now(), crewSeenAt(c)); const company = crewTier(c, org) === 'company'; const key = `c:${c.id}`; return (
              <div key={key} className="row">
                <Av name={c.display_name} crew size="sm" company={company} crewId={c.id} /><span className="name">{c.display_name}</span>
                <span className="sub">{company ? t('crew.tier.company.sub', { org: org?.name ?? '', role: c.role_text ?? '' }) : t('crew.tier.personal.sub', { name: nameOfUser(c.owner_user_id), role: c.role_text ?? '' })}</span>{!on && <span className="msgr-offline">{t('crew.offline')}</span>}
                <span className={`msgr-dot${on ? ' mark' : ''}`} title={on ? t('crew.online') : t('crew.away')} />
                <span className="msgr-rowmenu-wrap" onClick={(e) => e.stopPropagation()}>
                  {crewMenu(c).length > 0 && <button type="button" className="btn sm ghost" onClick={(e) => openRowMenu(e, key, crewMenu(c))} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-haspopup="menu" aria-expanded={rowMenu?.key === key}><I name="dots" size={13} /></button>}
                </span>
              </div>
            ); })}
            {joinReqs.map((r) => { const label = pendingCrewLabel({ crewId: r.crew_id, crews, requesterName: nameOfUser(r.requested_by), t }); const mine = r.requested_by === uid; return (
              <div key={`req:${r.id}`} className="row req">
                <Av name={label} crew size="sm" crewId={r.crew_id} /><span className="name">{label}</span>{/* 친구의 에이전트는 방에 들기 전엔 이름을 못 읽는다 — id 조각 대신 "○○님의 에이전트"(crew-label.mjs) */}
                <span className="sub">{mine ? t('ch.crew.join.waiting') : t('ch.crew.join.by', { name: nameOfUser(r.requested_by) })}</span>
                {isApprover && !mine && <span className="acts"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => decideJoin(r, true)}>{t('ch.crew.join.approve')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => decideJoin(r, false)}>{t('ch.crew.join.reject')}</button></span>}
              </div>
            ); })}
            {(() => { const k = crewListEmptyKey({ crewCount: chCrews.length, pendingCount: joinReqs.length, isPersonal, canAddCrew, scoped }); return k && <p className="empty">{t(k)}{k === 'ch.crews.none.personal' && <> <RunnerButton /></>}</p>; })()}{/* 넣을 내 에이전트가 없는데 "아래 추가"를 가리키던 문구(유건 제보 2026-09-30) */}
            {kickExcludes(channel) && canEdit && (excludedUsers.length > 0 || (channel.kind === 'public' && excludedCrews.length > 0)) && (<>
              <div className="msgr-klabel">{t('ch.excluded')}</div>
              {excludedUsers.map((id) => { const m = members.find((x) => x.user_id === id); return (
                <div key={`xu:${id}`} className="row"><Av name={m?.display_name || id} size="sm" userId={id} /><span className="name">{m?.display_name || id.slice(0, 8)}</span><button type="button" className="btn sm ghost text" disabled={busy} onClick={() => restoreMember('user', id)}>{t('ch.restore')}</button></div>
              ); })}
              {excludedCrews.map((id) => { const c = crews.find((x) => x.id === id); return (
                <div key={`xc:${id}`} className="row"><Av name={c?.display_name || id} crew size="sm" crewId={id} /><span className="name">{c?.display_name || id.slice(0, 8)}</span><button type="button" className="btn sm ghost text" disabled={busy} onClick={() => restoreMember('crew', id)}>{t('ch.restore')}</button></div>
              ); })}
            </>)}
          </div>
          {pendingReqs.map((r) => (
            <div key={r.id} className="row req"><span className="name">{r.name}</span><span className={`sub ${r.status}`}>{r.status === 'pending' ? (nodeOn ? t('ch.crew.new.pending') : t('ch.crew.new.pendingOff')) : r.status === 'failed' ? t('ch.crew.new.failed', { why: r.error ?? '' }) : t('ch.crew.new.done')}</span></div>
          ))}
          {canAddAny && (
            <div className="msgr-addwrap">
              {add === null && <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => setAdd('menu')}><I name="plus" size={13} />{t(canAddPeople || canGuest ? 'ch.add' : 'ch.add.crew')}</button>}{/* 사람을 넣을 수 없으면 실제 메뉴(에이전트 추가)대로 — '관리자에게 말해 주세요' 바로 아래 '초대하기'가 있었다(UXM-27) */}
              {add === 'menu' && (
                <div className="msgr-addmenu" role="menu">
                  {canAddPeople && <button type="button" role="menuitem" onClick={() => setAdd('user')}><I name="plus" size={14} /><span><b>{t(isDmRoom ? 'dm.widen' : 'ch.add.user')}</b><small>{t(isDmRoom ? 'dm.widen.desc' : 'ch.add.user.desc')}</small></span></button>}
                  {canAddCrew && <button type="button" role="menuitem" onClick={() => setAdd('crew')}><I name="star" size={14} /><span><b>{t('ch.add.crew')}</b><small>{t(isDmRoom ? 'dm.add.crew.desc' : 'ch.add.crew.desc')}</small></span></button>}
                  {canGuest && <button type="button" role="menuitem" onClick={() => { setAdd(null); onInviteHere?.('guest'); }}><I name="copy" size={14} /><span><b>{t('ch.add.guest')}</b><small>{t('ch.add.guest.desc')}</small></span></button>}
                  {showNewCrewItem && <button type="button" role="menuitem" disabled={!canCreateCrew} onClick={() => { setAdd('newcrew'); setNewCrew({ name: '', role: '', prompt: '', orgWide: false }); }}><I name="hash" size={14} /><span><b>{t('ch.add.newcrew')}</b><small>{canCreateCrew ? t('ch.add.newcrew.desc') : t(nodeSet ? 'ch.crew.new.nodeOff' : 'ch.crew.new.noNode')}</small></span></button>}
                  <button type="button" role="menuitem" className="cancel" onClick={() => setAdd(null)}>{t('ui.cancel')}</button>
                </div>
              )}
              {add === 'user' && (<>
                <div className="msgr-klabel">{t(isDmRoom ? 'dm.widen' : 'ch.add.user')}</div>
                {isDmRoom && <p className="note">{t('dm.widen.note')}</p>}
                <div className="msgr-chips">{addableUsers.map((m) => <button key={m.user_id} type="button" className="msgr-chan" onClick={() => (isDmRoom ? (setAdd(null), onWiden?.(m.user_id)) : addMember('user', m.user_id))}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div>
                {!isPersonal && <p className="note">{ent?.plan === 'team' ? t('ch.add.user.pool.team', { n: members.length, seats: ent?.seats ?? '?' }) : t('ch.add.user.pool', { n: members.length })}{onInvite && <> <button type="button" className="btn sm" onClick={() => onInviteHere?.('member')}><I name="copy" size={12} />{t('inv.here')}</button></>}</p>}{/* 좌석 수는 team 플랜에만 의미가 있다(2026-09-27 — 무료 조직은 좌석 한도가 없다) */}
                <div className="acts"><button type="button" className="btn sm" onClick={() => setAdd(null)}>{t('ui.cancel')}</button></div>
              </>)}
              {add === 'crew' && (() => { const rows = [...addableCrews.map((c) => ({ c })), ...(canDispatch ? myAvailable.map((c) => ({ c, dispatch: true })) : [])]; const picked = rows.filter((r) => crewPicks.has(r.c.id)); /* 목록이 갱신돼 빠진 후보는 세지 않는다 */ return (<>
                <div className="msgr-klabel">{t('ch.add.crew')}{picked.length > 0 && ` · ${t('dm.group.count', { n: picked.length })}`}</div>
                {rows.length > 0 && <div className="msgr-picklist">{rows.map(({ c, dispatch }) => (
                  <label key={c.id} className="msgr-check pickrow"><input type="checkbox" checked={crewPicks.has(c.id)} disabled={busy} onChange={() => setCrewPicks((cur) => { const n = new Set(cur); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />
                    <Av name={c.display_name} crew size="xs" crewId={c.id} company={crewTier(c, org) === 'company'} /><span className="name">{c.display_name}</span>
                    <span className="msgr-klabel">{dispatch ? t('ch.add.mine.short') : needsApproval(c) ? t('ch.crew.join.ask') : c.role_text ?? ''}</span></label>
                ))}</div>}
                {rows.length > 0 && <p className="note">{t('ch.add.crew.shared')}</p>}
                {addableCrews.some(needsApproval) && <p className="note">{isDmRoom
                  ? (dmApprover ? t(dmApprover === channel.created_by ? 'dm.crew.join.note.opener' : 'dm.crew.join.note', { name: nameOfUser(dmApprover) }) : t('dm.crew.join.note.unknown'))
                  : t('ch.crew.join.note')}</p>}
                {!rows.length && <p className="note">{t('ch.add.crew.none')} <RunnerButton /></p>}
                {rows.some((r) => r.dispatch) && <p className="note">{t('ch.add.mine.note')}</p>}
                {channel.kind === 'private' && <p className="note">{t('ch.add.crew.note')}</p>}
                <div className="acts"><button type="button" className="btn btn-primary sm" disabled={busy || !picked.length} onClick={() => addCrews(rows)}><I name="plus" size={13} />{picked.length ? t('ch.add.crew.submit', { n: picked.length }) : t('ch.add.crew')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => { setAdd(null); setCrewPicks(new Set()); }}>{t('ui.cancel')}</button></div>
              </>); })()}
              {add === 'newcrew' && newCrew && (
                <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); submitCrew(); }}>
                  <div className="msgr-klabel">{t('ch.add.newcrew')}</div>
                  <input className="msgr-input" placeholder={t('ch.crew.new.name')} value={newCrew.name} onChange={(e) => setNewCrew({ ...newCrew, name: e.target.value })} autoFocus maxLength={40} />
                  <input className="msgr-input" placeholder={t('ch.crew.new.role')} value={newCrew.role} onChange={(e) => setNewCrew({ ...newCrew, role: e.target.value })} maxLength={60} />
                  <textarea className="msgr-input area" placeholder={t('ch.crew.new.prompt')} value={newCrew.prompt} onChange={(e) => setNewCrew({ ...newCrew, prompt: e.target.value })} maxLength={2000} rows={3} />
                  {isAdmin && <label className="switchrow"><input type="checkbox" checked={newCrew.orgWide} onChange={(e) => setNewCrew({ ...newCrew, orgWide: e.target.checked })} /><span>{t('ch.crew.new.orgWide')}</span></label>}
                  <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={busy || !newCrew.name.trim() || !newCrew.prompt.trim()}><I name="check" size={13} />{t('ch.crew.new.submit')}</button><button type="button" className="btn sm" onClick={() => { setAdd(null); setNewCrew(null); }}>{t('ui.cancel')}</button></div>
                  <p className="note">{t('ch.crew.new.desc')}</p>
                </form>
              )}
            </div>
          )}
        </section>
        {/* 2. 채널 설정 — 접어 둔다(자주 안 만진다) */}
        <section className="msgr-fold">
          <button type="button" className="fold-head" onClick={() => setMore((v) => !v)} aria-expanded={more}><h3>{t(isPersonal ? 'personal.sheet.settings' : 'ch.settings')}</h3><I name="caret" size={14} className={more ? 'open' : ''} /></button>
          {more && (<>
            {channel.kind !== 'dm' && (<>
              <label className="field"><span className="msgr-klabel">{t('ch.name')}</span><input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit || busy} /></label>
              <label className="field"><span className="msgr-klabel">{t('ch.topic')}</span><input value={topic} placeholder={t('ch.topic.ph')} onChange={(e) => setTopic(e.target.value)} disabled={!canEdit || busy} /></label>
              {canEdit ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || (name === channel.name && (topic || '') === (channel.topic || ''))} onClick={saveText}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('ch.noEdit')}</p>}
            </>)}
            <label className="switchrow"><input type="checkbox" checked={channel.crew_memory !== false} disabled={!canEdit || busy || memLocked} onChange={(e) => upd({ crew_memory: e.target.checked })} /><span>{t('ch.memory.on')}</span></label>
            {memLocked && <p className="note">{t('ch.memory.locked')}</p>}
            {channel.kind !== 'dm' && (<>
              <div className="row wrap">
                <span className="msgr-klabel">{t('ch.personal')}</span>
                <Seg label={t('ch.personal')} value={channel.personal_crews ?? 'approval'} onPick={(v) => upd({ personal_crews: v }, t('ch.personal.saved'))} disabled={!canEdit || busy} options={['allowed', 'approval', 'blocked', ...(channel.personal_crews === 'read_only' ? ['read_only'] : [])].map((v) => ({ v, label: personalLabel(v) }))} />
              </div>
              <p className="note">{t('ch.personal.desc')}</p>{(channel.personal_crews ?? 'approval') === 'blocked' && <p className="note">{t('ch.personal.blocked.note')}</p>}
              {canEdit && (!confirmArchive
                ? <div className="row"><button type="button" className="btn sm" disabled={busy} onClick={() => setConfirmArchive(true)}><I name="x" size={13} />{t('ch.archive')}</button></div>
                : <div className="confirm"><p>{t('ch.archive.confirm')}</p><div className="row"><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={archive}><I name="x" size={13} />{t('ch.archive')}</button><button type="button" className="btn sm" onClick={() => setConfirmArchive(false)}>{t('ui.cancel')}</button></div></div>)}
            </>)}
          </>)}
        </section>
      </aside>
    </div>
  );
}

/* ─── 설정 페이지: 언어 · 테마(아르고와 같은 가족×모드) · 계정 ─── */
const FAMILIES = [['linen', 'settings.family.linen'], ['graphite', 'settings.family.graphite'], ['argo', 'settings.family.argo']];
const MODES = [['', 'set.mode.system'], ['-light', 'set.mode.light'], ['-dark', 'set.mode.dark']];
const FAMILY_CODES = FAMILIES.flatMap(([f]) => MODES.map(([s]) => `${f}${s}`));
/* ─── 화면 오류 경계 — 한 화면의 렌더 오류가 앱 전체를 빈 화면으로 만들지 않게(실측 2026-09-04: 설정 탭 ReferenceError로 전체 소실) ─── */
class PageBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error('[msgr] page render error:', err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="msgr-thread" style={{ display: 'flex' }}><div className="msgr-empty">
        <h1>{this.props.title}</h1>
        <p>{String(this.state.err?.message ?? this.state.err)}</p>
        <div className="row"><button type="button" className="btn btn-primary sm" onClick={() => { this.setState({ err: null }); this.props.onReset?.(); }}>{this.props.retry}</button></div>
      </div></div>
    );
  }
}

/* ─── 알림함 v1(클라이언트 집계) — 나를 부른 글·내 글의 크루 답글·대기 결재·DM 새 글. 읽음 기준은 이 기기. 서버 표(msgr_notifications)는 친구 요청과 함께 v2. ─── */
const INBOX_SEEN_KEY = 'argo-msgr-inbox-seen';
function readInboxSeen() { try { return JSON.parse(localStorage.getItem(INBOX_SEEN_KEY) || '{}') || {}; } catch { return {}; } }
function writeInboxSeen(v) { try { localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify(v)); } catch {} }
/* ─── 프로필(계정 단위): 아이디·표시 이름·찾기 허용 스위치 — msgr_profiles(본인만 쓰기). 친구 찾기의 기준. ─── */
// 앱 안 계정 삭제(App Store 5.1.1(v)) — 깃헙식 확인(단어 입력) 뒤 서버 함수 msgr_delete_me 한 번. 소유 조직에 다른 멤버가 있으면
// 서버가 조직명을 돌려주며 거부 → 소유권 이전 안내. 성공하면 세션은 이미 서버에서 무효라 로컬 로그아웃만 한다.
function AccountDeleteCard({ session, onDeleted }) {
  const isPhone = useIsPhone(); // 진단 경로 안내(2차 검수 L-h)
  const { t } = useT();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState('');
  const confirmWord = t('acct.delete.word');
  const run = async () => {
    setBusy(true); setBlocked('');
    const { error } = await supabase.rpc('msgr_delete_me');
    setBusy(false);
    if (error) {
      const m = /msgr_owner_transfer_required: (.*)$/m.exec(error.message || '');
      if (m) { setBlocked(t('acct.delete.transferFirst', { orgs: m[1].trim() })); return; }
      pushDiag('error', 'account delete failed', error.message); // 설정 › 진단 목록에 남긴다(console.error는 수집되지 않는다 — 3R M2R-4). 화면엔 내부 이름을 내보내지 않는다(2R M-3)
      setBlocked(t('acct.delete.failed', { path: t(isPhone ? 'diag.path.phone' : 'diag.path.desktop') })); return;
    }
    setOpen(false); onDeleted?.();
  };
  const email = session.user.email;
  return (
    <section className="msgr-setcard danger-zone">
      <h2>{t('acct.delete')}</h2>
      <p>{t('acct.delete.desc')}</p>
      <div className="row"><button type="button" className="btn sm" onClick={() => { setBlocked(''); setOpen(true); }}><I name="x" size={13} />{t('acct.delete.start')}</button></div>
      <p className="note">{email ? t('acct.delete.note', { email }) : t('acct.delete.note.noEmail')}</p>
      {open && <DangerModal title={t('acct.delete')} description={<>{t('acct.delete.desc')}{blocked && <span role="alert" className="acct-error">{blocked}</span>}</>} requireText={email || confirmWord} confirmLabel={t('acct.delete.confirm')} busy={busy} onConfirm={run} onClose={() => { if (!busy) { setOpen(false); setBlocked(''); } }} />}
    </section>
  );
}

function ProfileCard({ uid, onNote, onError, onAvatar, onSaved, part = 'all' }) { // part(폰 내 설정 하위 화면): 'profile' 사진·아이디·이름 / 'privacy' 찾기·요청 허용 / 'quiet' 조용한 시간 — 저장은 늘 행 전체(읽어 온 값 그대로 + 바꾼 칸)
  const { t } = useT();
  const [p, setP] = useState(null); const [busy, setBusy] = useState(false); const [draft, setDraft] = useState({ handle: '', display_name: '', email_search: true, handle_search: true, accept_requests: true, quiet_from: null, quiet_to: null });
  const setAvatar = async (url) => { setBusy(true); const res = await supabase.from('msgr_profiles').upsert({ user_id: uid, avatar_url: url }).select('*').single(); setBusy(false); if (res.error) return onError(res.error.message); setP(res.data); onNote(t('profile.saved')); onAvatar?.(); };
  const upAvatar = async (f) => { try { setBusy(true); const url = await uploadAvatar(uid, 'me', f); await setAvatar(url); } catch (e) { setBusy(false); onError(e.message); } };
  useEffect(() => { q(supabase.from('msgr_profiles').select('*').eq('user_id', uid).maybeSingle()).then((row) => { setP(row ?? {}); if (row) setDraft({ handle: row.handle ?? '', display_name: row.display_name ?? '', email_search: !!row.email_search, handle_search: row.handle_search !== false, accept_requests: row.accept_requests !== false, quiet_from: row.quiet_from ?? null, quiet_to: row.quiet_to ?? null }); }).catch((e) => onError(e.message)); }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleOk = !draft.handle || /^[a-z0-9][a-z0-9_.]{2,23}$/.test(draft.handle);
  const save = async () => {
    if (!handleOk) return onError(t('profile.handle.bad'));
    setBusy(true);
    const res = await supabase.from('msgr_profiles').upsert({ user_id: uid, handle: draft.handle || null, display_name: draft.display_name.trim() || null, email_search: draft.email_search, handle_search: draft.handle_search, accept_requests: draft.accept_requests, quiet_from: draft.quiet_from, quiet_to: draft.quiet_to, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select('*').single();
    setBusy(false);
    if (res.error) return onError(/msgr_profiles_handle_key|duplicate/.test(res.error.message) ? t('profile.handle.taken') : res.error.message);
    setP(res.data); onNote(t('profile.saved')); onSaved?.(); // 내 이름이 바뀌었으면 개인 공간 표시도 바로
  };
  if (p === null) return null;
  const all = part === 'all'; const show = (k) => all || part === k;
  return (
    <section className="msgr-setcard">
      {show('profile') && <><h2>{t('profile.title')}</h2><p>{t('profile.desc')}</p></>}
      {!all && part === 'privacy' && <h2>{t('phone.set.privacy')}</h2>}
      {!all && part === 'quiet' && <h2>{t('profile.quiet')}</h2>}
      {show('profile') && <><AvatarEdit name={draft.display_name || '?'} url={p?.avatar_url ?? null} busy={busy} t={t} onUpload={upAvatar} onRemove={() => setAvatar(null)} />
      <div className="row"><span className="msgr-klabel" style={{ width: 72 }}>{t('profile.handle')}</span><input className="msgr-input sm" value={draft.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value.toLowerCase() })} placeholder={t('profile.handle.ph')} maxLength={24} aria-invalid={!handleOk} /></div>
      <div className="row"><span className="msgr-klabel" style={{ width: 72 }}>{t('profile.name')}</span><input className="msgr-input sm" value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} placeholder={t('profile.name.ph')} maxLength={40} /></div></>}
      {show('privacy') && <><div className="row"><label className="msgr-check"><input type="checkbox" checked={draft.email_search} onChange={(e) => setDraft({ ...draft, email_search: e.target.checked })} /> {t('profile.emailSearch')}</label></div>
      <div className="row"><label className="msgr-check"><input type="checkbox" checked={draft.handle_search} onChange={(e) => setDraft({ ...draft, handle_search: e.target.checked })} /> {t('profile.handleSearch')}</label></div>
      <div className="row"><label className="msgr-check"><input type="checkbox" checked={draft.accept_requests} onChange={(e) => setDraft({ ...draft, accept_requests: e.target.checked })} /> {t('profile.acceptRequests')}</label></div></>}
      {show('quiet') && <><div className="row"><span className="msgr-klabel" style={{ width: 72 }}>{t('profile.quiet')}</span><label className="msgr-check"><input type="checkbox" checked={draft.quiet_from != null} onChange={(e) => setDraft({ ...draft, quiet_from: e.target.checked ? 22 : null, quiet_to: e.target.checked ? 7 : null })} /> {t('profile.quiet.on')}</label>
        {draft.quiet_from != null && <><select className="msgr-sort" value={draft.quiet_from} onChange={(e) => setDraft({ ...draft, quiet_from: +e.target.value })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t('profile.quiet.hour', { h })}</option>)}</select><span className="msgr-klabel">~</span><select className="msgr-sort" value={draft.quiet_to ?? 7} onChange={(e) => setDraft({ ...draft, quiet_to: +e.target.value })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t('profile.quiet.hour', { h })}</option>)}</select></>}
      </div>
      <p className="note">{t('profile.quiet.desc')}</p></>}
      <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !handleOk} onClick={save}>{t('ui.save')}</button>{!handleOk && <span className="note">{t('profile.handle.bad')}</span>}</div>
    </section>
  );
}

/* ─── 친구(디스코드·슬랙·텔레그램식): 이메일(정확 일치, 상대가 허용) 또는 아이디로 찾아 요청 → 수락. 판정은 전부 서버 RPC(msgr_find_user·msgr_friend_*). ─── */
/** 친구 찾기 — 이메일·아이디로 찾고 요청·수락·대화 열기. 설정 > 친구와 개인 공간의 친구 추가 팝업이 같이 쓴다(유건 2026-09-30: 설정으로 보내지 말고 팝업에서 바로). */
function FriendFinder({ uid, friends, members, onChanged, onDm, onPersonalDm, onNote, onError, onBlock = null, autoFocus = false }) {
  const { t } = useT();
  const [qs, setQs] = useState(''); const [res, setRes] = useState(null); const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false); const [searchError, setSearchError] = useState('');
  const searchRequest = useRef(0);
  useEffect(() => () => { searchRequest.current += 1; }, []);
  const find = async () => {
    const v = qs.trim().replace(/^@/, ''); const request = ++searchRequest.current;
    setSearchError(''); setRes(null);
    if (v.length < 3) { setSearching(false); return setRes([]); }
    setSearching(true);
    try { const rows = await q(supabase.rpc('msgr_find_user', { q: v })); if (request === searchRequest.current) setRes(rows); }
    catch (e) { if (request === searchRequest.current) setSearchError(e.message); }
    finally { if (request === searchRequest.current) setSearching(false); }
  };
  // ok는 고정 문구이거나, 서버 반환값(예: 같은 조직이라 바로 'friend'가 된 경우와 'sent'로 대기한 경우)에 따라 문구를 고르는 함수.
  const call = async (fn, args, ok) => { setBusy(true); try { const result = await q(supabase.rpc(fn, args)); onNote(typeof ok === 'function' ? ok(result) : ok); await onChanged?.(); if (res) await find(); } catch (e) { onError(/msgr_friend_closed/.test(e.message) ? t('friends.err.closed') : /msgr_friend_blocked/.test(e.message) ? t('friends.err.blocked') : e.message); } finally { setBusy(false); } };
  const nameOf = (f) => members.find((m) => m.user_id === f.user_id)?.display_name || f.display_name || f.handle || f.user_id.slice(0, 8);
  const relOf = (r) => { const f = friends.find((x) => x.user_id === r.user_id); return !f ? (r.relation === 'blocked' ? 'blocked' : 'none') : f.status === 'accepted' ? 'friend' : f.status === 'pending' ? (f.requested_by === uid ? 'sent' : 'received') : r.relation; }; // 친구 목록이 갱신되면 요청 거절·친구 해제도 검색 결과에 반영한다.
  return (<>
    <form className="row msgr-friend-search" onSubmit={(e) => { e.preventDefault(); if (!busy && !searching) find(); }}><input className="msgr-input sm" value={qs} disabled={busy} onChange={(e) => { searchRequest.current += 1; setQs(e.target.value); setRes(null); setSearchError(''); setSearching(false); }} placeholder={t('friends.find.ph')} aria-label={t('friends.find.ph')} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus={autoFocus} /><button type="submit" className="btn sm" disabled={busy || searching || qs.trim().replace(/^@/, '').length < 3}>{t('friends.find')}</button></form>
    {searching && <p className="note" role="status">{t('ui.loading')}</p>}
    {searchError && <p className="note danger" role="alert">{friendlyErr(searchError, t)}</p>}
    {res && (<div className="msgr-rows msgr-friend-results" aria-live="polite">
      {!res.length && <p className="empty">{t('friends.find.none')}</p>}
      {res.map((r) => { const inOrg = members.some((m) => m.user_id === r.user_id && (!m.expires_at || Date.parse(m.expires_at) > Date.now())); const relation = relOf(r); return (
        <div key={r.user_id} className="row msgr-friend-result">
          <Av name={nameOf(r)} size="sm" userId={r.user_id} />
          <div className="msgr-friend-person"><strong>{nameOf(r)}</strong>{r.handle && <span className="sub">@{r.handle}</span>}{inOrg && <span className="msgr-klabel">{t('friends.state.member')}</span>}</div>
          <div className="msgr-friend-actions">
            {relation === 'none' && <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => call('msgr_friend_request', { target: r.user_id }, (result) => result === 'friend' ? t('friends.accepted') : t('friends.sent'))}>{t('friends.request')}</button>}
            {relation === 'sent' && <span className="msgr-klabel">{t('friends.state.sent')}</span>}
            {relation === 'received' && <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => call('msgr_friend_decide', { other: r.user_id, accept: true }, t('friends.accepted'))}>{t('friends.accept')}</button>}
            {relation === 'friend' && <span className="msgr-klabel">{t('friends.state.friend')}</span>}
            {inOrg && relation !== 'blocked' && <button type="button" className="btn sm" disabled={busy} onClick={() => onDm?.(r.user_id)}><I name="at" size={13} />{t('ui.dm')}</button>}
            {!inOrg && relation === 'friend' && onPersonalDm && <button type="button" className="btn sm" disabled={busy} onClick={() => onPersonalDm(r.user_id)}><I name="at" size={13} />{t('friends.dm')}</button>}
            {onBlock && relation !== 'blocked' && <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => onBlock(r)}><I name="block" size={13} />{t('friends.block')}</button>}
          </div>
        </div>
      ); })}
    </div>)}
  </>);
}

/* ─── '실행기 연결' 시트(유건 지시 2026-10-02 — 세 앱은 서로 독립, 엔진은 argo 하나). 폰·데스크톱 공용.
   에이전트가 없거나 실행기가 꺼졌다는 안내 옆의 [실행기 연결]이 RunnerCtx로 이 시트를 연다. ─── */
const RunnerCtx = createContext(null);
function RunnerSheet({ hasOrg, onClose, onAgents, onNote, onError }) {
  const { t } = useT();
  const phone = useIsPhone();
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const copy = async () => { try { await navigator.clipboard.writeText(RUNNER_INSTALL); onNote(t('runner.copied')); } catch { onError(t('runner.copyFail')); } };
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <section className={`msgr-crewsheet msgr-dmpeek msgr-dmgroup msgr-runner${phone ? ' ph-friendadd' : ''}`} role="dialog" aria-label={t('runner.title')}>
        <header className="head"><strong>{t('runner.title')}</strong><button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek">
          <p className="run-desc">{t('runner.desc')}</p>
          {runnerOptions({ hasOrg, ios: isIos }).map((o) => (<div key={o.key} className="run-opt" data-opt={o.key}>
            <h3>{t(`runner.${o.key}`)}</h3>
            {o.key === 'computer' && <><p>{t('runner.computer.desc')}</p>{o.download && <button type="button" className="btn sm" onClick={() => openExternal(LEGAL.download)}><I name="doc" size={14} />{t('ch.step3.download')}</button>}</>}
            {o.key === 'server' && <>
              <div className="run-cmd"><code className="msgr-code" translate="no">{RUNNER_INSTALL}</code><button type="button" className="btn sm" onClick={copy}><I name="copy" size={14} />{t('runner.copy')}</button></div>
              <p><InlineCode text={t('runner.server.after')} /></p>
              <p className="run-small">{t('runner.server.only')}</p>
            </>}
            {o.key === 'external' && <button type="button" className="btn sm" onClick={onAgents}><I name="node" size={14} />{t('phone.set.ext')}</button>}
          </div>))}
        </div>
      </section>
    </div>
  );
}
function RunnerButton({ primary = false }) { // 에이전트가 없거나 실행기가 꺼졌다는 안내 옆 — 시트를 연다
  const { t } = useT(); const open = useContext(RunnerCtx);
  return open ? <button type="button" className={`btn sm${primary ? ' btn-primary' : ''} msgr-runbtn`} onClick={open}><I name="node" size={14} />{t('runner.title')}</button> : null;
}

function FriendAddSheet({ onClose, ...finder }) {
  const { t } = useT();
  const phone = useIsPhone();
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  if (phone) return <PhoneFriendAdd onClose={onClose} {...finder} />; // 폰: 찾기 · 내 링크·코드 공유 · 받은 링크·코드 넣기 한 화면(유건 확정 2026-10-01). 데스크톱은 아래 그대로
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <section className="msgr-crewsheet msgr-dmpeek msgr-dmgroup msgr-friendadd" role="dialog" aria-label={t('friends.add')}>
        <header className="head"><strong>{t('friends.add')}</strong><span className="msgr-klabel">{t('friends.add.sub')}</span><button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek"><FriendFinder {...finder} autoFocus={!('ontouchstart' in window)} /></div>
      </section>
    </div>
  );
}
/* 폰 친구 추가 한 화면(유건 확정 2026-10-01, 요청·수락 방식 유지): ① 아이디·이메일로 찾기 → 요청 → 상대 수락 ② 내 친구 링크·코드 공유 — 받은 사람이 넣으면 바로 친구(링크를 준 것이 허락)
   ③ 받은 링크·코드 넣기. 링크 읽기는 열 때 한 번(만들기 RPC는 없으면 만드니 누를 때만 부른다 — 설정 친구 카드와 같은 규칙). */
function PhoneFriendAdd({ onClose, uid, onChanged, onNote, onError, ...finder }) {
  const { t } = useT();
  const [link, setLink] = useState(null); const [busy, setBusy] = useState(false); const [paste, setPaste] = useState('');
  useEffect(() => {
    let live = true;
    q(supabase.from('msgr_friend_links').select('code, expires_at').eq('owner_user_id', uid).is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1))
      .then((rows) => { if (live && rows?.[0]) setLink((cur) => cur ?? rows[0]); }).catch(() => {});
    return () => { live = false; };
  }, [uid]);
  const make = async () => { setBusy(true); try { const [row] = await q(supabase.rpc('msgr_friend_link_mine')); setLink(row ?? null); } catch (e) { onError(e.message); } finally { setBusy(false); } };
  const revoke = async () => { setBusy(true); try { await q(supabase.rpc('msgr_friend_link_revoke', {})); setLink(null); onNote(t('friends.link.revoked')); } catch (e) { onError(e.message); } finally { setBusy(false); } }; // 폰에서도 링크를 끊는다(UXM-11) — 실패하면 링크를 그대로 둔다
  const text = link ? t('friends.link.textInstall', { code: link.code }) : '';
  const copy = async () => { try { await navigator.clipboard.writeText(text); onNote(t('friends.link.copied')); } catch { onError(t('friends.link.copyFail')); } };
  const share = async () => { if (!navigator.share) return copy(); try { await navigator.share({ text }); } catch (e) { if (e?.name !== 'AbortError') copy(); } }; // 공유 창을 닫은 것은 오류가 아니다
  const accept = async () => {
    const code = parseInviteCode(paste); if (!code) return onError(t('friends.link.bad'));
    setBusy(true);
    try { const r = await q(supabase.rpc('msgr_friend_link_accept', { code })); onNote(t(r === 'already' ? 'friends.link.already' : r === 'self' ? 'friends.link.self' : 'friends.link.done')); setPaste(''); await onChanged?.(); }
    catch (e) { onError(/msgr_link_invalid/.test(e.message) ? t('friends.link.invalid') : /blocked/.test(e.message) ? t('friends.link.blocked') : e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <section className="msgr-crewsheet msgr-dmpeek msgr-dmgroup msgr-friendadd ph-friendadd" role="dialog" aria-label={t('friends.add')}>
        <header className="head"><strong>{t('friends.add')}</strong><button type="button" className="msgr-titlebtn" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek">
          <h3 className="ph-fa-h">{t('friends.add.step.find')}</h3>
          <p className="ph-fa-sub">{t('friends.add.step.find.sub')}</p>
          <FriendFinder uid={uid} onChanged={onChanged} onNote={onNote} onError={onError} {...finder} />
          <h3 className="ph-fa-h">{t('friends.add.step.mine')}</h3>
          <p className="ph-fa-sub">{t('friends.add.step.mine.sub')}</p>
          {link ? (<div className="ph-fa-link">
            <code className="msgr-code" aria-label={t('friends.add.code')}>{link.code}</code>
            <div className="ph-fa-acts"><button type="button" className="btn" disabled={busy} onClick={copy}><I name="copy" size={14} />{t('friends.link.copy')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={share}><I name="up" size={14} />{t('friends.add.share')}</button><button type="button" className="btn ghost" disabled={busy} onClick={revoke}>{t('friends.link.revoke')}</button></div>
          </div>) : <button type="button" className="btn ph-fa-make" disabled={busy} onClick={make}><I name="plus" size={14} />{t('friends.link.make')}</button>}
          <h3 className="ph-fa-h">{t('friends.add.step.paste')}</h3>
          <form className="ph-fa-paste" onSubmit={(e) => { e.preventDefault(); if (!busy) accept(); }}>
            <input className="msgr-input" value={paste} disabled={busy} onChange={(e) => setPaste(e.target.value)} placeholder={t('friends.link.ph')} aria-label={t('friends.link.ph')} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <button type="submit" className="btn" disabled={busy || !paste.trim()}>{t('friends.link.add')}</button>
          </form>
        </div>
      </section>
    </div>
  );
}
function FriendsCard({ uid, friends, members, onChanged, onDm, onPersonalDm, onNote, onError, isPersonal = false, manage = false }) { // manage(폰 내 설정 '친구 관리'): 링크·찾기는 친구 탭 사람+ 창으로 옮겨 여기선 받은·보낸 요청·친구·차단만
  const { t, lang } = useT();
  const { mutedCrewIds, unmuteCrew } = useContext(SafetyCtx);
  const [mutedCrews, setMutedCrews] = useState([]);
  const loadMutedCrews = useCallback(async () => { try { setMutedCrews(await q(supabase.rpc('msgr_my_muted_crews')) ?? []); } catch {} }, []);
  useEffect(() => { loadMutedCrews(); }, [uid, mutedCrewIds.size, loadMutedCrews]);
  const [busy, setBusy] = useState(false);
  // ok는 고정 문구이거나, 서버 반환값에 따라 문구를 고르는 함수.
  const call = async (fn, args, ok) => { setBusy(true); try { const result = await q(supabase.rpc(fn, args)); onNote(typeof ok === 'function' ? ok(result) : ok); await onChanged?.(); return true; } catch (e) { onError(/msgr_friend_closed/.test(e.message) ? t('friends.err.closed') : /msgr_friend_blocked/.test(e.message) ? t('friends.err.blocked') : e.message); return false; } finally { setBusy(false); } }; // 성공 여부를 돌려준다 — 링크 끊기가 실패해도 링크가 사라진 것처럼 보였다(UXM-11)
  const nameOf = (f) => members.find((m) => m.user_id === f.user_id)?.display_name || f.display_name || f.handle || f.user_id.slice(0, 8); // 같은 조직이면 조직 이름 우선(프로필 미설정 시 이메일 앞부분 대신)
  const received = friends.filter((f) => f.status === 'pending' && f.requested_by !== uid);
  const [removing, setRemoving] = useState(null); // 친구 삭제 확인(S16) — 되돌리려면 다시 요청·수락이 필요하다
  const sent = friends.filter((f) => f.status === 'pending' && f.requested_by === uid);
  const accepted = friends.filter((f) => f.status === 'accepted').sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ko'));
  // 친구 링크(유건 2026-09-16) — 링크 하나 공유하면 받은 쪽이 열어서 친구가 된다. 조직 초대와 다른 문이다.
  const [link, setLink] = useState(null);      // { code, expires_at }
  const [blocked, setBlocked] = useState([]);
  const [confirmBlock, setConfirmBlock] = useState(null);
  useEffect(() => { // 살아 있는 내 링크는 열 때 읽기만 한다(S11) — 만들기 RPC(msgr_friend_link_mine)는 없으면 만드니 부르지 않는다. RLS가 본인 행만 보여 준다
    let live = true;
    q(supabase.from('msgr_friend_links').select('code, expires_at').eq('owner_user_id', uid).is('revoked_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1))
      .then((rows) => { if (live && rows?.[0]) setLink((cur) => cur ?? rows[0]); }).catch(() => {});
    return () => { live = false; };
  }, [uid]);
  const [joinLink, setJoinLink] = useState(''); // 받은 링크·코드 붙여넣기
  useEffect(() => { // UGC 심사용 차단 해제 표면
    let live = true;
    q(supabase.rpc('msgr_my_blocked')).then((rows) => { if (live) setBlocked(rows ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [uid, friends.length]);
  const refreshBlocked = useCallback(async () => {
    try { setBlocked(await q(supabase.rpc('msgr_my_blocked')) ?? []); } catch {}
  }, []);
  const showLink = async () => {
    setBusy(true);
    try { const [row] = await q(supabase.rpc('msgr_friend_link_mine')); setLink(row ?? null); } catch (e) { onError(e.message); } finally { setBusy(false); }
  };
  const copyLink = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(friendShareText(link.code, { t })); onNote(t('friends.link.copied')); } catch { onError(t('friends.link.copyFail')); }
  };
  const acceptLink = async () => {
    const code = parseInviteCode(joinLink);
    if (!code) return onError(t('friends.link.bad'));
    setBusy(true);
    try {
      const r = await q(supabase.rpc('msgr_friend_link_accept', { code }));
      onNote(t(r === 'already' ? 'friends.link.already' : r === 'self' ? 'friends.link.self' : 'friends.link.done'));
      setJoinLink(''); await onChanged?.();
    } catch (e) { onError(/msgr_link_invalid/.test(e.message) ? t('friends.link.invalid') : /blocked/.test(e.message) ? t('friends.link.blocked') : e.message); }
    finally { setBusy(false); }
  };
  return (
    <section className="msgr-setcard">
      <h2>{t('friends.title')} · {accepted.length}</h2><p>{t('friends.desc')}</p>
      {!manage && <><div className="msgr-friendlink">
        <div className="row">
          <span className="msgr-klabel">{t('friends.link.label')}</span>
          {link
            ? <><code className="msgr-code">{link.code.slice(0, 8)}…</code><button type="button" className="btn btn-primary sm" disabled={busy} onClick={copyLink}><I name="copy" size={13} />{t('friends.link.copy')}</button>
                <button type="button" className="btn sm ghost" disabled={busy} onClick={async () => { if (await call('msgr_friend_link_revoke', {}, t('friends.link.revoked'))) setLink(null); }}>{t('friends.link.revoke')}</button></>
            : <button type="button" className="btn sm" disabled={busy} onClick={showLink}><I name="link" size={13} />{t('friends.link.make')}</button>}
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (!busy) acceptLink(); }}>
          <input className="msgr-input sm" value={joinLink} disabled={busy} onChange={(e) => setJoinLink(e.target.value)} placeholder={t('friends.link.ph')} aria-label={t('friends.link.ph')} />
          <button type="submit" className="btn sm" disabled={busy || !joinLink.trim()}>{t('friends.link.add')}</button>
        </form>
      </div>
      <FriendFinder uid={uid} friends={friends} members={members} onChanged={onChanged} onDm={onDm} onPersonalDm={onPersonalDm} onNote={onNote} onError={onError} onBlock={setConfirmBlock} /></>}
      {received.length > 0 && (<><h3>{t('friends.received')} · {received.length}</h3><div className="msgr-rows">{received.map((f) => <div key={f.user_id} className="row"><Av name={nameOf(f)} size="sm" userId={f.user_id} /><span className="name">{nameOf(f)}</span><span className="sub">{fmtWhen(f.created_at, lang)}</span>
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => call('msgr_friend_decide', { other: f.user_id, accept: true }, t('friends.accepted'))}>{t('friends.accept')}</button>
        <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => call('msgr_friend_decide', { other: f.user_id, accept: false }, t('friends.declined'))}>{t('friends.decline')}</button></div>)}</div></>)}
      {sent.length > 0 && (<><h3>{t('friends.sent.h')} · {sent.length}</h3><div className="msgr-rows">{sent.map((f) => <div key={f.user_id} className="row"><Av name={nameOf(f)} size="sm" userId={f.user_id} /><span className="name">{nameOf(f)}</span><span className="sub">{t('friends.state.sent')}</span><button type="button" className="btn sm ghost" disabled={busy} onClick={() => call('msgr_friend_remove', { other: f.user_id, block: false }, t('friends.removed'))} title={t('friends.cancel')} aria-label={t('friends.cancel')}><I name="x" size={13} /></button></div>)}</div></>)}
      <h3>{t('friends.list')}</h3>
      <div className="msgr-rows">
        {!accepted.length && <p className="empty">{t('friends.none')}</p>}
        {accepted.map((f) => { const inOrg = members.some((m) => m.user_id === f.user_id); return (
          <div key={f.user_id} className="row"><Av name={nameOf(f)} size="sm" userId={f.user_id} /><span className="name">{nameOf(f)}</span><span className="sub">{[f.handle && `@${f.handle}`, !isPersonal && t(inOrg ? 'rail.friends.here' : 'friends.notHere')].filter(Boolean).join(' · ')}</span>
            {inOrg ? <button type="button" className="btn sm" onClick={() => onDm?.(f.user_id)}><I name="at" size={13} />{t('ui.dm')}</button> : onPersonalDm ? <button type="button" className="btn sm" onClick={() => onPersonalDm(f.user_id)}><I name="at" size={13} />{t('friends.dm')}</button> : <span className="msgr-klabel">{t('friends.inviteHint')}</span>}
            <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => setConfirmBlock(f)}><I name="block" size={13} />{t('friends.block')}</button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setRemoving(f)} title={t('friends.remove')} aria-label={t('friends.remove')}><I name="x" size={13} /></button>
          </div>); })}
      </div>
      <h3>{t('friends.blocked.h')}</h3>
      <div className="msgr-rows">
        {!blocked.length && <p className="empty">{t('friends.blocked.none')}</p>}
        {blocked.map((f) => (
          <div key={f.user_id} className="row">
            <Av name={nameOf(f)} size="sm" userId={f.user_id} />
            <span className="name">{nameOf(f)}</span>
            <span className="sub">{f.handle ? `@${f.handle}` : f.user_id.slice(0, 8)}</span>
            <button type="button" className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { await q(supabase.rpc('msgr_friend_unblock', { other: f.user_id })); onNote(t('friends.unblocked')); await refreshBlocked(); await onChanged?.(); } catch { onError(t('friends.unblock.failed')); } finally { setBusy(false); } }}>{t('friends.unblock')}</button>
          </div>
        ))}
      </div>
      <h3>{t('crew.muted.h')}</h3>
      <div className="msgr-rows">
        {!mutedCrews.length && <p className="empty">{t('crew.muted.none')}</p>}
        {mutedCrews.map((c) => (
          <div key={c.crew_id} className="row">
            <Av name={c.display_name || t('org.crew')} size="sm" crew crewId={c.crew_id} />
            <span className="name">{c.display_name || t('org.crew')}</span>
            <button type="button" className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { await unmuteCrew(c.crew_id); await loadMutedCrews(); } catch { onError(t('crew.unmute.failed')); } finally { setBusy(false); } }}>{t('crew.unmute')}</button>
          </div>
        ))}
      </div>
      {removing && createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t('friends.remove')}>
        <ConfirmModal title={t('friends.remove')} description={t('friends.remove.confirm', { name: nameOf(removing) })} confirmLabel={t('friends.remove')} busy={busy}
          onConfirm={async () => { const f = removing; await call('msgr_friend_remove', { other: f.user_id, block: false }, t('friends.removed.friend')); setRemoving(null); }} onClose={() => { if (!busy) setRemoving(null); }} />
      </div>, document.body)}
      {confirmBlock && createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t('friends.block')}>
        <ConfirmModal title={t('friends.block')} description={t('friends.block.confirm', { name: nameOf(confirmBlock) })} confirmLabel={t('friends.block')} busy={busy}
          onConfirm={async () => { const f = confirmBlock; await call('msgr_friend_remove', { other: f.user_id, block: true }, t('friends.blocked')); setConfirmBlock(null); await refreshBlocked(); }} onClose={() => { if (!busy) setConfirmBlock(null); }} />
      </div>, document.body)}
    </section>
  );
}

/* ─── 검색 결과 페이지 — 메시지(본문 부분 일치, 이 조직·읽을 수 있는 채널만)·사람·에이전트·채널. 전문 검색(tsvector)은 규모가 커지면 v2. ─── */
function SearchPage({ res, busy = false, channels, crews, nameOfUser, dmName, onOpen, onCrew, onDm, onBack, onMenu, phoneQ = null }) {
  const { t, lang } = useT();
  const phone = useIsPhone();
  const { blocked, mutedCrewIds } = useContext(SafetyCtx); // 차단한 사람·숨긴 크루의 글은 검색 결과에서 뺀다(검수 M4)
  if (res) res = { ...res, msgs: res.msgs.filter((m) => !(m.author_kind === 'user' && blocked.has(m.author_user_id)) && !(m.author_kind === 'crew' && mutedCrewIds.has(m.crew_id))) };
  const chName = (id) => { const c = channels.find((x) => x.id === id); return !c ? '' : c.kind === 'dm' ? dmName(c) : `#${c.name}`; };
  const who = (m) => m.author_kind === 'crew' ? (crews.find((c) => c.id === m.crew_id)?.display_name ?? t('org.crew')) : nameOfUser(m.author_user_id);
  const mark = (text) => { if (!res?.q) return text; const i = text.toLowerCase().indexOf(res.q.toLowerCase()); if (i < 0) return text.slice(0, 160); const s = Math.max(0, i - 40); return <>{s > 0 ? '…' : ''}{text.slice(s, i)}<mark>{text.slice(i, i + res.q.length)}</mark>{text.slice(i + res.q.length, i + res.q.length + 120)}</>; };
  const total = res ? res.msgs.length + res.people.length + res.agents.length + res.channels.length : 0;
  const view = searchView({ res, busy, total, phone }); // 안내 선택은 search-view.mjs
  return (<>
    <div className="msgr-top">
      <NavButton onMenu={onMenu} />
      <span className="title"><I name="search" size={18} />{t('search.title')}{res && <span className="msgr-klabel">“{res.q}” · {t(res.more ? 'search.countMore' : 'search.count', { n: total })}</span>}</span>
      <button type="button" className="btn sm msgr-backchat" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread page"><div className="msgr-inbox msgr-searchres">
      {phone && phoneQ && <form className="ph-search ph-search-page" role="search" onSubmit={(e) => { e.preventDefault(); phoneQ.run(phoneQ.q); e.currentTarget.querySelector('input')?.blur(); }}><I name="search" size={16} /><input value={phoneQ.q} onChange={(e) => phoneQ.set(e.target.value)} placeholder={t('search.ph.phone')} aria-label={t('search.title')} enterKeyHint="search" /></form>}{/* 폰: 떠 있던 검색 칸(아래 탭 바 안)을 없애 결과 맨 위에 둔다 */}
      {view.loading && <p className="empty" role="status">{t('ui.loading')}</p>}
      {view.hintKey && <p className="empty">{t(view.hintKey)}</p>}
      {view.noticeKey && <p className="note danger" role="alert">{t(view.noticeKey)}</p>}
      {view.noneKey && <p className="empty">{t(view.noneKey)}</p>}
      {res?.channels.length > 0 && <><div className="msgr-klabel">{t('search.channels')}</div><div className="msgr-chips">{res.channels.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => onOpen(c.id)}><I name={c.kind === 'private' ? 'lock' : 'hash'} size={13} /><span>{c.name}</span></button>)}</div></>}
      {res?.people.length > 0 && <><div className="msgr-klabel">{t('search.people')}</div><div className="msgr-chips">{res.people.map((m) => <button key={m.user_id} type="button" className="msgr-chan" onClick={() => onDm(m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div></>}
      {res?.agents.length > 0 && <><div className="msgr-klabel">{t('search.agents')}</div><div className="msgr-chips">{res.agents.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => onCrew(c.id)}><I name="star" size={13} /><span>{c.display_name}</span></button>)}</div></>}
      {res?.msgs.length > 0 && <div className="msgr-klabel">{t('search.messages')} · {res.msgs.length}</div>}
      {res?.msgs.map((m) => (
        <button key={m.id} type="button" className="msgr-inboxrow" onClick={() => onOpen(m.channel_id, m.id)}>
          <Av name={who(m)} crew={m.author_kind === 'crew'} size="sm" crewId={m.author_kind === 'crew' ? m.crew_id : null} userId={m.author_kind === 'crew' ? null : m.author_user_id} />
          <span className="body"><span className="line1"><b>{who(m)}</b><span className="msgr-klabel">{chName(m.channel_id)} · {fmtWhen(m.created_at, lang)}</span></span><span className="text">{mark(m.body ?? '')}</span></span>
        </button>
      ))}
    </div></div>
  </>);
}

const INBOX_KINDS = ['all', 'mention', 'reply', 'approval', 'dm'];
function Inbox({ items, prevSeen = 0, initialKind = 'all', channels, crews, nameOfUser, dmName, onOpen, onReadAll, onBack, onMenu }) {
  const { t, lang } = useT();
  const [kind, setKind] = useState(initialKind); // 페이지가 바뀌면 통째로 다시 그려지므로 초기값으로 충분하다
  const [unreadOnly, setUnreadOnly] = useState(true); // 기본은 읽지 않은 것만 — 읽은 항목은 '지난 알림 보기'로(유건 2026-09-11 밤)
  const chName = (id) => { const c = channels.find((x) => x.id === id); return !c ? '' : c.kind === 'dm' ? dmName(c) : `#${c.name}`; };
  const who = (it) => it.whoKind === 'crew' ? (crews.find((c) => c.id === it.who)?.display_name ?? t('org.crew')) : it.whoKind === 'system' ? t('inbox.system.actor') : it.friendName || nameOfUser(it.who); // 친구 요청은 보낸 사람이 조직 구성원이 아니라 요청 행의 이름을 쓴다, 회사 공지는 고정 이름
  const isNew = (it) => Date.parse(it.at) > prevSeen;
  // 내가 결정할 대기 참여 요청은 읽음과 무관하게 남긴다 — 결정하면 목록에서 빠진다. 시각 기준만 쓰면, 채팅을 연 사람이 나가 결재자가 된
  // 사람은 그 전에 알림함을 연 적이 있으면 넘겨받은 요청(더 이른 시각)을 영영 못 봤다(픽스처 실측 2026-09-18, 20260918170000).
  const pendingMine = (it) => !!it.joinReq;
  const unreadOf = (k) => items.filter((it) => it.kind === k && (isNew(it) || pendingMine(it))).length; // 탭 숫자는 읽지 않은 것(D37) — 총수면 모두 읽어도 숫자가 남았다
  const shown = items.filter((it) => (kind === 'all' || it.kind === kind) && (!unreadOnly || isNew(it) || pendingMine(it)));
  const readCount = items.filter((it) => (kind === 'all' || it.kind === kind) && !isNew(it) && !pendingMine(it)).length;
  const phone = useIsPhone();
  return (<>
    <div className="msgr-top">
      <NavButton onMenu={onMenu} />
      <span className="title"><I name="bell" size={18} />{t('inbox.title')}</span>
      {/* 모두 읽음 — 이 기기의 읽음 기준선을 지금으로(새 표시가 걷힌다). 메뉴엔 자리가 없어 머리에(유건 2026-09-11) */}
      <button type="button" className="btn sm msgr-readall" style={{ marginLeft: 'auto' }} onClick={onReadAll} disabled={!items.some((it) => Date.parse(it.at) > prevSeen)}><I name="check" size={13} />{t('inbox.readAll')}</button>
      <button type="button" className="btn sm msgr-backchat" onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread page"><div className="msgr-inbox">
      {phone && <h1 className="msgr-bigtitle">{t('inbox.title')}</h1>}
      <Seg kind="tab" label={t('inbox.title')} value={kind} onPick={setKind} options={INBOX_KINDS.map((k) => ({ v: k, label: t(`inbox.kind.${k}`), n: !phone && k !== 'all' && unreadOf(k) > 0 ? unreadOf(k) : null }))} />
      {phone && <p className="msgr-inboxcounts">{t('inbox.count', { kind: t(`inbox.kind.${kind}`), n: shown.length })}</p>} {/* 폰: 탭 속 숫자 대신 탭 아래 한 줄 — 고른 탭의 개수(유건 2026-09-11) */}
      {!shown.length && <p className="empty">{unreadOnly && readCount ? t('inbox.allRead') : t('inbox.empty')}</p>}
      {readCount > 0 && <button type="button" className="btn sm msgr-inboxtoggle" onClick={() => setUnreadOnly((v) => !v)}>{unreadOnly ? t('inbox.showRead', { n: readCount }) : t('inbox.unreadOnly')}</button>}
      {shown.map((it) => (
        <button key={it.key} type="button" className={`msgr-inboxrow${Date.parse(it.at) > prevSeen ? ' new' : ''}`} onClick={() => onOpen(it.channel_id, it)}>
          <Av name={who(it)} crew={it.whoKind === 'crew'} size="sm" crewId={it.whoKind === 'crew' ? it.who : null} userId={it.whoKind === 'crew' ? null : it.who} />
          <span className="body"><span className="line1"><b>{who(it)}</b><span className="msgr-klabel">{[t(`inbox.kind.${it.kind}`), chName(it.channel_id), fmtWhen(it.at, lang)].filter(Boolean).join(' · ')}</span></span><span className="text">{it.text.slice(0, 160)}</span></span>
        </button>
      ))}
      <p className="note">{t('inbox.note')}</p>
    </div></div>
  </>);
}

function Settings({ session, me, uid, invitesTick = 0, org, orgs = [], isAdmin, gated = false, policy, ent = null, members = [], nameOfUser, onOpenCrew, onAvatar, onProfileSaved, friends = [], onFriendsChanged, onDm, onPersonalDm, channels = [], onInvite = null, initialTab = null, onTabUsed, onChanged, onOrgsChanged, onNote, onError, onBack, onMenu, phoneView = null, onSub = null, crews = [], myName: myProfileName = null, myAgents = null, onOpenAgent = null, onOrgSub = null, onPickOrg = null, onOrgAdmin = null, onToggleMemory = null, spaceReady = true, memSort = 'recent', onMemSort = null, focusGroup = null, onFocusUsed = null, chOrgId = null }) { // phoneView(폰만): 'list' = 내 설정 줄 목록, 'profile'|'notify'|'display'|'friends'|'privacy'|'about' = 하위 화면, 'org' = 조직 설정
  const { signOut, signingOut, accountDeleted } = useContext(SignOutContext);
  const avLooks = useContext(AvatarCtx).looks; // 내 에이전트 목록의 사진 — 같은 에이전트 기준(유건 2026-10-05)
  const { t, ta, lang, setLang } = useT();
  const { theme, setTheme } = useTheme();
  const family = FAMILIES.map(([f]) => f).find((f) => theme === f || theme.startsWith(`${f}-`)) ?? null;
  const mode = family ? theme.slice(family.length) : null;
  const skins = THEMES.filter((c) => !FAMILY_CODES.includes(c));
  // 검수 M-5(2026-09-27) — 동의 전엔 '내 계정' 탭(동의 카드가 있는 곳)만 연다. 멤버·조직·에이전트 탭은 조직 내용이다.
  const tabs = gated ? [['me', 'set.tab.me']] : [org && ['members', 'set.tab.members'], org && ['org', 'set.tab.org'], org && ['crews', 'set.tab.crews'], ['friends', 'set.tab.friends'], ['me', 'set.tab.me']].filter(Boolean); // 친구는 설정의 별도 분류(유건 지시 2026-09-09) // 기록은 활동 페이지(트리+그래프)로 — 유건 지시 2026-09-04 // UX 2/3: 세로 3천px 카드 더미 대신 탭 — 자주 쓰는 멤버가 첫 화면
  const [tab, setTab] = useState(org ? 'members' : 'me');
  const [isOps, setIsOps] = useState(false); // 운영자(msgr_report_operators)만 '운영 신고함'을 본다
  useEffect(() => { let live = true; q(supabase.rpc('msgr_is_report_operator')).then((v) => { if (live) setIsOps(v === true); }).catch(() => {}); return () => { live = false; }; }, [uid]);
  useEffect(() => { if (initialTab) { setTab(gated ? 'me' : initialTab); onTabUsed?.(); } }, [initialTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (gated) { setTab('me'); return; } if (!tabs.some(([k]) => k === tab)) setTab(tabs[0][0]); }, [org?.id, isAdmin, gated]); // eslint-disable-line react-hooks/exhaustive-deps
  const phone = useIsPhone();
  const setNavRef = useRef(null);
  // 폰 폭의 탭 줄은 가로 스크롤 — 들어오자마자(또는 탭이 바뀔 때) 활성 탭이 줄 밖이면 가운데로 가져온다. 영어 360px에서 '내 계정'이 줄 오른쪽 밖에 있어 어느 탭인지 안 보였다(LA-11). 줄 안에서만 움직인다(페이지 세로 스크롤은 건드리지 않는다)
  useLayoutEffect(() => { const nav = setNavRef.current; const on = nav?.querySelector('button.on, button.active'); if (!nav || !on) return; const n = nav.getBoundingClientRect(); const b = on.getBoundingClientRect(); nav.scrollLeft = scrollLeftToCenter({ navLeft: n.left, navWidth: n.width, btnLeft: b.left, btnWidth: b.width, scrollLeft: nav.scrollLeft, scrollWidth: nav.scrollWidth }); }, [tab, tabs.length, phone]);
  useLayoutEffect(() => { if (!phone || phoneView !== 'list' || !focusGroup) return; document.querySelector(`.ph-setlist [data-group="${focusGroup}"]`)?.scrollIntoView({ block: 'start' }); onFocusUsed?.(); }, [phone, phoneView, focusGroup]); // eslint-disable-line react-hooks/exhaustive-deps
  const langCard = (<section className="msgr-setcard">
            <h2>{t('set.lang')}</h2>
            <Seg label={t('set.lang')} value={lang} onPick={setLang} options={[{ v: 'ko', label: '한국어' }, { v: 'en', label: 'English' }]} />
          </section>);
  const themeCard = (<section className="msgr-setcard">
            <h2>{t('set.theme')}</h2>
            <div className="row">
              <span className="msgr-klabel">{t('set.family')}</span>
              <Seg label={t('set.family')} value={family} onPick={(f) => setTheme(`${f}${mode ?? ''}`)} options={FAMILIES.map(([f, label]) => ({ v: f, label: ta(label) }))} />
            </div>
            <div className="row">
              <span className="msgr-klabel">{t('set.mode')}</span>
              <Seg label={t('set.mode')} value={family != null ? mode : null} onPick={(sfx) => setTheme(`${family ?? 'linen'}${sfx}`)} options={MODES.map(([sfx, label]) => ({ v: sfx, label: t(label) }))} />
            </div>
            <div className="row">
              <span className="msgr-klabel">{t('set.skins')}</span>
              <div className="msgr-chips">{skins.map((c) => <button key={c} type="button" className={`msgr-chan${theme === c ? ' active' : ''}`} onClick={() => setTheme(c)} title={ta(`settings.theme.${c}`)}><span>{ta(`settings.theme.${c}`).split(' — ')[0]}</span></button>)}</div>
            </div>
          </section>);
  // ── 폰 설정(유건 확정 10/1 + 피드백 5·9): 톱니는 어느 탭에서 눌러도 같은 '설정' 한 화면 — 개인 / 조직(조직마다 한 줄) / 에이전트 / 서버 / 기억 / 공통 묶음.
  //    조직 범위 하위 화면(org·server·ext·memory:<조직 id>)은 그 조직 공간으로 바꾼 뒤 그린다 — 목록·정책·내 표시명이 그 조직 것이어야 해서.
  if (phone && phoneView) {
    const head = (title) => (<div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{title}</span><button type="button" className="btn sm msgr-backchat" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button></div>);
    const body = (title, children) => (<>{head(title)}<div className="msgr-thread page"><div className="msgr-settings ph-settings">{children}</div></div></>);
    const view = phoneView;
    // 조직 화면(4차 피드백): 줄은 하나, 화면 맨 위 '조직 이름 ▾'로 조직을 고른다 — 그리는 조직 = 지금 공간(고르면 앱 전체 공간이 바뀐다)
    const os = orgScreen(view === 'orgadmin' ? 'org' : view, { orgs, orgId: org?.id ?? null });
    const ready = !!os.org && spaceReady && !gated;
    const pick = <SetOrgPick orgs={orgs} org={os.org ?? orgs.find((o) => o.id === chOrgId) ?? null} multi={os.multi} onPick={onPickOrg} />;
    const waiting = <section className="msgr-setcard"><p className="note" role="status">{gated && os.org ? t('org.noEdit') : t('ui.loading')}</p></section>;
    const lockedWhy = os.org && <section className="msgr-setcard"><p className="ph-lockwhy" role="status"><I name="lock" size={13} />{t('phone.set.adminOnly.why', { role: t(`role.${os.org.role}`) })}</p></section>;
    const chev = <I name="caret" size={14} className="ph-chev" />;
    const row = (key, icon, label, onClick, sub = null, extra = null) => (<button key={key} type="button" className="ph-setrow" onClick={onClick}><span className="ph-setic">{icon}</span><span className="ph-kbody"><span className="name">{label}</span>{sub && <span className="snip">{sub}</span>}</span>{extra}{chev}</button>);
    const ic = (name) => <I name={name} size={17} />;
    if (view === 'orgadmin') { // 조직 설정(관리자) — 조직 정보·멤버·정책·기록
      const otabs = [['org', 'set.tab.org'], ['members', 'set.tab.members'], ['policy', 'set.policy'], isAdmin && ['log', 'set.tab.audit']].filter(Boolean);
      const ot = otabs.some(([k]) => k === tab) ? tab : 'org';
      return body(t('phone.org.settings'), !org || gated ? <>{pick}<section className="msgr-setcard"><p>{t('org.noEdit')}</p></section></> : (<>{pick}
        <Seg kind="tab" className="ph-settabs" ref={setNavRef} label={t('phone.org.settings')} value={ot} onPick={setTab} options={otabs.map(([k, label]) => ({ v: k, label: t(label) }))} />
        <div className="msgr-setbody">
          {ot === 'members' && (isAdmin
            ? <OrgCard part="members" invitesTick={invitesTick} org={org} uid={uid} members={members} channels={channels} onInvite={onInvite} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />
            : <PhoneMembers org={org} uid={uid} members={members} onNote={onNote} onError={onError} />)}
          {ot === 'org' && (isAdmin
            ? <OrgCard part="org" org={org} uid={uid} members={members} ent={ent} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} myEmail={session.user.email} />
            : <section className="msgr-setcard"><h2>{t('set.org')}</h2><p>{t('org.noEdit')}</p></section>)}
          {ot === 'org' && <ReportsCard org={org} uid={uid} isAdmin={!!isAdmin} members={members} nameOfUser={nameOfUser} channels={channels} onNote={onNote} onError={onError} />}
          {ot === 'policy' && policy && <PolicyCard org={org} isAdmin={isAdmin} policy={policy} members={members} onChanged={onChanged} onNote={onNote} onError={onError} />}
          {ot === 'log' && <OrgAuditCard org={org} channels={channels} crews={crews} nameOfUser={nameOfUser} onError={onError} />}
        </div>
      </>));
    }
    if (view === 'org') return body(t('phone.set.orgRow'), <>{pick}{!ready ? waiting : (<div className="msgr-setbody">
      <OrgProfileCard org={org} me={me} uid={uid} onChanged={onChanged} onNote={onNote} onError={onError} />
      {isAdmin && <div className="ph-setgroup">{row('admin', ic('gear'), t('phone.org.settings'), () => onOrgAdmin?.(), t('phone.set.orgAdmin.sub'))}</div>}
      <MemberListCard org={org} uid={uid} members={members} onNote={onNote} onError={onError} t={t} editSelf={false} />
    </div>)}</>);
    if (view === 'server') return body(t('phone.set.server'), <>{pick}{!ready ? waiting : os.locked ? lockedWhy : (<div className="msgr-setbody">
      <OrgCard key={org.id} part="node" org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />
    </div>)}</>);
    if (view === 'ext') return body(t('phone.set.ext'), <>{pick}{!ready ? waiting : os.locked ? lockedWhy : (<div className="msgr-setbody">
      <OrgCard key={org.id} part="agents" org={org} orgs={orgs} uid={uid} members={members} channels={channels} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} onOpenCrew={onOpenCrew} />
    </div>)}</>);
    if (view === 'memory') return body(t('phone.set.agentMemory'), <>{pick}{!ready ? waiting : (<div className="msgr-setbody">
      <MemoryChannelsCard channels={channels} uid={uid} isAdmin={!!isAdmin} locked={!!policy?.crew_memory_locked} onToggle={onToggleMemory} />
      {policy && <PolicyCard part="memory" org={org} isAdmin={isAdmin} policy={policy} members={members} onChanged={onChanged} onNote={onNote} onError={onError} />}
    </div>)}</>);
    if (view === 'agents') return body(t('phone.set.myAgents'), (<div className="msgr-setbody">
      <section className="msgr-setcard"><p>{t('phone.set.myAgents.desc')}</p>
        {myAgents === null ? <p className="note" role="status">{t('ui.loading')}</p> : !myAgents.length ? <p className="empty">{t('phone.agents.none')} <RunnerButton /></p> : (
          <div className="ph-setgroup">{groupAgents(myAgents, { orgOrder: orgs.map((o) => o.id) }).map((g) => (/* 같은 에이전트는 한 줄(에이전트 탭과 같은 판정 — agent-groups.mjs). 에이전트 = 한 사람(2026-10-03): 공간 글자·공간 고르기 없음, 줄 = 지금 공간(없으면 첫 공간)의 카드 */
            <button key={g.key} type="button" className="ph-setrow" onClick={() => onOpenAgent?.(g)}><Av name={g.display_name} crew size="sm" crewId={g.id} src={agentLook(g.id, avLooks, null, g.avatar_url ?? null).photo ?? null} /><span className="ph-kbody"><span className="name">{g.display_name}</span>{g.ext && <span className="snip">{t('agentcard.ext')}</span>}</span>{chev}</button>))}</div>)}
      </section>
    </div>));
    const sub = view === 'list' ? null : view;
    const myName = myProfileName || session.user.email; // 개인 프로필 이름 — 지금 공간(조직 표시명)에 따라 바뀌지 않게
    const orow = settingsOrgRows(orgs); // 조직이 몇 개든 네 가지는 각각 한 줄 — 조직은 들어간 화면의 '조직 이름 ▾'로 고른다(4차 피드백)
    const group = (key, title, children) => (<section className="ph-setsec" data-group={key}><h3 className="ph-setgh">{title}</h3><div className="ph-setgroup">{children}</div></section>);
    if (!sub) return body(t('ui.settings'), (<div className="ph-setlist">
      {group('me', t('phone.set.g.me'), <button type="button" className="ph-setme" onClick={() => onSub?.('profile')}><Av name={myName} size="lg" userId={uid} /><span className="ph-kbody"><span className="name">{myName}</span><span className="snip">{t('phone.set.profile')} · {session.user.email}</span></span>{chev}</button>)}
      {group('orgs', t('phone.set.g.orgs'), orow.org ? row('org', ic('person'), t('phone.set.orgRow'), () => onOrgSub?.('org'), t('phone.set.orgRow.sub')) : <p className="ph-setnote">{t('phone.set.noOrg')}</p>)}
      {group('agents', t('phone.set.g.agents'), <>
        {row('mine', ic('memory'), t('phone.set.myAgents'), () => onSub?.('agents'), t('phone.set.myAgents.sub'))}
        {orow.ext && row('ext', ic('node'), t('phone.set.ext'), () => onOrgSub?.('ext'), t('phone.set.ext.sub'))}
      </>)}
      {orow.server && group('server', t('phone.set.g.server'), row('server', ic('node'), t('phone.set.server'), () => onOrgSub?.('server'), t('phone.set.server.sub')))}
      {orow.memory && group('memory', t('phone.set.g.memory'), row('memory', ic('folder'), t('phone.set.agentMemory'), () => onOrgSub?.('memory'), t('phone.set.agentMemory.sub')))}
      {group('common', t('phone.set.g.common'), <>
        {[['display', 'gear'], ['notify', 'bell'], ['friends', 'person'], ['privacy', 'lock'], ['about', 'doc']].map(([k, i]) => row(k, ic(i), t(`phone.set.${k}`), () => onSub?.(k)))}
        <button type="button" className="ph-setrow danger" disabled={signingOut} onClick={signOut}><span className="ph-setic">{ic('out')}</span><span className="name">{t('auth.signOut')}</span></button>
      </>)}
    </div>));
    return body(t(`phone.set.${sub}`), (<>
        {sub === 'profile' && (<div className="msgr-setbody">
          <section className="msgr-setcard"><h2>{t('set.account')}</h2><div className="row"><Av name={myName} userId={uid} /><span className="msgr-klabel">{session.user.email}</span></div></section>
          <ProfileCard part="profile" uid={uid} onNote={onNote} onError={onError} onAvatar={onAvatar} onSaved={onProfileSaved} />
          <AccountDeleteCard session={session} onDeleted={accountDeleted} />
        </div>)}
        {sub === 'notify' && (<div className="msgr-setbody">
          <section className="msgr-setcard"><h2>{t('phone.set.notify')}</h2><div className="row"><NotifyRow /><SoundRow /></div><p className="note">{t('phone.set.notify.scope')}</p></section>
          <ProfileCard part="quiet" uid={uid} onNote={onNote} onError={onError} />
        </div>)}
        {sub === 'display' && <div className="msgr-setbody">{themeCard}{langCard}</div>}
        {sub === 'friends' && <PhoneFriendsManage uid={uid} friends={friends} onChanged={onFriendsChanged} onPersonalDm={onPersonalDm} onNote={onNote} onError={onError} />}
        {sub === 'privacy' && (<div className="msgr-setbody">
          <ProfileCard part="privacy" uid={uid} onNote={onNote} onError={onError} />
          <section className="msgr-setcard"><h2>{t('set.profanityFilter')}</h2><p>{t('set.profanityFilter.desc')}</p><ProfanityFilterRow /></section>
          <section className="msgr-setcard"><h2>{t(orgs.length ? 'consent.ai.title' : 'consent.ai.personal.title')}</h2><AiConsentRow t={t} onError={onError} hasOrg={orgs.length > 0} /></section>
          <ReportsCard mode={isOps ? 'ops' : 'personal'} org={null} uid={uid} members={[]} nameOfUser={nameOfUser} channels={[]} onNote={onNote} onError={onError} />
        </div>)}
        {sub === 'about' && (<div className="msgr-setbody">
          <section className="msgr-setcard"><h2>{t('phone.set.about')}</h2><LegalLinks t={t} className="in-card" /><p className="msgr-klabel msgr-version">{t('set.version', { v: APP_VERSION })}</p></section>
          <section className="msgr-setcard msgr-diagcard"><h2>{t('set.diag')}</h2><p>{t('set.diag.desc')}</p><DiagRow /></section>
        </div>)}
    </>));
  }
  return (<>
    <div className="msgr-top">
      <NavButton onMenu={onMenu} />
      <span className="title"><I name="gear" size={18} />{t('ui.settings')}</span>
      <button type="button" className="btn sm msgr-backchat" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread page"><div className="msgr-settings tabs">
      <nav className="msgr-setnav" ref={setNavRef} aria-label={t('ui.settings')}>
        {tabs.map(([k, label]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{t(label)}</button>)}
      </nav>
      <div className="msgr-setbody">
        {tab === 'members' && org && !gated && (isAdmin
          ? <OrgCard part="members" invitesTick={invitesTick} org={org} uid={uid} members={members} channels={channels} onInvite={onInvite} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />
          : <MemberListCard org={org} uid={uid} members={members} onNote={onNote} onError={onError} t={t} />)}
        {tab === 'org' && org && !gated && (isAdmin
          ? <OrgCard part="org" org={org} uid={uid} members={members} ent={ent} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} myEmail={session.user.email} />
          : <section className="msgr-setcard"><h2>{t('set.org')}</h2><p>{t('org.noEdit')}</p></section>)}
        {tab === 'org' && org && !gated && <ReportsCard org={org} uid={uid} isAdmin={!!isAdmin} members={members} nameOfUser={nameOfUser} channels={channels} onNote={onNote} onError={onError} />}
        {tab === 'crews' && org && !gated && (<>
          {isAdmin && <OrgCard part="node" org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />}
          {isAdmin && <OrgCard part="agents" org={org} orgs={orgs} uid={uid} members={members} channels={channels} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} onOpenCrew={onOpenCrew} />}
          {policy && <PolicyCard org={org} isAdmin={isAdmin} policy={policy} members={members} onChanged={onChanged} onNote={onNote} onError={onError} />}
        </>)}
        {tab === 'friends' && !gated && <FriendsCard isPersonal={!org} uid={uid} friends={friends} members={members} onChanged={onFriendsChanged} onDm={onDm} onPersonalDm={onPersonalDm} onNote={onNote} onError={onError} />}
        {tab === 'me' && (<>
          <section className="msgr-setcard">
            <h2>{t('set.account')}</h2><p>{t(org ? 'set.account.desc' : 'set.account.desc.personal')}</p>
            <div className="row"><Av name={me?.display_name || session.user.email} userId={uid} />{(org || me?.display_name) && <span style={{ fontWeight: 600 }}>{me?.display_name || '—'}</span>}<span className="msgr-klabel">{session.user.email}</span></div>
            {org && me && <DisplayNameRow org={org} me={me} onChanged={onChanged} onNote={onNote} onError={onError} />}
            <div className="row"><NotifyRow /><SoundRow /><button type="button" className="btn sm" disabled={signingOut} onClick={signOut}><I name="out" size={13} />{t('auth.signOut')}</button></div>
            <LegalLinks t={t} className="in-card" />
            <p className="msgr-klabel msgr-version">{t('set.version', { v: APP_VERSION })}</p>{/* 지금 앱 버전(UXM-26) — 문의·업데이트 확인 때 */}
          </section>
          <section className="msgr-setcard">
            <h2>{t('set.profanityFilter')}</h2><p>{t('set.profanityFilter.desc')}</p>
            <ProfanityFilterRow />
          </section>
          <section className="msgr-setcard">
            <h2>{t(org || orgs.length ? 'consent.ai.title' : 'consent.ai.personal.title')}</h2>{/* 검수 L-1(2026-09-27) — 게이트와 같은 제목으로 통일. 조직이 하나도 없으면 개인 공간 게이트의 제목(조직 문구 없음 — UX 점검 D) */}
            <AiConsentRow t={t} onError={onError} hasOrg={!!org || orgs.length > 0} />
          </section>
          <ProfileCard uid={uid} onNote={onNote} onError={onError} onAvatar={onAvatar} onSaved={onProfileSaved} />
          <ReportsCard mode={isOps ? 'ops' : 'personal'} org={org} uid={uid} members={members} nameOfUser={nameOfUser} channels={channels} onNote={onNote} onError={onError} />
          {langCard}
          {themeCard}
          <section className="msgr-setcard msgr-diagcard">{/* 진단은 문제 신고용 — 계정·알림 설정과 섞이지 않게 맨 아래 별도 카드(유건 2026-09-14) */}
            <h2>{t('set.diag')}</h2><p>{t('set.diag.desc')}</p>
            <DiagRow />
          </section>
          <AccountDeleteCard session={session} onDeleted={accountDeleted} />
        </>)}
      </div>
    </div></div>
  </>);
}


/* ─── 활동 페이지(유건 지시 2026-09-04): 아르고 "기억"처럼 — 왼쪽은 조직 → 채널 → 사람·크루·문서 트리, 오른쪽은 같은 룩의 관계 그래프,
   고른 대상의 활동은 문장으로("유건이 민수를 관리자로 바꿈"). 정본은 서버 감사 로그(msgr_audit_log) — 화면은 이름으로 치환만 한다. ─── */
const docRelOf = (d) => `docs/${d.channel_id ?? 'org'}/${d.path.replace(/\.md$/, '')}`; // 문서 → 그래프·탭 id(한 곳). 채널을 넣는다 — 일지는 채널마다 같은 경로(journal/날짜)라 경로만으론 충돌(검수 #551 HIGH-1)

/* 기억 문서 보기·편집(대상 탭) — 조직 문서 = 조직의 기억(부록 G). 편집권 최종 판정은 RLS(전사=관리자·채널=쓰기 가능 멤버) */
function MemDoc({ doc, isAdmin, nameOfUser, chName, onSaved, onNote, onError, related = [], onOpen = null, onWiki = null }) {
  const { t, lang } = useT();
  const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setEdit(null); }, [doc.id]);
  const canEdit = (d) => (d.channel_name ? false : d.channel_id ? true : isAdmin); // 장 열람 문서(channel_name — RPC)는 읽기만(편집 권한은 채널 멤버)
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_docs').update({ title: edit.title.trim(), body: edit.body }).eq('id', doc.id).select('id');
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
    if (!res.data?.length) return onError(t('docs.noEdit'));
    onNote(t('docs.saved')); setEdit(null); await onSaved();
  };
  return (
    <article className="msgr-memdoc">
      <header>
        <span className="msgr-klabel">{doc.channel_id ? `${chName(doc.channel_id)} · ${doc.path}` : doc.path}</span>
        {edit ? <input className="msgr-input" value={edit.title} onChange={(e) => setEdit((x) => ({ ...x, title: e.target.value }))} /> : <h2>{doc.title}</h2>}
        <div className="meta">{t('docs.meta', { v: doc.version, name: nameOfUser(doc.updated_by), when: fmtTs(doc.updated_at, lang) })}
          {!edit && canEdit(doc) && <button type="button" className="btn sm" onClick={() => setEdit({ title: doc.title, body: doc.body ?? '' })}>{t('docs.edit')}</button>}
          {!edit && !canEdit(doc) && <span className="note">{t('docs.adminOnly')}</span>}
        </div>
      </header>
      {edit ? (<>
        <textarea className="msgr-input body" value={edit.body} onChange={(e) => setEdit((x) => ({ ...x, body: e.target.value }))} rows={16} />
        <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !edit.title.trim()} onClick={save}><I name="check" size={13} />{t('ui.save')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => setEdit(null)}>{t('ui.cancel')}</button></div>
      </>) : (doc.body ? <div className="msgr-sheet"><Markdown text={doc.body} onWikiLink={onWiki ?? undefined} /></div> : <p className="empty">{t('docs.blank')}</p>)}
      {!edit && related.length > 0 && <section className="msgr-related"><div className="msgr-klabel">{t('docs.related')}</div>
        <ul>{related.map((r) => <li key={r.doc.id}><button type="button" className="msgr-namebtn" onClick={() => onOpen?.(r.doc)}>{r.dir === 'in' ? '← ' : '→ '}{r.doc.title}</button><span className="note">{chName(r.doc.channel_id) && r.doc.channel_id ? `${chName(r.doc.channel_id)} · ` : ''}{t(`docs.related.${r.reason}`)}</span></li>)}</ul>
      </section>}
    </article>
  );
}
/* 새 기억 — 범위(전사/채널)는 열린 탭이 정한다. 종류(규칙집·용어집·프로젝트)만 고른다 */
function MemNew({ org, channelId, uid, onCreated, onNote, onError, onCancel }) {
  const { t } = useT();
  const [creating, setCreating] = useState({ folder: channelId ? 'projects' : 'rules', title: '' }); const [busy, setBusy] = useState(false);
  const create = async () => {
    const title = creating.title.trim(); if (!title) return;
    setBusy(true);
    // 같은 경로(영문·숫자 슬러그가 겹침 — "B 채널 메모"·"B 회의록" 둘 다 b)면 -2, -3…으로 다음 경로를 쓴다(D13)
    const res = await insertWithFreePath(creating.folder, title, (path) => supabase.from('msgr_org_docs').insert({ org_id: org.id, channel_id: channelId ?? null, path, title, body: '', created_by: uid, updated_by: uid }).select('id, path').single());
    setBusy(false);
    if (res.error) return onError(isPathTaken(res.error.message) ? t('docs.dup') : friendlyErr(res.error.message, t));
    onNote(t('docs.created')); await onCreated(res.data);
  };
  return (
    <div className="msgr-memnew">
      <div className="row"><span className="msgr-klabel">{t('docs.folder')}</span>
        <Seg label={t('docs.folder')} value={creating.folder} onPick={(f) => setCreating((c) => ({ ...c, folder: f }))} options={DOC_FOLDERS.filter((f) => f !== 'journal').map((f) => ({ v: f, label: t(`docs.folder.${f}`) }))} /></div>
      <input className="msgr-input" placeholder={t('docs.new.placeholder')} value={creating.title} onChange={(e) => setCreating((c) => ({ ...c, title: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} autoFocus />
      <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !creating.title.trim()} onClick={create}><I name="check" size={13} />{t('docs.create')}</button><button type="button" className="btn sm" onClick={onCancel}>{t('ui.cancel')}</button></div>
    </div>
  );
}

// 신고함(App Store 1.2 UGC) — 관리자는 조직 신고 전부를 보고 처리한다. 멤버는 자기 신고와 처리 상태만 본다(msgr_reports_list가 가른다)
function ReportsCard({ org, uid, isAdmin = false, mode = 'org', members = [], nameOfUser, channels = [], onNote, onError }) { // mode: org(조직 탭) · ops(운영자 — 전부) · personal(내 개인 공간 신고)
  const { t, lang } = useT();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const chName = (id) => { const c = channels.find((x) => x.id === id); return c ? (c.kind === 'dm' ? c.name : `#${c.name}`) : ''; };
  const who = (id) => (id === uid ? t('ui.me') : (members.find((m) => m.user_id === id)?.display_name || nameOfUser(id) || id?.slice(0, 8)));
  const load = useCallback(async () => {
    const rows = await q(supabase.rpc('msgr_reports_list'));
    const all = rows ?? []; // RPC는 내가 관리하는 모든 조직 + 내 신고(+운영자면 전부)를 준다 — 화면마다 거른다
    setRows(mode === 'ops' ? all : mode === 'personal' ? all.filter((r) => !r.org_id && r.reporter_user_id === uid) : all.filter((r) => r.org_id === org?.id));
  }, [org?.id, mode, uid]);
  useEffect(() => { load().catch((e) => { if (/PGRST202|Could not find the function/.test(e.message)) setRows(null); else onError(e.message); }); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolve = async (row) => {
    setBusy(true);
    try {
      await q(supabase.rpc('msgr_report_resolve', { report: row.id }));
      onNote(t('reports.done'));
      await load();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!rows || (mode === 'personal' && !rows.length)) return null; // 개인 공간 신고가 없으면 카드 자체를 그리지 않는다
  const canResolve = isAdmin || mode === 'ops';
  const head = mode === 'ops' ? 'reports.ops' : isAdmin ? 'reports.title' : 'reports.mine';
  return (
    <section className="msgr-setcard">
      <h2>{t(head)}</h2><p>{t(`${head === 'reports.title' ? 'reports' : head}.desc`)}</p>
      <div className="msgr-rows">
        {!rows.length && <p className="empty">{t('reports.none')}</p>}
        {rows.map((r) => (
          <div key={r.id} className="row">
            <Av name={who(r.author_user_id)} size="sm" userId={r.author_user_id} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="name">{r.message_body}</div>
              <div className="sub">{[chName(r.channel_id), `${t('reports.from')}: ${who(r.reporter_user_id)}`, `${t('reports.author')}: ${who(r.author_user_id)}`, fmtWhen(r.created_at, lang)].filter(Boolean).join(' · ')}</div>
              {r.reason && <div className="sub">{r.reason}</div>}
            </div>
            <span className="msgr-klabel">{t(r.status === 'open' ? 'reports.open' : 'reports.resolved')}</span>
            {canResolve && r.status === 'open' && <button type="button" className="btn sm" disabled={busy} onClick={() => resolve(r)}>{t('reports.resolve')}</button>}
          </div>
        ))}
      </div>
    </section>
  );
}
/* 활동 트리 행 — Activity 밖 모듈 수준(안에서 정의하면 렌더마다 새 컴포넌트 타입이라 클릭마다 트리가 리마운트된다, 유건 제보 2026-09-04) */
function ActRow({ c, id, label, sub, tip = undefined, depth = 0, kids = null, icon = null }) {
  const { openIds, toggle, sel, active, openTab } = c; const has = !!kids; const open = openIds.has(id);
  return (
    <div>
      <button type="button" className={`row${sel === id && active !== 'graph' ? ' active' : ''}`} style={{ paddingLeft: `calc(var(--tree-pad, 6px) + ${depth * 12}px)` }} onClick={() => { if (['channels', 'people', 'crews', 'docs'].includes(id)) { toggle(id); return; } openTab(id); if (has && !open) toggle(id); }} onDoubleClick={() => has && toggle(id)}>
        {has ? <span className="caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }} onClick={(e) => { e.stopPropagation(); toggle(id); }}>▸</span> : <span className="caret" />}
        {icon && <I name={icon} size={12} />}
        <span className="lbl">{label}</span>{sub != null && <span className="cnt" title={tip}>{sub}</span>}
      </button>
      {has && open && <div className="tree-kids">{kids}</div>}
    </div>
  );
}

function Activity({ org, uid, isAdmin, channels, previewChannels = [], members, crews, nameOfUser, dmName = null, onNote, onError, onBack, onMenu, onOpenChannel }) {
  const { t, lang } = useT();
  const ownCrews = crews.filter((c) => c.owner_user_id === uid || crewTier(c, org) === 'company'); // 트리의 '에이전트' 목록 — 남의 에이전트는 없다(채널 아래 초대된 에이전트는 그대로, 유건 2026-09-24)
  const phone = useIsPhone(); // 폰에서는 창 나누기(옆에 열기)가 반폭 두 장이 되어 못 쓴다
  const [rows, setRows] = useState(null); const [docs, setDocs] = useState([]); const [cm, setCm] = useState([]); const [links, setLinks] = useState([]); // links = 기억 연결(msgr_doc_links — 양쪽을 읽을 수 있을 때만 보인다)
  // 창(pane)·탭 — 아르고 기억 페이지와 같은 모양: 그래프 노드를 누르면 옆 창(새 창)에 열리고, 트리는 포커스 창에 연다(유건 지시 2026-09-04). 전이는 panes.mjs(순수)
  const [st, setSt] = useState(() => ({ panes: [{ id: 1, tabs: phone ? [{ id: 'org', kind: 'entity', rel: 'org' }] : [GRAPH_TAB, { id: 'org', kind: 'entity', rel: 'org' }], active: phone ? 'org' : 'graph' }], focus: 1 })); // 폰은 그래프 대신 뷰어 한 장(유건 2026-09-10)
  const { panes, focus: focusPane } = st;
  const [limits, setLimits] = useState({}); const limitOf = (rel) => limits[rel] ?? 60;
  const [openIds, setOpenIds] = useState(() => new Set(['org', 'channels']));
  const [tabMenu, setTabMenu] = useState(null); // { paneId, id, x, y } — 탭 우클릭 메뉴
  const [treeOpen, setTreeOpen] = useState(false); // 폰 전용 — 왼쪽 트리 서랍
  useEffect(() => { for (const el of document.querySelectorAll('.msgr-actpane .vault-tab.active')) el.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [panes]);
  const focusP = panes.find((p) => p.id === focusPane) ?? panes[0];
  const focusTab = focusP.tabs.find((x) => x.id === focusP.active) ?? focusP.tabs[0];
  const sel = focusTab?.kind === 'entity' ? focusTab.rel : 'org';
  const openTab = (tab, opts) => setSt((s) => Panes.openTab(s.panes, s.focus, tab, opts));
  // 폰은 서랍으로 오가므로 창 한 장만 둔다 — 고를 때마다 탭이 쌓이면 좁은 화면에서 길을 잃는다
  const openEntity = (rel, opts) => phone
    ? setSt((s) => ({ panes: [{ id: s.panes[0].id, tabs: [{ id: rel, kind: 'entity', rel }], active: rel }], focus: s.panes[0].id }))
    : openTab({ id: rel, kind: 'entity', rel }, opts);
  // 문서의 연결 — 나가는·들어오는 자동 연결 + 본문 [[제목]](읽을 수 있는 문서만 — docs에 있는 것만 잇는다)
  const relatedOf = (doc) => { const byId = new Map(docs.map((d) => [d.id, d])); const out = new Map();
    for (const x of links) { if (x.src_doc === doc.id && byId.has(x.dst_doc)) out.set(x.dst_doc, { doc: byId.get(x.dst_doc), reason: x.reason, dir: 'out' }); else if (x.dst_doc === doc.id && byId.has(x.src_doc) && !out.has(x.src_doc)) out.set(x.src_doc, { doc: byId.get(x.src_doc), reason: x.reason, dir: 'in' }); }
    for (const m of String(doc.body ?? '').matchAll(/\[\[([^\]|#]+)/g)) { const d = docs.find((y) => y.title === m[1].trim() && y.id !== doc.id); if (d && !out.has(d.id)) out.set(d.id, { doc: d, reason: 'wikilink', dir: 'out' }); }
    return [...out.values()]; };
  const relOfDoc = (docRel) => { const id = docRel.replace(/\.md$/, ''); return id.startsWith('org/') ? 'org' : id; };
  const closeTab = (paneId, tabId) => setSt((s) => Panes.closeTab(s.panes, s.focus, paneId, tabId));
  const closeOthers = (paneId, id) => setSt((s) => Panes.closeOthers(s.panes, s.focus, paneId, id));
  const closeRight = (paneId, id) => setSt((s) => Panes.closeRight(s.panes, s.focus, paneId, id));
  const closeAll = (paneId) => setSt((s) => Panes.closeAll(s.panes, s.focus, paneId));
  const setFocusPane = (paneId) => setSt((s) => (s.focus === paneId ? s : { ...s, focus: paneId }));
  const activateTab = (paneId, tabId) => setSt((s) => Panes.setActive(s.panes, s.focus, paneId, tabId));
  const chKey = channels.map((c) => c.id).join(',');
  const load = useCallback(async () => {
    const [a, d, m, l] = await Promise.all([
      q(supabase.from('msgr_audit_log').select('id, actor_user_id, actor_crew_id, action, target_kind, target_id, meta, at').eq('org_id', org.id).order('at', { ascending: false }).limit(400)).catch(() => []), // 감사 열람은 관리자(RLS) — 멤버는 빈 목록
      Promise.all([ /* 일지(journal/)는 따로 최신 30건 — 한 창(400)에 섞으면 오래된 일지가 규칙집·프로젝트를 밀어낸다(검수 #551 HIGH-2) */
        q(supabase.from('msgr_org_docs').select('id, channel_id, path, title, body, version, updated_by, updated_at').eq('org_id', org.id).not('path', 'like', 'journal/%').order('path').limit(400)).catch(() => []),
        q(supabase.from('msgr_org_docs').select('id, channel_id, path, title, body, version, updated_by, updated_at').eq('org_id', org.id).like('path', 'journal/%').order('updated_at', { ascending: false }).limit(30)).catch(() => []),
        // 장(조직장·채널장)만 보는 채널 기억 — 표 권한은 넓히지 않고 RPC로(유건 결정 2026-09-24). 옛 서버엔 RPC가 없어 빈 목록.
        q(supabase.rpc('msgr_chief_docs', { org: org.id, journal: false, lim: 400 })).catch(() => []),
        q(supabase.rpc('msgr_chief_docs', { org: org.id, journal: true, lim: 30 })).catch(() => []),
      ]).then(([a, b, c, e]) => { const seen = new Set(); return [...a, ...b, ...(c ?? []), ...(e ?? [])].filter((d) => d?.id && !seen.has(d.id) && seen.add(d.id)); }), // 본문까지 — 문서 탭·[[링크]] 그래프
      channels.length ? q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', channels.map((c) => c.id))).catch(() => []) : [],
      q(supabase.rpc('msgr_doc_links_for', { org: org.id })).catch(() => []), // 이 조직 링크만(표 전체 RLS 스캔 방지 — 검수 #691 M5). 옛 서버엔 없어 빈 목록
    ]);
    setRows(a); setDocs(d); setCm(m); setLinks(l ?? []);
  }, [org.id, chKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(null); // 새 기억 폼이 열린 대상(rel)
  const chiefChannel = (id) => { const d = docs.find((x) => x.channel_id === id && x.channel_name); return d ? { id, name: d.channel_name, kind: d.channel_kind } : undefined; };
  // 장이 멤버가 아닌 채널 — 문서가 있는 채널만 트리·그래프에 더한다(목록 channels에는 없다)
  const memChannels = useMemo(() => { const have = new Set(channels.map((c) => c.id)); const extra = new Map(); for (const d of docs) if (d.channel_name && !have.has(d.channel_id)) extra.set(d.channel_id, { id: d.channel_id, name: d.channel_name, kind: d.channel_kind }); return [...channels, ...extra.values()]; }, [channels, docs]);
  // 문서 라벨은 참여 안 한 공개 채널까지 찾는다 — 공개 채널 일지는 조직원 누구나 읽어(RLS) 목록에 오는데, 참여 기준(#555) 뒤 channels에는 없어 '삭제된 채널'로 보였다
  const findCh = (id) => channels.find((c) => c.id === id) ?? previewChannels.find((c) => c.id === id) ?? chiefChannel(id); // 장 열람 문서는 채널 행이 안 보여 RPC가 준 이름·종류로(검수 M2)
  const chName = (id) => findCh(id)?.name ?? t('act.deletedChannel');
  const chLabel = (id) => { const c = findCh(id); return !c ? t('act.deletedChannel') : c.kind === 'dm' ? (dmName?.(c) || t('ui.dm')) : `#${c.name}`; }; // 문서 범위 표기 — 채널은 #이름, DM은 상대 이름(2026-09-16)
  const journals = useMemo(() => docs.filter((d) => d.channel_id && d.path.startsWith('journal/')).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.path.localeCompare(a.path)), [docs]); // 최근 일지(채널·DM) — 목록과 빈 안내가 같은 술어를 쓴다(검수 M-3)
  const crewName = (id) => crews.find((c) => c.id === id)?.display_name ?? t('act.deletedCrew');
  const docTitle = (id) => docs.find((d) => d.id === id)?.title ?? null;
  const roleName = (r) => (r ? t(`role.${r}`) : '');
  // 그래프 문서: rel(stem) = 노드 id, [[links]]가 엣지 — 아르고 기억 그래프의 계약 그대로
  const gbuilt = useMemo(() => {
    const peopleRel = (id) => `people/${id}`; const chRel = (c) => `channels/${c.id}`; const crewRel = (c) => `crews/${c.id}`; const docRel = docRelOf; // 채널은 id로(이름은 유일하지 않다 — 검수 M-2)
    const out = [];
    const visible = memChannels.filter((c) => c.kind !== 'dm');
    out.push({ rel: `org/${org.slug}.md`, title: org.name, dir: 'doc', links: [...visible.map(chRel), ...members.map((m) => peopleRel(m.user_id))] });
    for (const c of visible) {
      const ms = cm.filter((x) => x.channel_id === c.id);
      const people = ms.filter((x) => x.member_kind === 'user').map((x) => peopleRel(x.member_id)); // 공개 채널도 참여한 사람만(#555 이후)
      const cs = ms.filter((x) => x.member_kind === 'crew').map((x) => `crews/${x.member_id}`);
      const ds = docs.filter((d) => d.channel_id === c.id).map(docRel);
      out.push({ rel: `${chRel(c)}.md`, title: `#${c.name}`, dir: 'doc', links: [...people, ...cs, ...ds] });
    }
    for (const m of members) out.push({ rel: `${peopleRel(m.user_id)}.md`, title: m.display_name || m.user_id.slice(0, 8), dir: 'notes', links: [] });
    for (const c of crews) out.push({ rel: `${crewRel(c)}.md`, title: c.display_name, dir: 'doc', links: [peopleRel(c.owner_user_id)] });
    const wikiLinks = (body) => [...String(body ?? '').matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()); // 본문의 [[제목]]이 기억 사이 엣지(아르고 vault와 같은 문법)
    const byId = new Map(docs.map((d) => [d.id, d]));
    for (const d of docs) out.push({ rel: `${docRel(d)}.md`, title: d.title, dir: 'doc', links: [...wikiLinks(d.body), ...links.filter((x) => x.src_doc === d.id && byId.has(x.dst_doc)).map((x) => docRel(byId.get(x.dst_doc))), ...(d.channel_id ? [] : [`org/${org.slug}`])] }); // 자동 연결(같은 참여자·부서)도 엣지
    return out;
  }, [org, memChannels, members, crews, docs, cm, links]);
  const gkey = JSON.stringify(gbuilt); // 내용 키 — 부모가 30초마다 새 배열을 내려도 그래프는 내용이 바뀔 때만 다시 세운다(검수 H-1)
  const gdocs = useMemo(() => gbuilt, [gkey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 선택 대상과 행의 관계
  const relOf = (r) => {
    if (r.target_kind === 'user') return `people/${r.target_id}`;
    if (r.target_kind === 'channel') return channels.some((x) => x.id === r.target_id) ? `channels/${r.target_id}` : null;
    if (r.target_kind === 'crew') return `crews/${r.target_id}`;
    if (r.target_kind === 'doc') { const d = docs.find((x) => x.id === r.target_id); return d ? docRelOf(d) : null; }
    return null;
  };
  const chOf = (r) => r.meta?.channel ?? r.meta?.channel_id ?? (r.target_kind === 'channel' ? r.target_id : null);
  const matches = (r, sel) => {
    if (sel === 'org') return true;
    if (sel.startsWith('channels/')) { const cid = sel.slice(9); return channels.some((x) => x.id === cid) && (chOf(r) === cid || relOf(r) === sel); }
    if (sel.startsWith('people/')) return relOf(r) === sel || `people/${r.actor_user_id}` === sel;
    if (sel.startsWith('crews/')) return relOf(r) === sel || `crews/${r.actor_crew_id}` === sel || `crews/${r.meta?.crew_id}` === sel;
    return relOf(r) === sel;
  };
  const sentence = (r) => activitySentence({ r, t, lang, nameOfUser, chName, crewName, docTitle, roleName }); // 순수 함수(src/activity-sentence.mjs) — 동작 코드마다 문장, 모르는 코드는 일반 문구
  const entityView = (sel) => {
    const list = (rows ?? []).filter((r) => matches(r, sel)); const shown = list.slice(0, limitOf(sel));
    const days = []; for (const r of shown) { const d = dayKey(r.at); const g = days.find((x) => x.d === d); if (g) g.rows.push(r); else days.push({ d, at: r.at, rows: [r] }); }
    return { list, shown, days };
  };
  const toggle = (id) => setOpenIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const rc = { openIds, toggle, sel, active: focusTab?.id ?? 'graph', openTab: (rel) => { openEntity(rel); setTreeOpen(false); } }; // 트리 행 컨텍스트(ActRow는 모듈 수준 — 리마운트 없음)
  const nAct = (n) => ({ sub: t('act.tree.n.act', { n }), tip: t('act.tree.n.act.tip') }); const nItems = (n) => ({ sub: t('act.tree.n.items', { n }), tip: t('act.tree.n.items.tip') }); // 숫자의 뜻을 행마다 밝힌다 — 같은 자리 숫자가 어떤 행은 활동 수, 어떤 행은 항목 수였다(검수 E, 2026-10-01)
  const countFor = (rel) => (rows ?? []).filter((r) => relOf(r) === rel || (rel.startsWith('channels/') && chOf(r) === rel.slice(9))).length;
  const visibleCh = memChannels.filter((c) => c.kind !== 'dm');
  const entityTitle = (rel) => rel === 'org' ? org.name : rel.startsWith('channels/') ? `#${channels.find((x) => x.id === rel.slice(9))?.name ?? t('act.deletedChannel')}` : rel.startsWith('people/') ? nameOfUser(rel.slice(7)) : rel.startsWith('crews/') ? crewName(rel.slice(6)) : rel.startsWith('docs/') ? (docs.find((d) => docRelOf(d) === rel)?.title ?? rel) : rel;
  return (<>
    <div className="msgr-top">
      <NavButton onMenu={onMenu} />
      <span className="title"><I name="folder" size={18} />{t('act.title')}</span>
      <button type="button" className="btn sm msgr-backchat" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className={`msgr-actsplit${treeOpen ? ' tree-open' : ''}`}>
      {phone && treeOpen && <div className="msgr-treescrim" onClick={() => setTreeOpen(false)} />}
      <aside className="msgr-acttree vault-tree">
        <div className="vault-toolbar">
          <button type="button" className={`tb label${focusTab?.id === 'graph' ? ' on' : ''}`} onClick={() => openTab(GRAPH_TAB)}>{t('act.tab.graph')}</button>{/* 그래프 그림이 아이콘 세트에 없어 이름을 글자로 — 폴더 그림이 '그래프'와 어긋났다(화면 검수 UL7) */}
          <span style={{ flex: 1 }} />
        </div>
        <div className="msgr-acttree-body">
          <ActRow c={rc} id="org" label={org.name} {...(rows ? nAct(rows.length) : {})} icon="hash" kids={<>
            <ActRow c={rc} id="channels" label={t('act.tree.channels')} {...nItems(visibleCh.length)} depth={1} kids={visibleCh.map((c) => {
              const ms = cm.filter((x) => x.channel_id === c.id); const cs = ms.filter((x) => x.member_kind === 'crew'); const ds = docs.filter((d) => d.channel_id === c.id);
              const rel = `channels/${c.id}`;
              return <ActRow c={rc} key={c.id} id={rel} label={c.name} {...nAct(countFor(rel))} depth={2} icon={c.kind === 'private' ? 'lock' : 'hash'} kids={<>
                {cs.map((x) => <ActRow c={rc} key={x.member_id} id={`crews/${x.member_id}`} label={crewName(x.member_id)} {...nAct(countFor(`crews/${x.member_id}`))} depth={3} icon="star" />)}
                {ds.map((d) => <ActRow c={rc} key={d.id} id={docRelOf(d)} label={d.title} depth={3} icon="doc" />)}
                {!cs.length && !ds.length && <div className="tree-empty">{t('act.tree.empty')}</div>}
              </>} />;
            })} />
            <ActRow c={rc} id="people" label={t('act.tree.people')} {...nItems(members.length)} depth={1} kids={members.map((m) => <ActRow c={rc} key={m.user_id} id={`people/${m.user_id}`} label={m.display_name || m.user_id.slice(0, 8)} {...nAct(countFor(`people/${m.user_id}`))} depth={2} icon="at" />)} />
            <ActRow c={rc} id="crews" label={t('act.tree.crews')} {...nItems(ownCrews.length)} depth={1} kids={ownCrews.map((c) => <ActRow c={rc} key={c.id} id={`crews/${c.id}`} label={c.display_name} {...nAct(countFor(`crews/${c.id}`))} depth={2} icon="star" />)} />
            <ActRow c={rc} id="docs" label={t('act.tree.docs')} {...nItems(docs.filter((d) => !d.channel_id).length)} depth={1} kids={docs.filter((d) => !d.channel_id).map((d) => <ActRow c={rc} key={d.id} id={docRelOf(d)} label={d.title} depth={2} icon="doc" />)} />
          </>} />
        </div>
      </aside>
      <div className="msgr-actpanes">
        {panes.map((pane, pi) => {
          const cur = pane.tabs.find((x) => x.id === pane.active) ?? pane.tabs[0]; const isFocus = pane.id === focusPane;
          const ev = cur.kind === 'entity' ? entityView(cur.rel) : null; const sel = cur.kind === 'entity' ? cur.rel : null;
          return (
            <section key={pane.id} className={`msgr-actpane vault-pane${isFocus ? ' focus' : ''}`} style={{ borderLeft: pi > 0 ? '1px solid var(--border)' : 0 }} onMouseDown={() => setFocusPane(pane.id)}>
              <div className="vault-tabs" role="tablist">
                {phone && <button type="button" className="msgr-treebtn" onClick={() => setTreeOpen((v) => !v)} title={t('act.tree.channels')} aria-expanded={treeOpen}><I name="menu" size={17} /></button>}
                <div className="msgr-tabscroll">{/* 탭만 가로 스크롤 — 창이 많아져도 오른쪽 동작 버튼은 줄바꿈·잘림 없이 제자리(유건 제보 2026-09-04) */}
                {pane.tabs.map((tb) => { const title = tb.kind === 'graph' ? t('act.tab.graph') : entityTitle(tb.rel); return (
                  <div key={tb.id} className={`vault-tab${tb.id === pane.active ? ' active' : ''}`} onClick={() => activateTab(pane.id, tb.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(pane.id, tb.id); } }} onContextMenu={(e) => { e.preventDefault(); const r = e.currentTarget.closest('.msgr-actpane').getBoundingClientRect(); setTabMenu({ paneId: pane.id, id: tb.id, x: e.clientX - r.left, y: e.clientY - r.top }); }} title={title} role="tab" aria-selected={tb.id === pane.active}>
                    <span className="vault-tab-title">{title}</span>
                    <button type="button" className="vault-tab-x" onClick={(e) => { e.stopPropagation(); closeTab(pane.id, tb.id); }} aria-label={t('act.closeTab')}>×</button>
                  </div>
                ); })}
                </div>
                {!phone && cur.kind === 'entity' && panes.length < MAX_PANES && <button type="button" className="msgr-tabact" onClick={() => openEntity(cur.rel, { split: true })}>{t('act.tab.openSide')}</button>}
                {(pane.tabs.length > 1 || panes.length > 1) && <button type="button" className="msgr-tabact" onClick={() => closeAll(pane.id)}>{t(panes.length > 1 ? 'act.tab.closePane' : 'act.tab.closeAll')}</button>}{/* 창이 둘일 때 '모두 닫기'가 창마다 있어 어느 쪽을 닫는지 헷갈렸다 — 이 창을 닫는다고 밝힌다(검수 E) */}
              </div>
              {tabMenu && tabMenu.paneId === pane.id && <>
                <div className="msgr-menubg" onClick={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
                <div className="msgr-rowmenu msgr-tabmenu" style={{ left: tabMenu.x, top: tabMenu.y }} role="menu">
                  <button type="button" onClick={() => { closeTab(pane.id, tabMenu.id); setTabMenu(null); }}>{t('act.closeTab')}</button>
                  <button type="button" onClick={() => { closeOthers(pane.id, tabMenu.id); setTabMenu(null); }}>{t('act.tab.closeOthers')}</button>
                  <button type="button" onClick={() => { closeRight(pane.id, tabMenu.id); setTabMenu(null); }}>{t('act.tab.closeRight')}</button>
                  <button type="button" onClick={() => { closeAll(pane.id); setTabMenu(null); }}>{t('act.tab.closeAll')}</button>
                </div>
              </>}
              <div className="msgr-actbody">
                {cur.kind === 'graph' ? (
                  <Graph3D key="all" docs={gdocs} hint={t(phone ? 'act.graph.hint.phone' : 'act.graph.hint')} labels={{ zoomIn: t('act.graph.zoomIn'), zoomOut: t('act.graph.zoomOut'), fit: t('act.graph.fit') }} onSelectDoc={(rel) => openEntity(relOfDoc(rel), { split: true })} />
                ) : (
                  <div className="msgr-actlist">
                    {(() => {
                      const doc = sel.startsWith('docs/') ? docs.find((d) => docRelOf(d) === sel) : null;
                      const ch = sel.startsWith('channels/') ? channels.find((x) => x.id === sel.slice(9)) : null;
                      const scopeDocs = doc ? [] : sel === 'org' ? docs.filter((d) => !d.channel_id) : ch ? docs.filter((d) => d.channel_id === ch.id) : sel.startsWith('people/') ? docs.filter((d) => d.updated_by === sel.slice(7)) : [];
                      const canNew = sel === 'org' ? isAdmin : !!ch;
                      return (<>
                        {!doc && <div className="head"><h3>{sel === 'org' ? t('mem.all') : t('mem.of', { name: entityTitle(sel) })}</h3><span className="sub">{scopeDocs.length + (sel === 'org' ? journals.length : 0)}</span>
                          {ch && <button type="button" className="btn sm" onClick={() => onOpenChannel(ch.id)}><I name="hash" size={12} />{t('act.openChannel')}</button>}
                          {canNew && creating !== sel && <button type="button" className="btn sm" onClick={() => setCreating(sel)}><I name="plus" size={12} />{t('mem.new')}</button>}
                        </div>}
                        {creating === sel && <MemNew org={org} channelId={ch?.id ?? null} uid={uid} onNote={onNote} onError={onError} onCancel={() => setCreating(null)} onCreated={async (d) => { setCreating(null); await load(); openEntity(docRelOf({ ...d, channel_id: d.channel_id ?? ch?.id ?? null })); }} />}
                        {doc ? <MemDoc doc={doc} isAdmin={isAdmin} nameOfUser={nameOfUser} chName={chLabel} onSaved={load} onNote={onNote} onError={onError} related={relatedOf(doc)} onOpen={(d) => openEntity(docRelOf(d))} onWiki={(title) => { const d = docs.find((x) => x.title === title); if (d) openEntity(docRelOf(d)); }} /> : (
                          <div className="msgr-memlist">
                            {sel === 'org' && journals.length > 0 && ( /* 최근 일지 — 채널·DM의 크루 답글이 서버 트리거로 쌓인다(2026-09-16). 전사 문서가 0이어도 첫 화면이 비지 않게 */
                              <div className="folder"><div className="msgr-klabel">{t('mem.journal.recent')}</div>
                                {journals.map((d) => <button key={d.id} type="button" className="memitem" onClick={(e) => openEntity(docRelOf(d), { split: !!(e.metaKey || e.altKey) })}><I name="doc" size={13} /><span className="name">{d.title}</span><span className="meta">{chLabel(d.channel_id)}</span></button>)}
                              </div>)}
                            {!scopeDocs.length && creating !== sel && !(sel === 'org' && journals.length > 0) && <p className="empty">{sel.startsWith('people/') || sel.startsWith('crews/') ? t('mem.none.person') : t('mem.none')}</p>}
                            {DOC_FOLDERS.map((f) => { const found = scopeDocs.filter((d) => d.path.startsWith(`${f}/`)); const fs = f === 'journal' ? [...found].sort((a, b) => b.path.localeCompare(a.path)) : found; /* 일지는 파일명이 날짜(YYYY-MM-DD)라 경로 내림차순 = 최신이 위 */ return fs.length ? (
                              <div key={f} className="folder"><div className="msgr-klabel">{t(`docs.folder.${f}`)}</div>
                                {fs.map((d) => <button key={d.id} type="button" className="memitem" onClick={(e) => openEntity(docRelOf(d), { split: !!(e.metaKey || e.altKey) })}><I name="doc" size={13} /><span className="name">{d.title}</span><span className="meta">{d.channel_id ? `${chLabel(d.channel_id)} · ` : ''}v{d.version} · {nameOfUser(d.updated_by)}</span></button>)}
                              </div>) : null; })}
                          </div>
                        )}
                        {isAdmin && (
                          <details className="msgr-actfold">
                            <summary>{t('mem.activity')}<span className="sub">{ev.list.length}</span></summary>
                            {rows !== null && !ev.list.length && <p className="empty">{t('act.empty')}</p>}
                            {ev.days.map((g) => (
                              <div key={g.d} className="day">
                                <div className="daylabel">{fmtDay(g.at, lang).join(' · ')}</div>
                                {g.rows.map((r) => <div key={r.id} className="item"><span className="when">{fmtTs(r.at, lang)}</span><span className="text">{sentence(r)}</span></div>)}
                              </div>
                            ))}
                            {ev.list.length > ev.shown.length && <div className="row act-more"><button type="button" className="btn sm" onClick={() => setLimits((m) => ({ ...m, [sel]: limitOf(sel) + 60 }))}>{t('act.more')}</button></div>}
                          </details>
                        )}
                      </>);
                    })()}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  </>);
}

/* ─── 폰 기억 탭(유건 확정 2026-10-01): 폴더별 기억 보기·검색 — 읽기 전용. 자료 = 조직 문서(msgr_org_docs)와 장 열람 RPC(msgr_chief_docs) — 기억 페이지(Activity)와 같은 조회.
   개인 공간 기억은 서버에 없다(msgr_org_docs.org_id NOT NULL, 일지 트리거는 개인 방을 건너뛴다). 탭에 들어올 때(조직이 바뀔 때) 한 번 읽는다 — 주기 호출 없음. ─── */
const MEM_FOLD_KEY = 'argo-msgr-mem-fold'; // 접은 기억 폴더(조직 id:폴더) — 이 기기에만
const readMemFold = () => { try { const v = JSON.parse(localStorage.getItem(MEM_FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const MEM_SORT_KEY = 'argo-msgr-mem-sort'; // 기억 폴더 정렬(설정 > 기억) — 이 기기에만
const readMemSort = () => { try { const v = localStorage.getItem(MEM_SORT_KEY); return v === 'name' ? 'name' : 'recent'; } catch { return 'recent'; } };
function PhoneMemory({ org, channels = [], previewChannels = [], dmName, nameOfUser, query = '', onOpen, onError, searchFoot, sort = 'recent', onSort = null }) {
  const { t, lang } = useT();
  const [docs, setDocs] = useState(null);
  const [fold, setFold] = useState(readMemFold);
  const toggleFold = (key) => setFold((cur) => { const k = `${org.id}:${key}`; const next = { ...cur }; if (next[k]) delete next[k]; else next[k] = true; try { localStorage.setItem(MEM_FOLD_KEY, JSON.stringify(next)); } catch { /* 저장 못 해도 이번 화면은 접힌다 */ } return next; });
  const folded = (key) => !query.trim() && !!fold[`${org.id}:${key}`]; // 검색 중엔 찾은 문서가 접힌 폴더에 숨지 않게 다 편다
  const [sortMenu, setSortMenu] = useState(false); // 정렬 메뉴(유건 2차 피드백 3 — 설정이 아니라 기억 탭 소제목 줄 오른쪽)
  useDismiss(sortMenu, () => setSortMenu(false), '.ph-memsort', '.ph-memsort > .msgr-sortbtn:not(.ph-memfoldall)', true);
  useEffect(() => {
    let live = true;
    const cols = 'id, channel_id, path, title, body, version, updated_by, updated_at';
    Promise.all([
      q(supabase.from('msgr_org_docs').select(cols).eq('org_id', org.id).not('path', 'like', 'journal/%').order('path').limit(400)).catch(() => []),
      q(supabase.from('msgr_org_docs').select(cols).eq('org_id', org.id).like('path', 'journal/%').order('updated_at', { ascending: false }).limit(30)).catch(() => []),
      q(supabase.rpc('msgr_chief_docs', { org: org.id, journal: false, lim: 400 })).catch(() => []),
      q(supabase.rpc('msgr_chief_docs', { org: org.id, journal: true, lim: 30 })).catch(() => []),
    ]).then(([a, b, c, e]) => { const seen = new Set(); if (live) setDocs([...a, ...b, ...(c ?? []), ...(e ?? [])].filter((d) => d?.id && !seen.has(d.id) && seen.add(d.id))); })
      .catch((err) => { if (live) { setDocs([]); onError(err.message); } });
    return () => { live = false; };
  }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const findCh = (id) => channels.find((c) => c.id === id) ?? previewChannels.find((c) => c.id === id) ?? (() => { const d = (docs ?? []).find((x) => x.channel_id === id && x.channel_name); return d ? { id, name: d.channel_name, kind: d.channel_kind } : null; })();
  const chLabel = (id) => { const c = findCh(id); return !c ? t('act.deletedChannel') : c.kind === 'dm' ? (dmName?.(c) || t('ui.dm')) : `#${c.name}`; };
  if (docs === null) return <div className="msgr-hint ph-empty" role="status">{t('ui.loading')}</div>;
  const g = memoryGroups(docs, { query, channelLabel: chLabel, sort });
  const foldKeys = [...g.org.map((f) => `org:${f.key}`), ...g.channels.map((c) => `ch:${c.key}`)]; // 지금 보이는 폴더 — '모두 접기·펼치기'가 이것만 바꾼다(유건 2026-10-02)
  const shutAll = allFolded(fold, org.id, foldKeys);
  const setAll = (shut) => setFold((cur) => { const next = foldAll(cur, org.id, foldKeys, shut); try { localStorage.setItem(MEM_FOLD_KEY, JSON.stringify(next)); } catch { /* 저장 못 해도 이번 화면은 바뀐다 */ } return next; });
  const folder = (key, label, list, rowLabel) => (<div key={key} className="ph-memgroup">
    <button type="button" className="ph-memfolder" aria-expanded={!folded(key)} onClick={() => toggleFold(key)}><I name="caret" size={14} className={`ph-memcaret${folded(key) ? ' shut' : ''}`} /><I name="folder" size={14} />{label}<span className="ph-kcount">{list.length}</span></button>
    {!folded(key) && <div className="msgr-list">{list.map((d) => row(d, rowLabel))}</div>}
  </div>);
  const row = (d, label) => (
    <button key={d.id} type="button" className="item ph-memrow" onClick={() => onOpen(d, label)}>
      <span className="ph-memic" aria-hidden="true"><I name="doc" size={16} /></span>
      <span className="ph-kbody"><span className="name">{d.title}</span><span className="snip">{query.trim() ? memSnippet(d.body, query) : t('docs.meta', { v: d.version ?? 1, name: nameOfUser(d.updated_by), when: fmtWhen(d.updated_at, lang) })}</span></span>
    </button>);
  return (<>
    {!g.total && !query.trim() && <div className="msgr-hint ph-empty">{t('phone.mem.none')}</div>}{/* 폰에서는 만들 수 없다 — 기억이 어디서 모이는지 사실대로(UXM-12) */}
    {(() => { const sortCtl = (<span className="msgr-sortwrap ph-memsort">{!query.trim() && foldKeys.length > 0 && <button type="button" className="msgr-sortbtn ph-memfoldall" onClick={() => { setSortMenu(false); setAll(!shutAll); }} aria-label={t(shutAll ? 'phone.mem.unfoldAll' : 'phone.mem.foldAll')} title={t(shutAll ? 'phone.mem.unfoldAll' : 'phone.mem.foldAll')}><I name={shutAll ? 'unfold' : 'fold'} size={18} /></button>}<button type="button" className={`msgr-sortbtn${sortMenu ? ' on' : ''}`} onClick={() => setSortMenu((v) => !v)} aria-label={t('phone.mem.sort')} title={t('phone.mem.sort')} aria-haspopup="menu" aria-expanded={sortMenu}><I name="sort" size={16} /></button>
      {sortMenu && <div className="msgr-rowmenu" role="menu">{['name', 'recent'].map((v) => <button key={v} type="button" role="menuitemradio" aria-checked={sort === v} onClick={() => { onSort?.(v); setSortMenu(false); }}>{sort === v ? <I name="check" size={13} /> : <span className="mi" style={{ width: 13 }} />}{t(`phone.mem.sort.${v}`)}</button>)}</div>}</span>);
      return (<>{g.org.length > 0 && <div className="ph-sechead">{t('phone.mem.org')}{sortCtl}</div>}
        {g.org.map((f) => folder(`org:${f.key}`, t(`docs.folder.${f.key}`), f.docs, t(`docs.folder.${f.key}`)))}
        {g.channels.length > 0 && <div className="ph-sechead">{t('phone.mem.channels')}{!g.org.length && sortCtl}</div>}</>); })()}
    {g.channels.map((c) => folder(`ch:${c.key}`, c.label, c.docs, c.label))}
    {searchFoot(g.total > 0)}
  </>);
}
function PhoneMemDoc({ doc, label, nameOfUser, onBack, onMenu }) {
  const { t, lang } = useT();
  return (<>
    <div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{doc.title}</span><button type="button" className="btn sm msgr-backchat" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button></div>
    <div className="msgr-thread page"><article className="msgr-memdoc ph-memdoc">
      <header><span className="msgr-klabel">{label} · {doc.path}</span><h2>{doc.title}</h2><div className="meta">{t('docs.meta', { v: doc.version ?? 1, name: nameOfUser(doc.updated_by), when: fmtTs(doc.updated_at, lang) })}</div></header>
      {doc.body ? <div className="msgr-sheet"><Markdown text={doc.body} /></div> : <p className="empty">{t('docs.blank')}</p>}
      <p className="note">{t('phone.mem.readonly')}</p>
    </article></div>
  </>);
}

/* ─── 폰 결재 페이지(유건 2026-10-02) — 에이전트 탭 '결재 대기' 카드를 누르면 연다. 결재 카드만: 한두 줄 요약 + 등급(꼭 확인·보통·가벼운 일) + 승인·거절,
   '자세히'를 펼치면 원래 내용(목적·할 일·필요한 것·명령·이유). 자료는 에이전트 탭과 같은 목록(loadApprovals — 이 화면이 조회를 늘리지 않는다).
   결정은 데스크톱 슬립(decide)·방 넣기 요청(msgr_crew_join_decide)과 같은 쓰기이고, 최종 판정은 서버(RLS·msgr_can_decide)다 — 0행이면 결재권이 없다는 안내. ─── */
function PhoneApprovals({ items, uid, orgs, crewName, spaceName, onBack, onMenu, onOpen, onDecided, onNote, onError }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(() => new Set());
  const [done, setDone] = useState(() => new Set()); // 방금 결정한 카드 — 목록을 다시 읽기 전에도 바로 빠진다
  const [denied, setDenied] = useState(() => new Set()); // 서버가 결재권 없다고 거절한 카드 — 버튼 대신 안내(목록을 다시 읽으면 정책 판정으로 빠진다)
  const [busy, setBusy] = useState(null);
  const list = approvalPageItems(items, { done });
  const josa = lang === 'en' ? (x) => x : koJosa;
  const decide = async (it, ok) => {
    if (busy) return; setBusy(it.key);
    try {
      if (it.kind === 'join') await q(supabase.rpc('msgr_crew_join_decide', { req: it.id, approve: ok }));
      else {
        const res = await supabase.from('msgr_crew_approvals').update({ status: ok ? 'approved' : 'rejected', decided_by: uid, decided_at: new Date().toISOString() }).eq('id', it.id).select('id');
        // 결재권 없음 — USING이면 0행, WITH CHECK(예: '꼭 확인'의 크루 소유자)면 RLS 오류. 둘 다 '권한이 없습니다' 대신 누가 결정하는지 안내한다(분리 검수 M-2)
        if (approvalDenied(res.error, res.data)) { setDenied((d) => new Set(d).add(it.key)); onError(t(approvalOnlyKey(phoneApprovalDecider(it, { uid, orgs })))); onDecided?.(); return; }
        if (res.error) throw res.error;
      }
      setDone((d) => new Set(d).add(it.key)); onNote(t(ok ? 'phone.ap.approved' : 'phone.ap.rejected')); onDecided?.();
    } catch (e) { onError(friendlyErr(e?.message ?? String(e), t)); } finally { setBusy(null); }
  };
  const toggle = (key) => setOpen((st) => toggleId(st, key));
  const card = (it) => {
    const join = it.kind === 'join'; const lv = approvalGrade(join ? it : { ...it, kind: it.apKind });
    const [k, v] = join ? joinReqKey({ crew: it.crewName, room: it.roomName }) : approvalSummaryKey({ ...it, kind: it.apKind });
    const plain = join ? null : approvalPlainFields(it.payload); const shown = open.has(it.key); const name = crewName(it); const sum = josa(t(k, v));
    const dec = phoneApprovalDecider(it, { uid, orgs }); const can = dec.can && !denied.has(it.key);
    const cmd = join ? null : approvalCmdMode(it); // 꼭 확인 = 명령 전체(줄바꿈), 그 밖 = 쉬운 문장이 있을 때 한 줄(분리 검수 M-3)
    const doc = !join && it.apKind === 'org_doc' && it.payload && typeof it.payload === 'object' ? it.payload : null;
    return (
      <article key={it.key} className={`ph-apitem${lv ? ` lv-${lv}` : ''}`}>
        <div className="ph-aptop">
          <Av name={name ?? '?'} crew size="sm" crewId={it.crew_id} />
          <span className="who">{name ?? t('ap.request')}</span>
          {lv && <span className={`ph-aplv ${lv}`}>{t(`ap.level.${lv}`)}</span>}
          <span className="meta">{[it.org_id ? spaceName(it.org_id) : null, fmtDmWhen(t('time.yesterday'), Date.parse(it.at), lang)].filter(Boolean).join(' · ')}</span>
        </div>
        <p className="ph-apsum">{sum}</p>
        {cmd && !shown && <p className={`ph-apcmd ${cmd}`}><b>{t('ap.plain.command')}</b><code>{it.action}</code></p>}{/* 꼭 확인 결재는 실제로 실행될 명령을 펼치지 않아도 전부 보인다(데스크톱 슬립의 기본 펼침과 같은 규칙 — 요약이 두 줄에서 잘려도 명령은 안 잘린다) */}
        {shown && <div className="ph-apdetail" id={`apd-${it.id}`}>
          {join ? <p>{t('phone.ap.joinNote')}</p> : (<>
            {plain?.purpose && <p><b>{t('ap.plain.purpose')}</b> {plain.purpose}</p>}
            {plain?.task && <p><b>{t('ap.plain.task')}</b> {plain.task}</p>}
            {plain?.need && <p><b>{t('ap.plain.need')}</b> {plain.need}</p>}
            {doc && <p><b>{t('ap.orgDoc')}</b> {orgDocTitle(doc, '')}{typeof doc.path === 'string' ? ` · ${doc.path}` : ''}</p>}
            {plainField(it.action) && <div className="cmd"><b>{t('ap.plain.command')}</b><code>{it.action}</code></div>}
            {plainField(it.reason) && <p><b>{t('phone.ap.reason')}</b> {it.reason}</p>}
          </>)}
          <button type="button" className="btn sm ph-apopen" onClick={() => onOpen(it)}><I name="chat" size={14} />{t('phone.ap.open')}</button>
        </div>}
        <div className="ph-apacts">
          <button type="button" className="ph-apmorebtn" aria-expanded={shown} aria-controls={`apd-${it.id}`} onClick={() => toggle(it.key)}>{t(shown ? 'phone.ap.less' : 'phone.ap.more')}<I name="caret" size={16} className={shown ? 'up' : ''} /></button>
          {can ? (<>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => decide(it, true)}><I name="check" size={15} />{t('ap.approve')}</button>{/* 승인이 왼쪽 — 채널 결재 카드·참여 요청·친구 요청과 같은 순서(UXM-01) */}
            <button type="button" className="btn" disabled={!!busy} onClick={() => decide(it, false)}><I name="x" size={15} />{t('ap.reject')}</button>
          </>) : <span className="ph-apnote" role="note">{t(approvalOnlyKey(dec))}</span>}
        </div>
      </article>);
  };
  return (<>
    <div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{t('phone.ap.title')}</span><button type="button" className="btn sm msgr-backchat" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button></div>
    <div className="msgr-thread page"><div className="ph-aplist">
      {list.length ? list.map(card) : <p className="msgr-hint ph-empty">{t('phone.ap.empty')}</p>}
    </div></div>
  </>);
}

/* ─── 폰 설정 > 친구 관리(유건 2차 피드백 5) — 친구 탭과 같은 줄 모양, 위 가로 탭(친구 / 차단 / 숨긴 에이전트).
   친구 줄의 대화하기·차단·삭제는 줄 끝 '⋯' 메뉴로(버튼 세 개를 줄에 늘어놓지 않는다). 삭제·차단은 확인을 받는다. 차단·숨긴 목록은 그 탭을 열 때 한 번 읽는다. ─── */
function PhoneFriendsManage({ uid, friends = [], onChanged, onPersonalDm, onNote, onError }) {
  const { t } = useT();
  const { unmuteCrew, hiddenUserIds, hideUser, unhideUser } = useContext(SafetyCtx);
  const [tab, setTab] = useState('friends'); const [busy, setBusy] = useState(false); const [menu, setMenu] = useState(null); const [confirm, setConfirm] = useState(null); const [reqOpen, setReqOpen] = useState(true);
  const [blocked, setBlocked] = useState(null); const [muted, setMuted] = useState(null);
  const loadBlocked = useCallback(async () => { try { setBlocked(await q(supabase.rpc('msgr_my_blocked')) ?? []); } catch { setBlocked([]); } }, []);
  const loadMuted = useCallback(async () => { try { setMuted(await q(supabase.rpc('msgr_my_muted_crews')) ?? []); } catch { setMuted([]); } }, []);
  useEffect(() => { if (tab === 'blocked' && blocked === null) loadBlocked(); if (tab === 'hidden' && muted === null) loadMuted(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (f) => f.display_name || f.handle || f.user_id.slice(0, 8);
  const call = async (fn, args, okKey) => { setBusy(true); try { await q(supabase.rpc(fn, args)); onNote(t(okKey)); await onChanged?.(); return true; } catch (e) { onError(/msgr_friend_closed/.test(e.message) ? t('friends.err.closed') : e.message); return false; } finally { setBusy(false); } };
  const received = friends.filter((f) => f.status === 'pending' && f.requested_by !== uid);
  const accepted = withoutHidden(friends.filter((f) => f.status === 'accepted'), hiddenUserIds).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ko')); // 숨긴 친구는 숨김 탭으로
  const hid = hiddenGroups({ friends, hiddenUserIds, mutedCrews: muted ?? [] });
  const act = async (run, failKey) => { setBusy(true); try { await run(); } catch { onError(t(failKey)); } finally { setBusy(false); } };
  const person = (f, right) => (<div key={f.user_id ?? f.crew_id} className="ph-mrow"><Av name={f.crew_id ? (f.display_name || t('agentcard.title')) : nameOf(f)} size="lg" crew={!!f.crew_id} crewId={f.crew_id ?? null} userId={f.crew_id ? null : f.user_id} /><span className="ph-kbody"><span className="name">{f.crew_id ? (f.display_name || t('agentcard.title')) : nameOf(f)}</span>{f.handle && <span className="snip">@{f.handle}</span>}</span>{right}</div>);
  const empty = (k) => <p className="ph-mempty">{t(k)}</p>;
  return (<div className="ph-fmanage">
    <p className="ph-fm-hint">{t('fm.hint')}</p>
    <Seg kind="tab" className="ph-fm-tabs" label={t('phone.set.friends')} value={tab} onPick={setTab} options={['friends', 'blocked', 'hidden'].map((k) => ({ v: k, label: t(`fm.tab.${k}`) }))} />
    {tab === 'friends' && (<>
      {received.length > 0 && (<>
        <button type="button" className="ph-reqrow ph-mreq" aria-expanded={reqOpen} onClick={() => setReqOpen((v) => !v)}><span className="ph-reqic"><I name="personplus" size={18} /></span><span className="name">{t('phone.friends.requests', { n: received.length })}</span><I name="caret" size={14} className={`ph-chev${reqOpen ? ' open' : ''}`} /></button>
        {reqOpen && received.map((f) => person(f, <span className="ph-macts"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => call('msgr_friend_decide', { other: f.user_id, accept: true }, 'friends.accepted')}>{t('phone.friends.accept')}</button><button type="button" className="btn" disabled={busy} onClick={() => call('msgr_friend_decide', { other: f.user_id, accept: false }, 'friends.declined')}>{t('phone.friends.decline')}</button></span>))}
      </>)}
      <div className="ph-mhead">{t('phone.friends.count', { n: accepted.length })}</div>
      {accepted.map((f) => person(f, <button type="button" className="ph-mmore" aria-label={t('fm.more', { name: nameOf(f) })} aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ f, at: { x: r.right - 200, y: r.bottom + 4 } }); }}><I name="dots" size={18} /></button>))}
      {!accepted.length && empty('friends.none')}
    </>)}
    {tab === 'blocked' && (blocked === null ? <p className="ph-mempty" role="status">{t('ui.loading')}</p> : (<>
      {blocked.map((f) => person(f, <button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await q(supabase.rpc('msgr_friend_unblock', { other: f.user_id })); onNote(t('friends.unblocked')); await loadBlocked(); await onChanged?.(); } catch { onError(t('friends.unblock.failed')); } finally { setBusy(false); } }}>{t('friends.unblock')}</button>))}
      {!blocked.length && empty('friends.blocked.none')}
    </>))}
    {tab === 'hidden' && (muted === null ? <p className="ph-mempty" role="status">{t('ui.loading')}</p> : (<>
      {hid.friends.length > 0 && <div className="ph-mhead">{t('fm.hidden.friends')}</div>}
      {hid.friends.map((f) => person(f, <button type="button" className="btn" disabled={busy} onClick={() => act(() => unhideUser(f.user_id), 'fm.unhide.failed')}>{t('fm.unhide')}</button>))}
      {hid.agents.length > 0 && <><div className="ph-mhead">{t('fm.hidden.agents')}</div><p className="ph-mnote">{t('fm.hideAgent.note')}</p></>}
      {hid.agents.map((c) => person(c, <button type="button" className="btn" disabled={busy} onClick={() => act(async () => { await unmuteCrew(c.crew_id); await loadMuted(); }, 'fm.unhide.failed')}>{t('fm.unhide')}</button>))}
      {!hid.friends.length && !hid.agents.length && empty('fm.hidden.none')}
    </>))}
    {menu && <CtxMenu at={menu.at} onClose={() => setMenu(null)} items={[
      { icon: 'at', label: t('friends.dm'), run: () => onPersonalDm?.(menu.f.user_id) },
      hideUser && { icon: 'eyeoff', label: t('fm.hide'), run: () => setConfirm({ kind: 'hide', f: menu.f }) },
      { icon: 'block', label: t('friends.block'), danger: true, run: () => setConfirm({ kind: 'block', f: menu.f }) },
      { icon: 'trash', label: t('friends.remove'), danger: true, run: () => setConfirm({ kind: 'remove', f: menu.f }) },
    ]} />}
    {confirm && createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t(confirm.kind === 'hide' ? 'fm.hide' : confirm.kind === 'block' ? 'friends.block' : 'friends.remove')}>
      {confirm.kind === 'hide'
        ? <ConfirmModal tone="primary" title={t('fm.hide.title', { name: nameOf(confirm.f) })} description={t('fm.hide.note')} confirmLabel={t('fm.hide')} busy={busy}
            onConfirm={async () => { const c = confirm; await act(() => hideUser(c.f.user_id), 'fm.hide.failed'); setConfirm(null); }} onClose={() => { if (!busy) setConfirm(null); }} />
        : <ConfirmModal title={t(confirm.kind === 'block' ? 'friends.block' : 'friends.remove')} description={t(confirm.kind === 'block' ? 'friends.block.confirm' : 'friends.remove.confirm', { name: nameOf(confirm.f) })} confirmLabel={t(confirm.kind === 'block' ? 'friends.block' : 'friends.remove')} busy={busy}
            onConfirm={async () => { const c = confirm; const ok = await call('msgr_friend_remove', { other: c.f.user_id, block: c.kind === 'block' }, c.kind === 'block' ? 'friends.blocked' : 'friends.removed.friend'); if (ok) { setConfirm(null); if (c.kind === 'block') setBlocked(null); } }} onClose={() => { if (!busy) setConfirm(null); }} />}
    </div>, document.body)}
  </div>);
}

/* ─── 개인 에이전트 카드(유건 2차 피드백 1) — 개인 공간 에이전트는 조직 카드가 없어 '대화에서 설정'으로 보내던 것을 카드로.
   바꿀 수 있는 것만 바꾼다(서버 규칙 그대로 — phone-shell.mjs personalCardLocks): 얼굴·사진·소개는 주인, 직무·지시 범위는 Argo 에이전트만(외부 에이전트 쌍둥이는 조직을 따른다), 이름은 Argo 앱에서 정한다.
   열 때 그 행 1건을 읽는다(주인만 보이는 열 — 소개·지시 범위). 잠긴 칸은 자물쇠와 이유를 보인다. ─── */
function PersonalAgentCard({ crewId, uid, onClose, onNote, onError, onChanged, saveLook = null }) {
  const { t } = useT();
  const [crew, setCrew] = useState(null); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const load = useCallback(async () => { try { const row = await q(supabase.from('msgr_crews').select('id, display_name, role_text, bio, avatar_url, face, allow, allow_users, hosting, org_id, owner_user_id, status').eq('id', crewId).maybeSingle()); if (!row) setFailed(true); else setCrew(row); } catch (e) { setFailed(true); onError(friendlyErr(e.message, t)); } }, [crewId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const looks = useContext(AvatarCtx).looks;
  const save = async (patch, okKey = 'crew.profile.saved') => {
    setBusy(true);
    const look = saveLook && Object.keys(patch).every((k) => k === 'face' || k === 'avatar_url'); // 얼굴·사진은 같은 에이전트의 내 행 전부에(유건 2026-10-05) — 이름·역할·소개·허용은 이 행만(종전)
    const r = look ? await saveLook(crewId, patch) : await supabase.from('msgr_crews').update(patch).eq('id', crewId).select('id');
    setBusy(false);
    if (r.error) return onError(/msgr_not_allowed/.test(r.error.message) ? t('agentcard.lock.twin') : friendlyErr(r.error.message, t));
    if (!(look ? r.ids : r.data)?.length) return onError(t('agentcard.notOwner'));
    onNote(t(look && r.onlyHere ? 'crew.look.onlyHere' : okKey)); await load(); onChanged?.(); // 대표가 아닌 이 행만 저장됐으면 따로 알린다(분리 검수 2026-10-05 #6)
  };
  const locks = personalCardLocks(crew);
  const lockNote = (why) => <span className="ph-lockwhy"><I name="lock" size={12} />{t(why === 'twin' ? 'agentcard.lock.twin' : 'agentcard.lock.argo')}</span>;
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <aside className="msgr-crewsheet ph-agentcard" role="dialog" aria-label={t('agentcard.title')}>
        <div className="head">
          {crew ? <Av name={crew.display_name} crew size="lg" crewId={crew.id} src={agentLook(crew.id, looks, crew.face, crew.avatar_url ?? null).photo ?? null} /> : <span className="msgr-av lg crew" />}
          <div style={{ minWidth: 0 }}><div className="name">{crew?.display_name ?? ''}</div><div className="msgr-klabel">{t('agentcard.personal')}{crew?.hosting === 'bot' ? ` · ${t('agentcard.ext')}` : ''}</div></div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={15} /></button>
        </div>
        {!crew ? <p className="note" role="status">{failed ? t('agentcard.notOwner') : t('ui.loading')}</p> : (<>
          <section className="msgr-crewprofile">
            <h3>{t('crew.profile')}</h3>
            <label className="msgr-klabel">{t('agentcard.name')}</label>
            <div className="ph-lockedfield"><span>{crew.display_name}</span>{lockNote(locks.name)}</div>
            <AvatarEdit name={crew.display_name} crew crewId={crew.id} url={agentLook(crew.id, looks, crew.face, crew.avatar_url ?? null).photo ?? null} busy={busy} t={t} onUpload={async (f) => { try { setBusy(true); const url = await uploadAvatar(uid, `crew-${crew.id}`, f); setBusy(false); await save({ avatar_url: url }); } catch (e) { setBusy(false); onError(e.message); } }} onRemove={() => save({ avatar_url: null })} />
            <label className="msgr-klabel">{t('crew.face')}</label>
            <FacePicker crew={crew} busy={busy} t={t} onSave={(face) => save({ face })} />
            <label className="msgr-klabel" htmlFor={`prole-${crew.id}`}>{t('crew.role')}</label>
            {locks.role ? <div className="ph-lockedfield"><span>{crew.role_text || '—'}</span>{lockNote(locks.role)}</div>
              : <input id={`prole-${crew.id}`} className="msgr-input" maxLength={60} defaultValue={crew.role_text ?? ''} placeholder={t('crew.role.ph')} onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (crew.role_text ?? null)) save({ role_text: v }); }} />}
            <label className="msgr-klabel" htmlFor={`pbio-${crew.id}`}>{t('crew.bio')}</label>
            <textarea id={`pbio-${crew.id}`} className="msgr-input" rows={2} maxLength={300} defaultValue={crew.bio ?? ''} placeholder={t('crew.bio.ph')} onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== (crew.bio ?? null)) save({ bio: v }); }} />
          </section>
          <section>
            <h3>{t('crew.allow')}</h3>
            <p>{t('agentcard.allow.desc')}</p>
            <Seg label={t('crew.allow')} value={crew.allow === 'all' ? 'all' : 'owner'} onPick={(v) => save({ allow: v, allow_users: [] }, 'crew.allow.saved')} disabled={busy || !!locks.allow} options={['owner', 'all'].map((v) => ({ v, label: t(`agentcard.allow.${v}`) }))} />
            {locks.allow && lockNote(locks.allow)}
          </section>
        </>)}
      </aside>
    </div>
  );
}

/* ─── 폰 설정 > 조직 프로필·계정(조직마다): 그 조직에서의 내 역할·표시명·부서·직급. 부서·직급은 본인만 정한다(서버 msgr_set_member_profile — 20260924150000, 관리자도 남의 것은 못 바꾼다) ─── */
function OrgProfileCard({ org, me, uid, onChanged, onNote, onError }) {
  const { t } = useT();
  const [profiles, reload] = useMemberProfiles(org.id, true);
  return (
    <section className="msgr-setcard">
      <h2>{t('phone.set.orgProfile.title')}</h2><p>{t('phone.set.orgProfile.desc')}</p>
      <div className="row"><span className="msgr-klabel">{t('phone.set.role')}</span><span className="ph-rolepill">{t(`role.${org.role}`)}</span></div>
      {me && <DisplayNameRow org={org} me={me} onChanged={onChanged} onNote={onNote} onError={onError} />}
      <div className="row ph-deptrow"><span className="msgr-klabel">{t('phone.set.deptTitle')}</span><MemberProfile org={org} m={{ user_id: uid }} uid={uid} profiles={profiles} reload={reload} onNote={onNote} onError={onError} t={t} /></div>
      <p className="note">{t('phone.set.deptTitle.note')}</p>
    </section>
  );
}
/* ─── 폰 설정 > 기억: 채널별 '에이전트 기억' 켜기·끄기 — 바꾸는 것은 채널 관리자(만든 사람·채널장·조직 관리자, 최종 판정은 RLS·정책 트리거), 조직 정책으로 고정이면 잠금 ─── */
function MemoryChannelsCard({ channels = [], uid, isAdmin, locked, onToggle }) {
  const { t } = useT();
  const [busy, setBusy] = useState(null);
  const list = channels.filter((c) => c.kind !== 'dm').sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
  return (
    <section className="msgr-setcard">
      <h2>{t('phone.set.chMemory')}</h2><p>{t('phone.set.chMemory.desc')}</p>
      {locked && <p className="note ph-locknote"><I name="lock" size={13} /> {t('phone.set.chMemory.locked')}</p>}
      <div className="ph-memtoggles">{list.map((c) => { const can = !locked && (isAdmin || c.created_by === uid || (c.admin_user_ids ?? []).includes(uid)); return (
        <label key={c.id} className={`switchrow ph-memtoggle${can ? '' : ' ro'}`}><input type="checkbox" checked={c.crew_memory !== false} disabled={!can || busy === c.id} onChange={async () => { setBusy(c.id); try { await onToggle?.(c); } finally { setBusy(null); } }} /><span className="name"><I name={c.kind === 'private' ? 'lock' : 'hash'} size={13} />{c.name}</span>{!can && <span className="msgr-klabel">{locked ? t('phone.set.chMemory.lockedShort') : t('phone.set.chMemory.hostOnly')}</span>}</label>); })}</div>
      {!list.length && <p className="empty">{t('ch.noneYet.short')}</p>}{/* 설정 화면에는 + 가 없다 — '+ 로 만드세요'를 빼고 사실만(2차 검수 L-b) */}
    </section>
  );
}

/* ─── 폰 조직 설정 '기록'(관리자) — 감사 로그를 문장으로(활동 페이지와 같은 문장 사전). 열 때 한 번 읽는다(주기 호출 없음) ─── */
function OrgAuditCard({ org, channels = [], crews = [], nameOfUser, onError }) {
  const { t, lang } = useT();
  const [rows, setRows] = useState(null); const [limit, setLimit] = useState(60);
  useEffect(() => { let live = true; q(supabase.from('msgr_audit_log').select('id, actor_user_id, actor_crew_id, action, target_kind, target_id, meta, at').eq('org_id', org.id).order('at', { ascending: false }).limit(200)).then((r) => { if (live) setRows(r); }).catch((e) => { if (live) { setRows([]); onError(e.message); } }); return () => { live = false; }; }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const chName = (id) => channels.find((c) => c.id === id)?.name ?? t('act.deletedChannel');
  const crewName = (id) => crews.find((c) => c.id === id)?.display_name ?? t('act.deletedCrew');
  const roleName = (r) => (r ? t(`role.${r}`) : '');
  const shown = (rows ?? []).slice(0, limit);
  const days = []; for (const r of shown) { const d = dayKey(r.at); const g = days.find((x) => x.d === d); if (g) g.rows.push(r); else days.push({ d, at: r.at, rows: [r] }); }
  return (
    <section className="msgr-setcard ph-audit">
      <h2>{t('set.tab.audit')}</h2>
      {rows === null && <p className="note" role="status">{t('ui.loading')}</p>}
      {rows !== null && !rows.length && <p className="empty">{t('act.empty')}</p>}
      {days.map((g) => (<div key={g.d} className="day"><div className="daylabel msgr-klabel">{fmtDay(g.at, lang).join(' · ')}</div>
        {g.rows.map((r) => <div key={r.id} className="row"><span className="msgr-klabel">{fmtTs(r.at, lang)}</span><span className="text">{activitySentence({ r, t, lang, nameOfUser, chName, crewName, docTitle: () => null, roleName })}</span></div>)}</div>))}
      {(rows?.length ?? 0) > shown.length && <div className="row"><button type="button" className="btn sm" onClick={() => setLimit((n) => n + 60)}>{t('act.more')}</button></div>}
    </section>
  );
}

/* ─── 조직 문서(G-1): 전사(rules/·glossary/·projects/) + 채널 범위. 정본은 서버, 편집권은 RLS(msgr_can_edit_doc) — 화면은 힌트만 ─── */
/* journal/은 크루 답글마다 서버 트리거가 채널별 일지(journal/YYYY-MM-DD.md)를 자동 갱신하는 폴더 — 사람이 새로 만드는 자리(MemNew)에서는 뺀다. */
const DOC_FOLDERS = ['rules', 'glossary', 'projects', 'journal'];
export { docSlug }; // 정본은 doc-path.mjs(경로 규칙·충돌 접미와 함께)
/* ─── F2-3 본인 표시명 편집(RLS msgr_members_update_self — 역할·제거 표시는 트리거가 막는다) ─── */
// 설정 이름 칸과 첫 진입 이름 카드(D5)가 같이 쓴다 — 오류 문구(없으면 null)를 돌려준다. RLS가 오류 없이 0행을 돌려주면 바뀐 게 없다(noEdit, #656 검수)
const saveMyOrgName = async (org, me, name, t) => {
  const res = await supabase.from('msgr_org_members').update({ display_name: name.trim() || null }).eq('org_id', org.id).eq('user_id', me.user_id).select('user_id');
  if (res.error) return friendlyErr(res.error.message, t);
  if (!res.data?.length) return t('set.name.noEdit');
  return null;
};
function DisplayNameRow({ org, me, onChanged, onNote, onError }) {
  const { t } = useT();
  const [name, setName] = useState(me.display_name ?? ''); const [busy, setBusy] = useState(false);
  useEffect(() => { setName(me.display_name ?? ''); }, [me.display_name]);
  const save = async () => {
    setBusy(true);
    const err = await saveMyOrgName(org, me, name, t);
    setBusy(false);
    if (err) return onError(err);
    onNote(t('set.name.saved')); onChanged();
  };
  return (
    <div className="row">
      <span className="msgr-klabel">{t('set.name')}</span>
      <input className="msgr-input inline" value={name} maxLength={40} placeholder={t('set.name.placeholder')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      <button type="button" className="btn btn-primary sm" disabled={busy || name.trim() === (me.display_name ?? '')} onClick={save}><I name="check" size={13} />{t('ui.save')}</button>
    </div>
  );
}

// 첫 진입 이름 카드(D5) — 가입 때 이름을 묻지 않아 조직 표시 이름이 이메일 앞부분이다. 비었거나 앞부분과 같으면 한 번 묻는다(저장·건너뛰기, 조직별로 기억)
function NamePrompt({ org, me, email, onChanged, onNote, onError }) {
  const { t } = useT();
  const local = (email ?? '').split('@')[0];
  const key = `argo-msgr-name-asked:${org.id}`;
  const [done, setDone] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const need = !!me && (!me.display_name || me.display_name === local);
  if (done || !need) return null;
  const close = () => { try { localStorage.setItem(key, '1'); } catch { /* 저장 못 해도 이번엔 닫는다 */ } setDone(true); };
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true); const err = await saveMyOrgName(org, me, name, t); setBusy(false);
    if (err) return onError(err); // 바뀌지 않았으면 '물어봄'을 적지 않는다 — 다음에 다시 묻는다
    onNote(t('set.name.saved')); close(); onChanged();
  };
  return (
    <form className="msgr-nameprompt" onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }} aria-label={t('name.prompt.title')}>
      <div className="txt"><b>{t('name.prompt.title')}</b><span>{t(me.display_name ? 'name.prompt.desc' : 'name.prompt.desc.empty', { local })}</span></div>
      <input className="msgr-input inline" value={name} maxLength={40} placeholder={t('set.name.placeholder')} aria-label={t('set.name')} onChange={(e) => setName(e.target.value)} />
      <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={busy || !name.trim()}><I name="check" size={13} />{t('ui.save')}</button><button type="button" className="btn sm ghost" onClick={close}>{t('name.prompt.skip')}</button></div>
    </form>
  );
}

/* ─── 알림 소리 선택(유건 2026-09-12) — 합성 음원 5종, 이 기기에만 저장. 폰은 바꾸면 토큰을 다시 등록해 푸시 소리도 바뀐다 ─── */
function SoundRow() {
  const { t } = useT();
  const [sound, setSnd] = useState(getSound());
  const soundId = useId();
  const pick = (v) => { setSound(v); setSnd(v); playChime(v); if (isMobilePlatform) registerPush(supabase); };
  return (
    <div className="msgr-sound">
      <label className="msgr-klabel" htmlFor={soundId}>{t('set.sound')}</label>
      <div className="msgr-sound-controls">
        <div className="msgr-sound-select">
          <select className="msgr-select" id={soundId} value={sound} onChange={(e) => pick(e.target.value)}>
            {SOUNDS.map((v) => <option key={v} value={v}>{t(`sound.${v}`)}</option>)}
          </select>
        </div>
        <button type="button" className="btn sm ghost" onClick={() => playChime(sound)}>{t('set.sound.preview')}</button>
      </div>
    </div>
  );
}

/* ─── 진단(유건 2026-09-12 "빈 화면"): 이 기기의 최근 오류·이동 기록 — 재현 없이도 무슨 일이 있었는지 본다 ─── */
function DiagRow() {
  const { t } = useT();
  const [list, setList] = useState(() => readDiag());
  const [open, setOpen] = useState(false);
  const errs = list.filter((e) => e.kind === 'error' || e.kind === 'rejection' || e.kind === 'render').length;
  return (
    <details className="msgr-diag" open={open} onToggle={(e) => { setOpen(e.currentTarget.open); if (e.currentTarget.open) setList(readDiag()); }} style={{ flexBasis: '100%' }}>
      <summary className="msgr-klabel">{t('set.diag')} · {list.length}{errs > 0 && <span className="msgr-badge" style={{ marginLeft: 6 }}>{errs}</span>}</summary>
      {!list.length ? <p className="note">{t('set.diag.none')}</p> : <ul className="msgr-diaglist">{list.map((e, i) => <li key={i}><span className="mono">{e.at.slice(11, 19)}</span> <b>{e.kind}</b> {e.message}{e.extra && <span className="note"> — {e.extra.slice(0, 160)}</span>}</li>)}</ul>}
      <button type="button" className="btn sm ghost" onClick={() => { clearDiag(); setList([]); }}>{t('set.diag.clear')}</button>
    </details>
  );
}

/* ─── F2-5 로컬 알림(새 메시지가 오면 OS 알림) — 권한은 여기서만 요청 ─── */
function NotifyRow() {
  const { t } = useT();
  const [perm, setPerm] = useState('loading');
  useEffect(() => { let on = true; notifyPermission().then((p) => { if (on) setPerm(p); }); return () => { on = false; }; }, []);
  if (isMobilePlatform) return <span className="note">{t('set.notify.mobile')}</span>;
  if (perm === 'loading') return null;
  if (perm === 'unsupported') return <span className="note">{t('set.notify.unsupported')}</span>;
  if (perm === 'granted') return <span className="note"><I name="check" size={12} /> {t('set.notify.on')}</span>;
  if (perm === 'denied') return <span className="note">{t(isDesktopTauri() ? 'set.notify.deniedApp' : 'set.notify.denied')}</span>;
  return <button type="button" className="btn sm" onClick={async () => setPerm(await requestNotifyPermission())}><I name="bell" size={13} />{t('set.notify.ask')}</button>;
}

// 부적절 표현 가리기 켜고 끄기(App Store 1.2, 2026-09-26) — 기본 켜짐, localStorage에 기기별로 저장
function ProfanityFilterRow() {
  const { t } = useT();
  const on = useProfanityFilterOn();
  return (
    <label className="switchrow"><input type="checkbox" checked={on} onChange={(e) => writeProfanityFilterOn(e.target.checked)} /><span>{t('set.profanityFilter')}</span></label>
  );
}

// 사전 문구 속 `백틱`을 <code>로 그린다(글자 그대로 찍지 않는다 — 에이전트·서버 탭 설치 안내, UX 점검 D 2026-10-01)
function InlineCode({ text }) {
  return <span>{splitInlineCode(text).map((p, i) => (p.code != null ? <code key={i} className="inl">{p.code}</code> : p.text))}</span>; // 한 덩어리 span — flex 부모(.msgr-auto p)에서도 글이 이어진다
}

// App Store 5.1.2 — 설정에서 동의 철회·재동의(2026-09-26). 전송 전 동의 창(Composer)과 같은 SafetyCtx 상태를 공유한다.
function AiConsentRow({ t, onError, hasOrg = true }) {
  const { aiConsented, setAiConsent } = useContext(SafetyCtx);
  const [busy, setBusy] = useState(false); const [ask, setAsk] = useState(false); // ask — 철회 확인 창(바로 적용하면 조직 공간이 잠긴다)
  const copy = aiConsentCopy({ consented: aiConsented, hasOrg });
  const toggle = async () => {
    setBusy(true);
    try { await setAiConsent(!aiConsented); setAsk(false); } catch { onError?.(t('consent.ai.failed')); } finally { setBusy(false); }
  };
  return (
    <div className="row">
      <span className="note">{t(copy.status)}</span>
      <button type="button" className="btn sm" disabled={busy} onClick={aiConsented ? () => setAsk(true) : toggle}>{t(aiConsented ? 'set.aiConsent.revoke' : 'set.aiConsent.grant')}</button>
      {ask && aiConsented && <ConfirmModal title={t('set.aiConsent.revoke.title')} description={t(copy.revokeDesc)} confirmLabel={t('set.aiConsent.revoke')} busy={busy} onConfirm={toggle} onClose={() => { if (!busy) setAsk(false); }} />}
    </div>
  );
}

/* ─── F2-1·2·3·4 조직 카드(관리자): 조직 이름 · 멤버 역할/제거(2단계) · 초대 만들기/취소 · 감사 기록 ─── */
const ROLES_ASSIGNABLE = ['admin', 'member', 'guest'];
// 초대 관리 목록 한 줄(설계서 2-3) — 들어갈 채널 칩, 역할, 사용 횟수, 남은 날, 만든 사람, [복사] [취소]. 지난 초대는 상태만.
function InviteRow({ inv, channels, nameOfUser, busy = false, onCopy = null, onRevoke = null }) {
  const { t } = useT();
  const st = inviteStatus(inv); const left = daysLeft(inv);
  const chs = (inv.channel_ids ?? (inv.channel_id ? [inv.channel_id] : [])).map((id) => channels.find((c) => c.id === id)).filter(Boolean);
  const uses = inv.max_uses === undefined ? null : t('inv.m.used', { n: inv.use_count ?? 0 }); // 5차 피드백: '사용 n회 · m일 남음'
  const when = st !== 'live' ? t(`inv.m.state.${st}`) : left == null ? t('inv.expiry.never') : left === 0 ? t('inv.m.leftToday') : t('inv.m.left', { n: left });
  const chip = chipPreview(chs); // 채널 칩은 둘까지, 나머지 +N
  return (
    <div className="row inv-row-m">
      <span className="name">{t(`org.invite.kind.${inv.role}`)}</span>
      <span className="inv-chips">{chs.length ? <>{chip.shown.map((c) => <span key={c.id} className="inv-chip sm"><I name={c.kind === 'private' ? 'lock' : 'hash'} size={11} /><span>{c.name}</span></span>)}{chip.more > 0 && <span className="inv-chip sm more" title={chs.slice(2).map((c) => c.name).join(', ')}>+{chip.more}</span>}</> : <span className="msgr-klabel">{t('inv.m.orgOnly')}</span>}</span>
      <span className="sub">{[uses, when].filter(Boolean).join(' · ')}</span>
      {onCopy && <button type="button" className="btn sm ghost" onClick={onCopy} title={t('org.invite.copy')} aria-label={t('org.invite.copy')}><I name="copy" size={13} /></button>}
      {onRevoke && <button type="button" className="btn sm ghost" disabled={busy} onClick={onRevoke} title={t('org.invite.revoke')} aria-label={t('org.invite.revoke')}><I name="x" size={13} /></button>}
    </div>
  );
}
/** 부서·직급 — 본인이 정한다(msgr_set_member_profile, 유건 2026-09-24). 남의 것은 글자로만. 기억 자동 연결(같은 부서)의 재료. 옛 서버엔 열이 없어 null → 숨긴다. */
function useMemberProfiles(orgId, active) {
  const [profiles, setProfiles] = useState(null);
  const load = useCallback(async () => { const r = await supabase.from('msgr_org_members').select('user_id, department, title').eq('org_id', orgId).is('removed_at', null); setProfiles(r.error ? null : new Map((r.data ?? []).map((x) => [x.user_id, x]))); }, [orgId]);
  useEffect(() => { if (active) load().catch(() => setProfiles(null)); }, [active, load]);
  return [profiles, load];
}
function MemberProfile({ org, m, uid, profiles, reload, onNote, onError, t }) {
  if (!profiles || m.user_id === org.service_user_id) return null;
  const cur = profiles.get(m.user_id) ?? {};
  if (m.user_id !== uid) return cur.department || cur.title ? <span className="sub msgr-profile-text">{[cur.department, cur.title].filter(Boolean).join(' · ')}</span> : null;
  const save = async (patch) => { // patch = 두 칸의 지금 값 — 한 칸 저장 직후 다른 칸을 저장해도 방금 값이 옛 값으로 되돌아가지 않는다(재검수 #699 N2)
    const next = { department: cur.department ?? '', title: cur.title ?? '', ...patch };
    if ((cur.department ?? '') === next.department && (cur.title ?? '') === next.title) return;
    const res = await supabase.rpc('msgr_set_member_profile', { org: org.id, member: uid, dept: next.department, job: next.title });
    if (res.error) return onError(/msgr_member_profile_forbidden/.test(res.error.message) ? t('org.member.profileForbidden') : friendlyErr(res.error.message, t));
    onNote(t('org.member.profileSavedMine')); reload().catch(() => {});
  };
  return <span className="msgr-profile">{['department', 'title'].map((k) => <input key={`${k}:${cur[k] ?? ''}`} className="msgr-input sm" maxLength={60} defaultValue={cur[k] ?? ''} placeholder={t(`org.member.${k}`)} aria-label={t(`org.member.${k}`)} onBlur={(e) => { const [department, title] = [...e.currentTarget.parentElement.querySelectorAll('input')].map((i) => i.value.trim()); save({ department, title }); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />)}</span>;
}
// 폰 조직 설정 멤버 탭(5차 피드백, 유건 2026-10-02) — 맨 위 나(사진·이름·역할 한 줄 + 부서·직급 칸), 검색(이름·부서)·역할 칩, 나머지는 친구 줄처럼(버튼 없음).
// 줄을 누르면 시트: 이름·부서·직급(보기), 역할 바꾸기·내보내기는 권한이 있을 때만(memberPerms). onRole·onRemove는 관리자 화면(OrgCard)만 넘긴다. 데스크톱은 종전 목록.
function PhoneMembers({ org, uid, members, onRole = null, onRemove = null, busy = false, onNote, onError }) {
  const { t, lang } = useT();
  const [profiles, reload] = useMemberProfiles(org.id, true);
  const [q, setQ] = useState(''); const [chip, setChip] = useState('all'); const [openId, setOpenId] = useState(null); const [confirm, setConfirm] = useState(false);
  const svc = org.service_user_id ?? null;
  const me = members.find((m) => m.user_id === uid) ?? null;
  const rows = memberRows(members, { uid, profiles, serviceId: svc, chip, q });
  const cur = openId ? memberRows(members, { uid, profiles, serviceId: svc }).find((m) => m.user_id === openId) ?? null : null; // 역할을 바꾸면 새 목록에서 다시 읽는다
  const perms = memberPerms({ viewerRole: org.role, target: cur, uid, serviceId: svc });
  const nameOf = (m) => m.display_name || m.user_id.slice(0, 8);
  const roleOf = (m) => (m.user_id === svc ? t('org.node') : t(`role.${m.role}`));
  const close = () => { if (!busy) { setOpenId(null); setConfirm(false); } };
  useEffect(() => { if (!openId) return undefined; const k = (e) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    {me && <section className="msgr-setcard ph-memme">
      <div className="ph-memme-head"><Av name={nameOf(me)} size="lg" userId={uid} /><span className="name">{nameOf(me)}</span><span className="role">{t(`role.${me.role}`)}</span></div>
      <MemberProfile org={org} m={me} uid={uid} profiles={profiles} reload={reload} onNote={onNote} onError={onError} t={t} />
    </section>}
    <section className="msgr-setcard ph-memlist">
      <h2>{t('org.members')} · {members.length}</h2>
      <div className="ph-search ph-memsearch" role="search"><I name="search" size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('phone.mem.search')} aria-label={t('phone.mem.search')} enterKeyHint="search" /></div>
      <div className="ph-chips" role="radiogroup" aria-label={t('org.member.role')}>{MEMBER_CHIPS.map((k) => <button key={k} type="button" role="radio" aria-checked={chip === k} className={chip === k ? 'active' : ''} onClick={() => setChip(k)}>{k === 'all' ? t('phone.chip.all') : t(`role.${k}`)}</button>)}</div>
      <div className="ph-memrows">{rows.map((m) => (
        <button key={m.user_id} type="button" className="ph-memrow" onClick={() => setOpenId(m.user_id)}>
          <Av name={nameOf(m)} size="lg" userId={m.user_id} /><span className="ph-kbody"><span className="name">{nameOf(m)}</span>{m.sub && <span className="snip">{m.sub}</span>}</span><span className="role">{roleOf(m)}</span>
        </button>))}</div>
      {!rows.length && <p className="empty">{t('org.members.noMatch')}</p>}
    </section>
    {cur && <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={close} />
      <section className="msgr-crewsheet msgr-dmpeek ph-friendadd ph-memsheet" role="dialog" aria-label={nameOf(cur)}>
        <header className="head"><strong>{nameOf(cur)}</strong><button type="button" className="msgr-titlebtn" onClick={close} aria-label={t('ui.close')}><I name="x" size={16} /></button></header>
        <div className="peek">
          <div className="ph-memwho"><Av name={nameOf(cur)} size="lg" userId={cur.user_id} /><span className="ph-kbody"><span className="name">{nameOf(cur)}</span><span className="snip">{roleOf(cur)}</span></span></div>
          <dl className="ph-memfacts">
            <div><dt>{t('org.member.department')}</dt><dd>{cur.department || '—'}</dd></div>
            <div><dt>{t('org.member.title')}</dt><dd>{cur.title || '—'}</dd></div>
            {cur.expires_at && <div><dt>{t('role.guest')}</dt><dd>{Date.parse(cur.expires_at) < Date.now() ? t('org.guest.expired') : t('org.guest.until', { when: fmtWhen(cur.expires_at, lang) })}</dd></div>}
          </dl>
          {perms.canRole && onRole && <><h3>{t('org.member.role')}</h3><Seg label={t('org.member.role')} value={cur.role} onPick={(r) => onRole(cur, r)} disabled={busy} options={ROLES_ASSIGNABLE.map((r) => ({ v: r, label: t(`role.${r}`) }))} /></>}
          {cur.role === 'owner' && <p className="note">{t('phone.mem.ownerLocked')}</p>}
          {perms.canRemove && onRemove && <button type="button" className="btn danger ph-memremove" disabled={busy} onClick={() => setConfirm(true)}>{t('phone.mem.remove')}</button>}
        </div>
      </section>
    </div>}
    {cur && confirm && createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t('phone.mem.remove')}>
      <ConfirmModal title={t('phone.mem.remove.title', { name: nameOf(cur) })} description={t('phone.mem.remove.note')} confirmLabel={t('phone.mem.remove')} busy={busy}
        onConfirm={async () => { await onRemove(cur); setConfirm(false); setOpenId(null); }} onClose={() => { if (!busy) setConfirm(false); }} />
    </div>, document.body)}
  </>);
}
/** 관리자가 아닌 사람의 멤버 탭 — 이름·역할 + 내 부서·직급 칸(남은 글자). 재검수 #699 H1: 이 갈래엔 칸이 없어 멤버·게스트가 자기 부서를 못 정했다. */
function MemberListCard({ org, uid, members, onNote, onError, t, editSelf = true }) { // editSelf=false: 폰 조직 프로필 화면 — 내 칸은 위 카드에 있어 목록은 보기만
  const [profiles, reload] = useMemberProfiles(org.id, true);
  return (<section className="msgr-setcard"><h2>{t('org.members')} · {members.length}</h2><div className="msgr-rows">{members.map((m) => <div key={m.user_id} className="row"><Av name={m.display_name || m.user_id} size="sm" userId={m.user_id} /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span><span className="sub">{m.user_id === org.service_user_id ? t('org.node') : t(`role.${m.role}`)}{m.user_id === uid ? ` · ${t('ui.me')}` : ''}</span><MemberProfile org={org} m={m} uid={editSelf ? uid : null} profiles={profiles} reload={reload} onNote={onNote} onError={onError} t={t} /></div>)}</div></section>);
}
function OrgCard({ org, orgs = [], uid, invitesTick = 0, members, channels = [], onInvite = null, nameOfUser, onChanged, onOrgsChanged, onNote, onError, part = 'org', myEmail = '', onOpenCrew, ent = null }) {
  const { t, lang } = useT();
  const phone = useIsPhone(); // 폰 에이전트 연결 화면: 설명 2줄 이내·연결 칩 네 개 같은 모양(4차 피드백). 데스크톱은 그대로
  const [name, setName] = useState(org.name); const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState([]);
  const [confirmRemove, setConfirmRemove] = useState(null); const [audit, setAudit] = useState(null); const [memberQ, setMemberQ] = useState(''); const [memberN, setMemberN] = useState(30);
  const isOwner = org.role === 'owner';
  const admins = members.filter((m) => m.role === 'admin' && m.user_id !== org.service_user_id); // J-2: 이전 제안·승계 대상은 활성 관리자만(서버 트리거와 같은 규칙), 서비스 계정 제외
  const iAmNominee = org.pending_owner_user_id === uid;
  const myDomain = String(myEmail ?? '').split('@')[1]?.toLowerCase() ?? ''; // 등록 가능한 도메인은 소유자 로그인 이메일 도메인뿐 — 입력창 대신 토글(UX 2/3)
  const domainOn = !!org.auto_join_domain;
  const toggleDomain = () => patchOrg({ auto_join_domain: domainOn ? null : myDomain, auto_join_role: 'member' }, domainOn ? t('org.domain.off') : t('org.domain.saved'));
  const [transfer, setTransfer] = useState(null); // null | 'pick' | <userId 확인 단계>
  const [nodeGuide, setNodeGuide] = useState(false);
  const nodeSet = !!org.service_user_id; // 서버 계정이 지정돼 있는가(실측: 채널 시트의 이름을 그대로 써 ReferenceError → 앱 전체 빈 화면)
  const [delName, setDelName] = useState(null); // J-5: 이름을 그대로 입력해야 삭제(깃헙식 확인 — 네이티브 confirm 금지)
  const deleteOrg = async () => {
    if (delName.trim() !== org.name) return;
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update({ deleted_at: new Date().toISOString() }).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_owner_only/.test(res.error.message) ? t('org.noEdit') : res.error.message);
    if (!res.data?.length) return onError(t('org.noEdit'));
    setDelName(null); onNote(t('org.delete.done', { name: org.name })); onOrgsChanged();
  };
  const patchOrg = async (patch, okMsg) => {
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update(patch).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_transfer_not_admin|msgr_successor_not_admin/.test(res.error.message) ? t('org.owner.notAdmin') : /msgr_domain_public/.test(res.error.message) ? t('org.domain.public') : /msgr_domain_not_owners/.test(res.error.message) ? t('org.domain.notOwners') : /msgr_owner_only/.test(res.error.message) ? t('org.noEdit') : friendlyErr(res.error.message, t));
    if (!res.data?.length) return onError(t('org.noEdit'));
    if (okMsg) onNote(okMsg); onOrgsChanged(); onChanged();
  };
  useEffect(() => { setName(org.name); }, [org.id, org.name]);
  const invSeq = useRef(0); // 늦게 끝난 옛 읽기가 새 목록을 덮지 않게 — 초대 창을 닫을 때의 다시 읽기와 '관리자로 초대' 뒤 다시 읽기가 겹쳤다(실측: 만든 관리자 링크가 안 보이고 다음 누름이 또 만들었다)
  const loadInvites = useCallback(async () => {
    const my = ++invSeq.current;
    const base = 'id, code, role, email, for_node, expires_at, accepted_by, accepted_at, created_at';
    const pick = (cols) => supabase.from('msgr_invites').select(cols).eq('org_id', org.id).order('created_at', { ascending: false });
    let res = await pick(`${base}, created_by, channel_ids, max_uses, use_count, revoked_at`);
    if (res.error && missingFn(res.error)) res = await pick(base); // 옛 서버(채널·사용 한도 열 없음) — 목록 상태는 inviteStatus가 accepted_at으로 판정
    if (res.error) throw new Error(res.error.message);
    if (my === invSeq.current) setInvites(res.data ?? []);
  }, [org.id]);
  useEffect(() => { loadInvites().catch((e) => onError(e.message)); }, [loadInvites]); // eslint-disable-line react-hooks/exhaustive-deps
  const seenTick = useRef(invitesTick); useEffect(() => { if (part !== 'members' || seenTick.current === invitesTick) return; seenTick.current = invitesTick; loadInvites().catch((e) => onError(e.message)); }, [invitesTick]); // eslint-disable-line react-hooks/exhaustive-deps -- 초대 창에서 링크를 만들거나 버린 뒤 닫았을 때만(마운트 직후는 위 효과가 이미 읽는다)
  const saveName = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update({ name: name.trim() }).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
    if (!res.data?.length) return onError(t('org.noEdit'));
    onNote(t('org.name.saved')); onOrgsChanged();
  };
  const [profiles, loadProfiles] = useMemberProfiles(org.id, part === 'members' && !phone); // 폰은 PhoneMembers가 읽는다
  const setRole = async (m, role) => {
    if (role === m.role) return;
    setBusy(true);
    const res = await supabase.from('msgr_org_members').update({ role }).eq('org_id', org.id).eq('user_id', m.user_id).select('user_id');
    setBusy(false);
    if (res.error) return onError(/msgr_owner_only|msgr_member_self_only_name/.test(res.error.message) ? t('org.member.noEdit') : res.error.message);
    if (!res.data?.length) return onError(t('org.member.noEdit'));
    onNote(t('org.member.roleSaved', { name: m.display_name || m.user_id.slice(0, 8), role: t(`role.${role}`) })); onChanged();
  };
  const remove = async (m) => {
    setBusy(true);
    const res = await supabase.from('msgr_org_members').update({ removed_at: new Date().toISOString() }).eq('org_id', org.id).eq('user_id', m.user_id).select('user_id');
    setBusy(false); setConfirmRemove(null);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('org.member.noEdit'));
    onNote(t('org.member.removed', { name: m.display_name || m.user_id.slice(0, 8) })); onChanged();
  };
  const makeInvite = async (role = 'member') => {
    setBusy(true);
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role, created_by: uid }).select('code, expires_at').single();
    setBusy(false);
    if (res.error) return onError(res.error.message);
    const share = inviteShareText(res.data.code, { origin: location.origin, pathname: location.pathname, t, inviter: nameOfUser(uid), org: org.name, days: daysLeft(res.data) });
    loadInvites().catch(() => {}); // 목록 먼저 — 클립보드 약속이 끝나지 않으면(권한 대기) 만든 링크가 목록에 안 보이고 다음 누름이 또 만들었다(실측)
    navigator.clipboard?.writeText(share).catch(() => {});
    onNote(`${t('org.inviteMade')} ${share}`);
  };
  const revoke = async (inv) => {
    setBusy(true);
    try { await revokeInvite(supabase, inv.id); } catch (e) { setBusy(false); return onError(e.message === 'msgr_invite_not_found' ? t('org.member.noEdit') : friendlyErr(e.message, t)); }
    setBusy(false);
    onNote(t('org.invite.revoked')); loadInvites().catch(() => {});
  };
  const loadAudit = async () => {
    const rows = await q(supabase.from('msgr_audit_log').select('id, actor_user_id, actor_crew_id, action, target_kind, target_id, meta, at').eq('org_id', org.id).order('at', { ascending: false }).limit(50));
    setAudit(rows);
  };
  const copyLink = async (inv) => { const share = inviteShareText(inv.code, { origin: location.origin, pathname: location.pathname, t, inviter: nameOfUser(inv.created_by ?? uid), org: org.name, channels: (inv.channel_ids ?? (inv.channel_id ? [inv.channel_id] : [])).map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean), days: daysLeft(inv) }); await navigator.clipboard?.writeText(share).catch(() => {}); onNote(`${t('org.invite.copied')} ${share}`); };
  const live = invites.filter((i) => inviteStatus(i) === 'live');
  const open = shownInvites(invites); const nodeInvite = live.find((i) => i.for_node) ?? null; // 멤버·관리자는 지금 링크 하나씩, 만료·취소·소진·이전 링크는 숨긴다(5차 피드백 — 지우지 않는다, 서버가 30일 뒤 정리). 노드용 코드는 사람 초대 목록에 섞지 않는다(I-4)
  const memberLink = currentLink(invites, 'member'); const adminLink = currentLink(invites, 'admin');
  const adminInvite = () => (adminLink ? copyLink(adminLink) : makeInvite('admin')); // 관리자 링크도 하나 — 있으면 그 링크를 복사한다
  const nodeCmd = nodeInvite ? `ARGO_NODE_CODE=${nodeInvite.code} node scripts/msgr-node-bootstrap.mjs` : '';
  const nodeSeen = org.node_seen_at ? Date.parse(org.node_seen_at) : 0; const nodeAlive = !!org.service_user_id && nodeSeen > 0 && Date.now() - nodeSeen < AWAY_MS;
  const nodeStatus = !org.service_user_id ? t('org.node.none') : !nodeSeen ? t('org.node.never') : t(nodeAlive ? 'org.node.on' : 'org.node.off', { when: fmtWhen(org.node_seen_at, lang) });
  const makeNodeInvite = async () => {
    setBusy(true);
    if (nodeInvite) { const d = await supabase.from('msgr_invites').delete().eq('id', nodeInvite.id); if (d.error) { setBusy(false); return onError(d.error.message); } } // 노드 코드는 한 번에 하나 — 다시 만들면 이전 코드 취소(안내 문구와 같은 계약)
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role: 'member', for_node: true, created_by: uid }).select('code').single();
    setBusy(false);
    if (res.error) return onError(res.error.message);
    onNote(t('org.node.made')); loadInvites().catch(() => {});
  };
  const copyNodeCmd = async () => { await navigator.clipboard?.writeText(nodeCmd).catch(() => {}); onNote(t('org.node.copied')); };
  const nodeCmdBlock = nodeInvite && (<>
    <code>{nodeCmd}</code>
    <div className="acts"><button type="button" className="btn sm" onClick={copyNodeCmd}><I name="copy" size={13} />{t('org.node.copy')}</button><button type="button" className="btn sm ghost" disabled={busy} onClick={makeNodeInvite}>{t('org.node.remake')}</button><button type="button" className="btn sm ghost" disabled={busy} onClick={() => revoke(nodeInvite)}>{t('org.invite.revoke')}</button><span className="msgr-klabel">{t('org.invite.expires', { when: fmtWhen(nodeInvite.expires_at, lang) })}</span></div>{/* 복사·다시 만들기·취소·만료 안내를 한 줄에 — 따로 둔 둘째 줄은 자리가 남아도 아래로 내려갔다(LA-26) */}
  </>);
  // 멤버가 50·100명이 되어도 한 화면에 다 쌓지 않는다(유건 질문 2026-09-09): 검색 + 30명씩 더 보기. 목록 자체는 조직 멤버 표 전체를 이미 받아 두므로 서버 페이징은 1,000명 넘을 때(v2).
  if (part === 'members') { const q = memberQ.trim().toLowerCase(); const shown = members.filter((m) => !q || (m.display_name || '').toLowerCase().includes(q) || (m.user_id || '').includes(q)); return (
    <>{phone && <PhoneMembers org={org} uid={uid} members={members} busy={busy} onRole={setRole} onRemove={remove} onNote={onNote} onError={onError} />}
    <section className="msgr-setcard">
      {!phone && <><h2>{t('org.members')} · {members.length}</h2>
      {members.length > 8 && <input className="msgr-input sm" value={memberQ} onChange={(e) => { setMemberQ(e.target.value); setMemberN(30); }} placeholder={t('org.members.search')} aria-label={t('org.members.search')} />}
      <div className="msgr-rows">
        {shown.slice(0, memberN).map((m) => { const isMe = m.user_id === uid; const isSvc = m.user_id === org.service_user_id; const canEdit = !isMe && !isSvc && m.role !== 'owner'; return (
          <div key={m.user_id} className="row">
            <Av name={m.display_name || m.user_id} size="sm" userId={m.user_id} /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span>
            {m.expires_at && <span className={`sub${Date.parse(m.expires_at) < Date.now() ? ' expired' : ''}`}>{Date.parse(m.expires_at) < Date.now() ? t('org.guest.expired') : t('org.guest.until', { when: fmtWhen(m.expires_at, lang) })}</span>}
            {isSvc ? <span className="sub">{t('org.node')}</span> : m.role === 'owner' || isMe ? <span className="sub">{t(`role.${m.role}`)}{isMe ? ` · ${t('ui.me')}` : ''}</span>
              : <Seg className="right" label={t('org.member.role')} value={m.role} onPick={(r) => setRole(m, r)} disabled={busy} options={ROLES_ASSIGNABLE.map((r) => ({ v: r, label: t(`role.${r}`) }))} />}
            <MemberProfile org={org} m={m} uid={uid} profiles={profiles} reload={loadProfiles} onNote={onNote} onError={onError} t={t} />
            {canEdit && confirmRemove !== m.user_id && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirmRemove(m.user_id)} title={t('org.member.remove')} aria-label={t('org.member.remove')}><I name="x" size={13} /></button>}
            {canEdit && confirmRemove === m.user_id && <span className="confirm-inline"><span>{t('org.member.remove.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => remove(m)}>{t('org.member.remove')}</button><button type="button" className="btn sm" onClick={() => setConfirmRemove(null)}>{t('ui.cancel')}</button></span>}
          </div>
        ); })}
        {shown.length > memberN && <div className="row"><button type="button" className="btn sm" onClick={() => setMemberN((n) => n + 30)}>{t('org.members.more', { n: shown.length - memberN })}</button></div>}
        {!shown.length && <p className="empty">{t('org.members.noMatch')}</p>}
      </div></>}
      <h3>{t('org.invites.h')}</h3>
      <p>{t('org.invites.desc2')}</p>
      <div className="row">
        {onInvite ? <button type="button" className="btn btn-primary sm" onClick={onInvite}><I name="copy" size={13} />{t(memberLink ? 'inv.m.member' : 'inv.m.new')}</button>
          : <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => (memberLink ? copyLink(memberLink) : makeInvite('member'))}><I name="copy" size={13} />{t('org.invite.member')}</button>}
        <button type="button" className="btn sm" disabled={busy} onClick={adminInvite}>{t(adminLink ? 'inv.m.adminCopy' : 'org.invite.admin')}</button>
      </div>
      {open.length > 0 && <div className="msgr-rows">{open.map((inv) => <InviteRow key={inv.id} inv={inv} channels={channels} nameOfUser={nameOfUser} busy={busy} onCopy={() => copyLink(inv)} onRevoke={() => revoke(inv)} />)}</div>}
    </section></>
  ); }

  // ── 부록 N: 외부 에이전트(헤르메스·오픈클로)는 텔레그램·슬랙에 붙듯 **봇**으로 이 메신저에 접속한다. 봇 = 회사 등급 크루 + 토큰(서버 msgr_bots).
  //    토큰 원문은 생성·회전 직후 이 화면에만 있고(setup 상태) 저장·로그하지 않는다. 가용성은 마지막 getUpdates(last_seen_at)뿐 — 종료/재시작 버튼 없음(해제 = 토큰 회수).
  const [bots, setBots] = useState([]); const [setup, setSetup] = useState(null); const [confirmRevoke, setConfirmRevoke] = useState(null); const [confirmRotate, setConfirmRotate] = useState(null); /* 토큰 다시 만들기 확인(UXM-04) — 지금 토큰이 바로 끊긴다 */ const [openBot, setOpenBot] = useState(null); const [renamingBot, setRenamingBot] = useState(null); const [renameName, setRenameName] = useState('');
  const loadBots = useCallback(async () => { if (part !== 'agents') return;
    const list = await q(supabase.from('msgr_bots').select('id, crew_id, kind, name, token_hint, created_by, created_at, rotated_at, revoked_at, last_seen_at, external_id').eq('org_id', org.id).order('created_at'));
    // 1-b: 어댑터가 보고한 버전·승인 모드·"모든 예약 작업 보기"(표가 없는 옛 서버면 빈 값 — 카드는 예전처럼)
    const ids = (list ?? []).map((b) => b.id);
    const st = ids.length ? await supabase.from('msgr_bot_state').select('bot_id, adapter_version, approval_mode, mirror_all, mirror_all_applied').in('bot_id', ids) : { data: [] };
    const byId = new Map((st.error ? [] : st.data ?? []).map((r) => [r.bot_id, r]));
    setBots((list ?? []).map((b) => ({ ...b, state: byId.get(b.id) ?? null }))); }, [org.id, part]);
  const setMirrorAll = async (b, on) => { setBusy(true); try { const r = await supabase.rpc('msgr_bot_set_mirror_all', { p_bot: b.id, p_on: on }); if (r.error) throw new Error(r.error.message); await loadBots(); } catch (e) { onError(e.message); } finally { setBusy(false); } };
  useEffect(() => { loadBots().catch((e) => onError(e.message)); }, [loadBots]); // eslint-disable-line react-hooks/exhaustive-deps
  const [auto, setAuto] = useState(null); // 원클릭 연결(앱 안에서만): null | { status: 'running'|'done'|'missing'|'failed', results:[{id,name,ok,steps}], reason }
  const [localHermes, setLocalHermes] = useState(null);
  const [remoteAgentName, setRemoteAgentName] = useState('');
  const [setups, setSetups] = useState([]); // 이번에 만든/회전한 봇들의 설정(이름·두 줄) — 토큰은 화면 상태로만
  // "다시 연결"이 재사용할 수 있는 기본 이름 — 화면 언어가 바뀌어도 같은 봇을 찾도록 두 언어 모두(bot-reuse.mjs)
  const defaultBotNames = (kind) => botDefaultNames(tm, { who: nameOfUser(uid), kind });
  const hasMine = (kind) => bots.some((b) => !b.revoked_at && b.kind === kind && b.created_by === uid); // "하나 더 추가"의 오픈클로 버튼 표시 조건(전과 같음) — 라벨 판정(reconnect)과 별개
  const reconnect = (kind) => canReconnect(bots, { kind, uid, names: defaultBotNames(kind), desktop: isDesktopTauri() }); // 버튼 라벨도 실제 재사용 판정과 같은 함수
  const botUrl = `${SB_URL}/functions/v1/msgr-bot`;
  const botSetup = (token) => `ARGO_MSGR_URL=${botUrl}\nARGO_MSGR_BOT_TOKEN=${token}`; // 다른 컴퓨터용 두 줄(설정 복사)
  const mkOrRotate = async (kind, name, extId, reuseNames = null) => { // 다시 쓸 내 봇이 있으면 회전, 없으면 생성(찾는 규칙은 bot-reuse.mjs: external_id가 같거나, reuseNames를 준 "다시 연결"에서만 같은 기본 이름의 수동 봇) — 둘 다 토큰 원문은 지금만
    const cur = findReusableBot(bots, { kind, uid, extId, names: reuseNames });
    if (cur) { const r = await supabase.rpc('msgr_bot_rotate', { bot: cur.id }); if (r.error) throw new Error(r.error.message); return { id: cur.id, crewId: cur.crew_id, token: r.data, name: cur.name, rotated: true, createdAt: cur.created_at }; }
    const r = await supabase.rpc('msgr_bot_create', { org: org.id, kind, name, external_id: extId ?? null }); if (r.error) throw new Error(r.error.message);
    return { id: r.data.bot_id, crewId: r.data.crew_id, token: r.data.token, name };
  };
  const localBot = async (targetOrgId, extId) => {
    const found = await supabase.from('msgr_bots').select('id, crew_id, name').eq('org_id', targetOrgId).eq('kind', 'hermes').eq('created_by', uid).eq('external_id', extId).is('revoked_at', null).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    return found.data;
  };
  const createLocalHermesBot = async (targetOrgId, name, extId) => {
    const current = await localBot(targetOrgId, extId);
    if (current) return { id: current.id, crewId: current.crew_id, name: current.name, existing: true };
    const created = await supabase.rpc('msgr_bot_create', { org: targetOrgId, kind: 'hermes', name, external_id: extId });
    if (created.error) throw new Error(created.error.message);
    return { id: created.data.bot_id, crewId: created.data.crew_id, token: created.data.token, name, existing: false };
  };
  const localHermesChannels = async (targetOrgId) => {
    if (targetOrgId === org.id) return channels;
    return q(supabase.from('msgr_channels').select('id, kind, name').eq('org_id', targetOrgId).neq('kind', 'dm').is('archived_at', null).order('created_at'));
  };
  const openLocalHermes = async () => {
    if (isMobilePlatform) { onNote(t('org.agents.mobile')); return; }
    setBusy(true); setLocalHermes({ status: 'loading', agents: [], agentIds: [], channelIds: [], results: [], channelResults: [] });
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const listed = await invoke('agent_list', { kind: 'hermes' });
      if (listed?.ok && listed.agents?.length) {
        setLocalHermes({ status: 'ready', agents: listed.agents, installation: listed.installationId, targetOrgId: org.id, targetChannels: channels, agentIds: listed.agents.map((a) => a.id), channelIds: [], results: [], channelResults: [] });
      } else if (listed?.reason === 'cli_missing') {
        setLocalHermes({ status: 'missing', agents: [], agentIds: [], channelIds: [], results: [], channelResults: [] });
      } else throw new Error(t('org.agents.discovery.failed'));
    } catch (e) { setLocalHermes({ status: 'failed', agents: [], agentIds: [], channelIds: [], results: [], channelResults: [], reason: String(e?.message ?? e) }); }
    finally { setBusy(false); }
  };
  const toggleLocalHermes = (key, id) => setLocalHermes((current) => {
    if (!current) return current;
    const selected = new Set(current[key] ?? []); if (selected.has(id)) selected.delete(id); else selected.add(id);
    return { ...current, [key]: [...selected] };
  });
  const chooseLocalHermesOrg = async (targetOrgId) => {
    const flow = localHermes; if (!flow || targetOrgId === flow.targetOrgId) return;
    setBusy(true); setLocalHermes({ ...flow, status: 'loadingChannels', channelIds: [] });
    try { setLocalHermes({ ...flow, status: 'ready', targetOrgId, targetChannels: await localHermesChannels(targetOrgId), channelIds: [] }); }
    catch (e) { setLocalHermes({ ...flow, status: 'failed', agents: [], agentIds: [], channelIds: [], results: [], channelResults: [], reason: String(e?.message ?? e) }); }
    finally { setBusy(false); }
  };
  const importLocalHermes = async () => {
    const flow = localHermes;
    const agents = flow?.agents?.filter((a) => flow.agentIds.includes(a.id)) ?? [];
    if (!agents.length) { onError(t('org.agents.local.pickAgent')); return; }
    setBusy(true); setSetup(null); setSetups([]); setAuto(null);
    setLocalHermes({ ...flow, status: 'connecting', results: [], channelResults: [] });
    try {
      const made = [];
      for (const agent of agents) made.push({ ...(await createLocalHermesBot(flow.targetOrgId, agent.name, externalAgentId(flow.installation, uid, 'hermes', agent.id))), agentId: agent.id, home: agent.home ?? '' });
      const reconnect = made.filter((bot) => bot.existing);
      for (const bot of reconnect) {
        const rotated = await supabase.rpc('msgr_bot_rotate', { bot: bot.id });
        if (rotated.error) throw new Error(rotated.error.message);
        bot.token = rotated.data;
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const connected = await invoke('agent_connect', { kind: 'hermes', url: botUrl, agents: made.map((bot) => ({ id: bot.agentId, token: bot.token, home: bot.home })) });
      const results = made.map((bot) => {
        const result = (connected?.results ?? []).find((item) => item.id === bot.agentId);
        return { ...result, id: bot.agentId, name: bot.name, reconnected: bot.existing && !!result?.ok };
      });
      const available = made.filter((m) => results.find((result) => result.id === m.agentId)?.ok);
      const channelResults = [];
      for (const channelId of flow.channelIds) {
        const channel = flow.targetChannels.find((item) => item.id === channelId);
        for (const bot of available) {
          const joined = await supabase.rpc('msgr_crew_join', { ch: channelId, crew: bot.crewId });
          channelResults.push({ channel: channel?.name ?? channelId, agent: bot.name, status: joined.error ? 'failed' : joined.data });
        }
      }
      setLocalHermes({ ...flow, status: results.every((result) => result.ok) ? 'done' : 'partial', results, channelResults });
      if (flow.targetOrgId === org.id) { await loadBots(); onChanged?.(); }
      const joined = channelResults.filter((result) => result.status === 'joined').length;
      const requested = channelResults.filter((result) => result.status === 'requested').length;
      const failed = channelResults.filter((result) => result.status === 'failed').length;
      onNote(t('org.agents.local.done', { n: available.length, joined, requested, failed }));
    } catch (e) {
      setLocalHermes({ ...flow, status: 'partial', results: [], channelResults: [], reason: String(e?.message ?? e) });
      onError(String(e?.message ?? e));
    } finally { setBusy(false); }
  };
  // [헤르메스 연결하기] = 이 컴퓨터의 헤르메스 프로필(오픈클로는 등록 에이전트) **전원**을 읽어 각각 봇을 만들고(이름 = 그 에이전트 이름) 한 번에 연결(유건 지시 2026-09-08).
  // 앱 밖(브라우저)이거나 CLI가 없으면 봇 하나만 만들고 수동 안내를 보인다.
  const connectAll = async (kind) => {
    if (isMobilePlatform && kind !== 'custom') { onNote(t('org.agents.mobile')); return; }
    setBusy(true); setAuto(null); setSetups([]);
    try {
      let agents = null; let installation = null;
      if (isDesktopTauri() && ['hermes', 'openclaw'].includes(kind)) {
        const { invoke } = await import('@tauri-apps/api/core');
        const l = await invoke('agent_list', { kind });
        if (l?.ok && l.agents?.length) { agents = l.agents; installation = l.installationId; } else if (l?.reason === 'cli_missing') setAuto({ status: 'missing', results: [] }); else if (l?.reason === 'openclaw_outdated') setAuto({ status: 'outdated', results: [], version: l.version ?? '' }); // cli_missing과 같게 — 수동 연결 봇을 만들고 업데이트 안내를 같이 보인다 else if (!l?.ok) throw new Error(t('org.agents.discovery.failed'));
      }
      if (!agents) { // 수동: 이 컴퓨터에 에이전트가 없거나 앱 밖 — 봇 하나(다른 컴퓨터용)
        const made = await mkOrRotate(kind, kind === 'custom' ? t('org.agents.kind.custom') : t('org.agents.name.mine', { who: nameOfUser(uid), kind: t(`org.agents.kind.${kind}`) }), null, kind === 'custom' ? null : defaultBotNames(kind)); // custom("다른 에이전트")은 늘 새로 만든다(이름 목록 없음)
        setSetups([{ ...made, kind }]); setSetup({ id: made.id, token: made.token, kind }); onNote(t(made.rotated ? 'org.agents.rotated.again' : 'org.agents.made', made.rotated ? { name: made.name, when: fmtDate(made.createdAt, lang) } : undefined)); loadBots().catch(() => {}); onChanged?.();
        return;
      }
      const made = [];
      for (const a of agents) made.push({ ...(await mkOrRotate(kind, a.name, externalAgentId(installation, uid, kind, a.id))), kind, agentId: a.id, home: a.home ?? '' });
      setSetups(made); setSetup({ id: made[0].id, token: made[0].token, kind }); loadBots().catch(() => {}); onChanged?.();
      setAuto({ status: 'running', results: [] });
      const { invoke } = await import('@tauri-apps/api/core');
      const r = await invoke('agent_connect', { kind, url: botUrl, agents: made.map((m) => ({ id: m.agentId, token: m.token, home: m.home })) });
      const results = (r?.results ?? []).map((x) => ({ ...x, name: made.find((m) => m.agentId === x.id)?.name ?? x.id }));
      setAuto(r?.ok ? { status: 'done', results } : { status: r?.reason === 'cli_missing' ? 'missing' : r?.reason === 'openclaw_outdated' ? 'outdated' : 'failed', results, reason: r?.reason ?? '', version: r?.results?.[0]?.version ?? '' });
      onNote(t('org.agents.made.n', { n: made.length }));
    } catch (e) { onError(String(e?.message ?? e)); setAuto((a) => a?.status === 'running' ? { status: 'failed', results: [], reason: String(e?.message ?? e) } : a); }
    finally { setBusy(false); }
  };
  const autoConnect = async (kind, token, bot) => { // 회전 뒤 다시 연결(봇 하나) — external_id가 있는 봇만 이 컴퓨터에 자동 설정
    if (!isDesktopTauri() || !['hermes', 'openclaw'].includes(kind) || !bot?.external_id) { setAuto(null); return; }
    setAuto({ status: 'running', results: [] });
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const l = await invoke('agent_list', { kind });
      const local = l?.ok && l.installationId && bot.created_by === uid && l.agents?.find((a) => externalAgentId(l.installationId, uid, kind, a.id) === bot.external_id);
      if (!local) { setAuto(null); return; } // Legacy and another installation's IDs require explicit manual setup.
      const { id } = local; const home = local.home ?? '';
      const r = await invoke('agent_connect', { kind, url: botUrl, agents: [{ id, token, home }] });
      const results = (r?.results ?? []).map((x) => ({ ...x, name: bot.name }));
      setAuto(r?.ok ? { status: 'done', results } : { status: r?.reason === 'cli_missing' ? 'missing' : r?.reason === 'openclaw_outdated' ? 'outdated' : 'failed', results, reason: r?.reason ?? '', version: r?.results?.[0]?.version ?? '' });
    } catch (e) { setAuto({ status: 'failed', results: [], reason: String(e?.message ?? e) }); }
  };
  const addBot = (kind) => kind === 'hermes' && isDesktopTauri() ? openLocalHermes() : connectAll(kind);
  const addAnother = async (kind) => { // 다른 컴퓨터·다른 사람의 에이전트: external_id 없는 봇 하나 + 수동 안내
    const name = remoteAgentName.trim();
    if (!name) { onError(t('org.agents.remote.name.required')); return; }
    setBusy(true);
    try { const made = await mkOrRotate(kind, name, null); setSetups([{ ...made, kind }]); setSetup({ id: made.id, token: made.token, kind }); setRemoteAgentName(''); setAuto(null); onNote(t('org.agents.made')); loadBots().catch(() => {}); onChanged?.(); }
    catch (e) { onError(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  // VPS 서버 연결(유건 지시 2026-09-23) — 1회용 코드가 든 명령 한 줄을 서버 콘솔의 브라우저 터미널에 붙여넣으면 서버 스크립트(integrations/server-connect/connect.py)가
  // 에이전트 목록과 토큰 해시를 보고하고, 여기서 고른 에이전트만 봇이 된다(같은 서버·같은 에이전트는 토큰만 교체). 토큰 원문은 서버의 에이전트 설정에만 있다.
  // 진행 상태는 msgr_server_links 행(waiting → reported → approved → done)을 2초마다 읽는다.
  const [vps, setVps] = useState(null); // null | { linkId, command, row, picks, expired }
  const vpsKey = (a) => `${a.kind}:${a.id}`;
  const openVps = async () => {
    setBusy(true);
    try {
      const r = await supabase.rpc('msgr_server_link_create', { org: org.id }); if (r.error) throw new Error(r.error.message);
      setVps({ linkId: r.data.link_id, command: `curl -fsSL ${botUrl}/connect | python3 - ${r.data.code} ${botUrl}`, row: { status: 'waiting', agents: [] }, picks: null, expired: false });
    } catch (e) { onError(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  useEffect(() => { // 다시 들어오면 내가 시작한 진행 중 연결을 잇는다 — 서버 터미널은 아직 기다리고 있다(대기 단계는 명령 원문을 저장하지 않아 새로 만든다)
    if (part !== 'agents' || vps) return;
    supabase.from('msgr_server_links').select('id, status, host, agents, approved, results, expires_at').eq('org_id', org.id).eq('created_by', uid)
      .in('status', ['reported', 'approved']).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => { if (data) setVps((cur) => cur ?? { linkId: data.id, command: null, row: data, picks: data.status === 'reported' ? (data.agents ?? []).map(vpsKey) : null, expired: false }); });
  }, [part, org.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const vpsLive = !!vps && vps.row.status !== 'done' && !vps.expired;
  useEffect(() => {
    if (!vpsLive) return undefined;
    const id = vps.linkId;
    const iv = setInterval(async () => {
      const { data, error } = await supabase.from('msgr_server_links').select('status, host, agents, approved, results, expires_at').eq('id', id).maybeSingle();
      if (error || !data) return;
      setVps((cur) => cur?.linkId !== id ? cur : { ...cur, row: data, expired: data.status !== 'done' && Date.parse(data.expires_at) < Date.now(),
        picks: cur.picks ?? (data.status === 'reported' ? (data.agents ?? []).map(vpsKey) : null) }); // 처음 보고되면 전원 체크(유건 결정 3)
      if (data.status === 'done') { loadBots().catch(() => {}); onChanged?.(); }
    }, 2000);
    return () => clearInterval(iv);
  }, [vpsLive, vps?.linkId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleVps = (key) => setVps((cur) => { const on = new Set(cur.picks ?? []); if (on.has(key)) on.delete(key); else on.add(key); return { ...cur, picks: [...on] }; });
  const approveVps = async () => {
    const picks = (vps.row.agents ?? []).filter((a) => (vps.picks ?? []).includes(vpsKey(a))).map((a) => ({ kind: a.kind, id: a.id }));
    if (!picks.length) { onError(t('org.agents.vps.pick')); return; }
    setBusy(true);
    try {
      const r = await supabase.rpc('msgr_server_link_approve', { link: vps.linkId, picks }); if (r.error) throw new Error(r.error.message);
      setVps((cur) => ({ ...cur, row: { ...cur.row, status: 'approved', approved: r.data } })); loadBots().catch(() => {}); onChanged?.();
    } catch (e) { onError(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  const copyVps = async () => { await navigator.clipboard?.writeText(vps.command).catch(() => {}); onNote(t('org.agents.vps.copied')); };
  const vpsName = (r) => (vps?.row.agents ?? []).find((a) => a.kind === r.kind && a.id === r.id)?.name ?? r.id;
  const rotateBot = async (b) => {
    setBusy(true); const r = await supabase.rpc('msgr_bot_rotate', { bot: b.id }); setBusy(false);
    if (r.error) return onError(r.error.message);
    setSetups([{ id: b.id, token: r.data, name: b.name, kind: b.kind }]); setSetup({ id: b.id, token: r.data, kind: b.kind }); onNote(t('org.agents.rotated')); loadBots().catch(() => {}); autoConnect(b.kind, r.data, b);
  };
  const renameBot = async (b) => {
    const name = renameName.trim();
    if (!name) { onError(t('org.agents.remote.name.required')); return; }
    setBusy(true); const r = await supabase.rpc('msgr_bot_rename', { bot: b.id, new_name: name }); setBusy(false);
    if (r.error) return onError(r.error.message);
    setRenamingBot(null); setRenameName(''); onNote(t('org.agents.renamed')); loadBots().catch(() => {}); onChanged?.();
  };
  const revokeBot = async (b) => {
    setBusy(true); const r = await supabase.rpc('msgr_bot_revoke', { bot: b.id }); setBusy(false); setConfirmRevoke(null);
    if (r.error) return onError(r.error.message);
    if (setup?.id === b.id) setSetup(null); onNote(t('org.agents.revoke.done')); loadBots().catch(() => {}); onChanged?.();
  };
  const copyAll = async () => { const txt = (setups.length ? setups : [setup]).map((m) => (setups.length > 1 ? `# ${m.name}\n` : '') + botSetup(m.token)).join('\n\n'); await navigator.clipboard?.writeText(txt).catch(() => {}); onNote(t('org.agents.copied')); };
  const botStatus = (b) => {
    const kind = t(`org.agents.kind.${b.kind}`);
    if (!b.last_seen_at) return t('org.agents.waiting', { kind });
    return t(Date.now() - Date.parse(b.last_seen_at) < AWAY_MS ? 'org.agents.on' : 'org.agents.off', { kind, when: fmtWhen(b.last_seen_at, lang) });
  };
  const localOrgChoices = orgs.filter((candidate) => candidate.role === 'owner' || candidate.role === 'admin');
  if (part === 'agents') { const liveBots = bots.filter((b) => !b.revoked_at); return (
    <section className="msgr-setcard">
      <h2>{t('org.agents')}</h2><p>{t(isMobilePlatform ? (phone ? 'org.agents.mobile.short' : 'org.agents.mobile') : phone ? 'org.agents.desc.short' : 'org.agents.desc')}</p>
      <div className={`row${phone ? ' ph-agentadd' : ''}`}>
        <button type="button" className={phone ? 'btn sm' : 'btn btn-primary sm'} disabled={busy || isMobilePlatform} onClick={() => addBot('hermes')}><I name="plus" size={13} />{t(isDesktopTauri() ? 'org.agents.local.open' : 'org.agents.add.hermes')}</button>
        <button type="button" className="btn sm" disabled={busy || isMobilePlatform} onClick={() => addBot('openclaw')} title={reconnect('openclaw') ? t(isDesktopTauri() ? 'org.agents.reconnect.title.desktop' : 'org.agents.reconnect.title') : undefined}>{phone && <I name="plus" size={13} />}{reconnect('openclaw') ? t('org.agents.reconnect', { kind: t('org.agents.kind.openclaw') }) : t('org.agents.add.openclaw')}</button>
        <button type="button" className="btn sm" disabled={busy} onClick={openVps}><I name="plus" size={13} />{t('org.agents.vps.open')}</button>
        <button type="button" className={phone ? 'btn sm' : 'btn sm ghost'} disabled={busy} onClick={() => addBot('custom')}>{phone && <I name="plus" size={13} />}{t('org.agents.add.custom')}</button>
        <span className="msgr-remote-add"><label className="msgr-klabel" htmlFor="remote-agent-name">{t('org.agents.another')}</label><input id="remote-agent-name" className="msgr-input inline" value={remoteAgentName} maxLength={80} placeholder={t('org.agents.remote.name.placeholder')} onChange={(event) => setRemoteAgentName(event.target.value)} /><button type="button" className="btn sm ghost text" disabled={busy || !remoteAgentName.trim()} onClick={() => addAnother('hermes')}>{t('org.agents.kind.hermes')}</button>{hasMine('openclaw') && <button type="button" className="btn sm ghost text" disabled={busy || !remoteAgentName.trim()} onClick={() => addAnother('openclaw')}>{t('org.agents.kind.openclaw')}</button>}</span>
      </div>
      {localHermes && <div className="msgr-localimport">
        {localHermes.status === 'loading' && <p className="msgr-auto running"><span className="msgr-dot mark" /> {t('org.agents.local.loading')}</p>}
        {localHermes.status === 'loadingChannels' && <p className="msgr-auto running"><span className="msgr-dot mark" /> {t('org.agents.local.channels.loading')}</p>}
        {localHermes.status === 'missing' && <><p className="msgr-auto missing">{t('org.agents.local.missing')}</p><div className="acts"><button type="button" className="btn sm" disabled={busy} onClick={openLocalHermes}>{t('org.agents.local.retry')}</button><button type="button" className="btn sm ghost" onClick={() => setLocalHermes(null)}>{t('ui.close')}</button></div></>}
        {localHermes.status === 'failed' && !localHermes.agents.length && <><p className="msgr-auto failed">{t('org.agents.local.failed')}</p><div className="acts"><button type="button" className="btn sm" disabled={busy} onClick={openLocalHermes}>{t('org.agents.local.retry')}</button><button type="button" className="btn sm ghost" onClick={() => setLocalHermes(null)}>{t('ui.close')}</button></div></>}
        {['ready', 'connecting'].includes(localHermes.status) && <>
          <div className="msgr-localimport-head"><span className="msgr-klabel">{t('org.agents.local.h')}</span><span>{t('org.agents.local.desc')}</span></div>
          <label className="msgr-localimport-target"><span className="msgr-klabel">{t('org.agents.local.org')}</span><select className="msgr-input inline" value={localHermes.targetOrgId} disabled={busy} onChange={(event) => chooseLocalHermesOrg(event.target.value)}>{localOrgChoices.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
          <fieldset className="msgr-localimport-list" disabled={busy}>
            <legend>{t('org.agents.local.agents')}</legend>
            {localHermes.agents.map((agent) => <label key={agent.id} className={`pick${localHermes.agentIds.includes(agent.id) ? ' on' : ''}`}><input type="checkbox" checked={localHermes.agentIds.includes(agent.id)} onChange={() => toggleLocalHermes('agentIds', agent.id)} /><Av name={agent.name} crew size="sm" company /><span>{agent.name}</span>{agent.default && <span className="msgr-klabel">{t('org.agents.local.default')}</span>}</label>)}
          </fieldset>
          <fieldset className="msgr-localimport-list channels" disabled={busy}>
            <legend>{t('org.agents.local.channels')}</legend>
            <p className="note">{t('org.agents.local.channels.note')}</p>
            {!localHermes.targetChannels.length ? <p className="empty">{t('org.agents.local.channels.empty')}</p> : localHermes.targetChannels.map((channel) => <label key={channel.id} className={`pick${localHermes.channelIds.includes(channel.id) ? ' on' : ''}`}><input type="checkbox" checked={localHermes.channelIds.includes(channel.id)} onChange={() => toggleLocalHermes('channelIds', channel.id)} /><I name={channel.kind === 'private' ? 'lock' : 'hash'} size={13} /><span>{channel.name}</span><span className="msgr-klabel">{t(`ch.kind.${channel.kind}`)}</span></label>)}
          </fieldset>
          <div className="acts"><button type="button" className="btn btn-primary sm" disabled={busy || !localHermes.agentIds.length} onClick={importLocalHermes}><I name="check" size={13} />{localHermes.status === 'connecting' ? t('org.agents.local.connecting') : t('org.agents.local.connect', { n: localHermes.agentIds.length })}</button><button type="button" className="btn sm ghost" disabled={busy} onClick={() => setLocalHermes(null)}>{t('ui.cancel')}</button></div>
        </>}
        {['done', 'partial'].includes(localHermes.status) && <>
          <div className={`msgr-auto ${localHermes.status === 'done' ? 'done' : 'failed'}`}><p><span className={`msgr-dot${localHermes.status === 'done' ? ' ok' : ''}`} /> {t(localHermes.status === 'done' ? 'org.agents.local.complete' : 'org.agents.local.partial')}</p><ul>{localHermes.results.map((result) => <li key={result.id}><b>{result.name}</b>: {result.reconnected && <>{t('org.agents.local.reconnected')} · </>}{(result.steps ?? []).map((step) => `${step.ok ? '✓' : '✗'} ${t(`org.agents.auto.step.${step.name}`)}`).join(' · ')}</li>)}</ul></div>
          {!!localHermes.channelResults.length && <div className="msgr-localimport-results"><span className="msgr-klabel">{t('org.agents.local.channelResults')}</span><ul>{localHermes.channelResults.map((result, index) => <li key={`${result.channel}-${result.agent}-${index}`}>{result.channel} · {result.agent}: {t(`org.agents.local.channel.${result.status}`)}</li>)}</ul></div>}
          <div className="acts"><button type="button" className="btn sm" disabled={busy} onClick={openLocalHermes}>{t('org.agents.local.retry')}</button><button type="button" className="btn sm ghost" onClick={() => setLocalHermes(null)}>{t('ui.close')}</button></div>
        </>}
      </div>}
      {vps && <div className="msgr-localimport msgr-vps">
        <div className="msgr-localimport-head"><span className="msgr-klabel">{t('org.agents.vps.h')}</span><span>{t('org.agents.vps.desc')}</span></div>
        {vps.expired ? <><p className="msgr-auto failed">{t('org.agents.vps.expired')}</p><div className="acts"><button type="button" className="btn sm" disabled={busy} onClick={openVps}>{t('org.agents.vps.again')}</button><button type="button" className="btn sm ghost" onClick={() => setVps(null)}>{t('ui.close')}</button></div></>
        : vps.row.status === 'waiting' ? <>
          <ol className="steps"><li>{t('org.agents.vps.step1')}</li><li>{t('org.agents.vps.step2')}</li><li>{t('org.agents.vps.step3')}</li></ol>
          <div className="msgr-node-cmd"><code>{vps.command}</code><div className="acts"><button type="button" className="btn btn-primary sm" onClick={copyVps}><I name="copy" size={13} />{t('org.agents.vps.copy')}</button></div><p className="note">{t('org.agents.vps.user')}</p></div>
          <details className="msgr-vps-where"><summary>{t('org.agents.vps.where')}</summary><ul><li>{t('org.agents.vps.where.hostinger')}</li><li>{t('org.agents.vps.where.oracle')}</li><li>{t('org.agents.vps.where.aws')}</li></ul></details>
          <p className="msgr-auto running"><span className="msgr-dot mark" /> {t('org.agents.vps.waiting')}</p>
          <div className="acts"><button type="button" className="btn sm ghost" onClick={() => setVps(null)}>{t('ui.cancel')}</button></div>
        </>
        : vps.row.status === 'reported' ? <>
          <p>{t('org.agents.vps.found', { host: vps.row.host, n: (vps.row.agents ?? []).length })}</p>
          <fieldset className="msgr-localimport-list" disabled={busy}>
            <legend>{vps.row.host}</legend>
            {(vps.row.agents ?? []).map((a) => { const k = vpsKey(a); const on = (vps.picks ?? []).includes(k); return <label key={k} className={`pick${on ? ' on' : ''}`}><input type="checkbox" checked={on} onChange={() => toggleVps(k)} /><Av name={a.name} crew size="sm" company /><span>{a.name}</span><span className="msgr-klabel">{t(`org.agents.kind.${a.kind}`)}{a.default ? ` · ${t('org.agents.local.default')}` : ''}</span></label>; })}
          </fieldset>
          <div className="acts"><button type="button" className="btn btn-primary sm" disabled={busy || !(vps.picks ?? []).length} onClick={approveVps}><I name="check" size={13} />{t('org.agents.vps.connect', { n: (vps.picks ?? []).length })}</button><button type="button" className="btn sm ghost" disabled={busy} onClick={() => setVps(null)}>{t('ui.cancel')}</button></div>
        </>
        : vps.row.status === 'approved' ? <p className="msgr-auto running"><span className="msgr-dot mark" /> {t('org.agents.vps.installing')}</p>
        : (() => { const results = vps.row.results ?? []; const ok = results.length > 0 && results.every((r) => r.ok); return <>
          <div className={`msgr-auto ${ok ? 'done' : 'failed'}`}><p><span className={`msgr-dot${ok ? ' ok' : ''}`} /> {ok ? t('org.agents.vps.done', { host: vps.row.host, n: results.length }) : t('org.agents.vps.partial')}</p>
            <ul>{results.map((r) => <li key={`${r.kind}:${r.id}`}><b>{vpsName(r)}</b>: {r.ok ? '✓' : '✗'} {t(`org.agents.kind.${r.kind}`)}{(vps.row.approved ?? []).find((x) => x.kind === r.kind && x.id === r.id)?.reused && <> · {t('org.agents.vps.reused')}</>}{!r.ok && r.detail ? ` — ${String(r.detail).slice(0, 160)}` : ''}</li>)}</ul></div>
          <div className="acts">{!ok && <button type="button" className="btn sm" disabled={busy} onClick={openVps}>{t('org.agents.vps.again')}</button>}<button type="button" className="btn sm ghost" onClick={() => setVps(null)}>{t('ui.close')}</button></div>
        </>; })()}
      </div>}
      {setup && (
        <div className="msgr-node-cmd">
          <span className="msgr-klabel">{t('org.agents.setup.h')}</span>
          {(setups.length ? setups : [{ ...setup, name: '' }]).map((m) => <div key={m.id} className="one">{setups.length > 1 && <span className="msgr-klabel">{m.name}</span>}<code>{botSetup(m.token)}</code></div>)}
          <div className="acts"><button type="button" className="btn sm" onClick={() => copyAll()}><I name="copy" size={13} />{t('org.agents.copy')}</button><button type="button" className="btn sm ghost" onClick={() => setSetup(null)}>{t('ui.close')}</button></div>
          {auto?.status === 'running' && <p className="msgr-auto running"><span className="msgr-dot mark" /> {t('org.agents.auto.running', { kind: t(`org.agents.kind.${setup.kind}`) })}</p>}
          {auto?.status === 'done' && (<div className="msgr-auto done">
            <p><span className="msgr-dot ok" /> {t('org.agents.auto.done.n', { kind: t(`org.agents.kind.${setup.kind}`), n: (auto.results ?? []).length })}</p>
            <ul>{(auto.results ?? []).map((r) => <li key={r.id}><b>{r.name}</b>: {(r.steps ?? []).map((s) => `${s.ok ? '✓' : '✗'} ${t(`org.agents.auto.step.${s.name}`)}`).join(' · ')}</li>)}</ul>
          </div>)}
          {auto?.status === 'failed' && (<div className="msgr-auto failed">
            <p>{t('org.agents.auto.failed', { kind: t(`org.agents.kind.${setup.kind}`) })}</p>
            <ul>{(auto.results ?? []).map((r) => <li key={r.id}><b>{r.name}</b>: {(r.steps ?? []).map((s) => `${s.ok ? '✓' : '✗'} ${t(`org.agents.auto.step.${s.name}`)}${!s.ok && s.detail ? ` — ${String(s.detail).slice(0, 160)}` : ''}`).join(' · ')}</li>)}</ul>
            <div className="acts"><button type="button" className="btn sm" onClick={() => connectAll(setup.kind)}>{t('org.agents.auto.retry')}</button></div>
          </div>)}
          {auto?.status === 'missing' && <p className="msgr-auto missing">{t('org.agents.auto.missing', { kind: t(`org.agents.kind.${setup.kind}`) })}</p>}
          {auto?.status === 'outdated' && <p className="msgr-auto failed"><InlineCode text={t('org.agents.openclaw.outdated', { need: '2026.8.1', have: auto.version || t('org.agents.openclaw.versionUnknown') })} /></p>}
          {auto?.status !== 'done' && auto?.status !== 'running' && (<>
            <span className="msgr-klabel">{t('org.agents.setup.manual')}</span>
            <ol className="steps">{/* 유건 질문 2026-09-08 "두 줄을 어디에 넣나" — 앱 밖(브라우저)이거나 이 컴퓨터에 에이전트가 없을 때의 수동 안내 */}
              <li><InlineCode text={t(`org.agents.setup.${setup.kind ?? 'custom'}.1`)} /></li>
              <li><InlineCode text={t(`org.agents.setup.${setup.kind ?? 'custom'}.2`)} /></li>
              <li><InlineCode text={t(`org.agents.setup.${setup.kind ?? 'custom'}.3`)} /></li>
            </ol>
          </>)}
          <p className="note">{auto?.status === 'done' ? t('org.agents.auto.after') : t('org.agents.setup.hint')}</p>
        </div>
      )}
      {!liveBots.length ? <p className="empty">{t('org.agents.none')}</p> : (
        <div className="msgr-rows">
          {liveBots.map((b) => { const on = b.last_seen_at && Date.now() - Date.parse(b.last_seen_at) < AWAY_MS; const opened = openBot === b.id; const renaming = renamingBot === b.id; return (
            <div key={b.id} className={`msgr-botrow${opened ? ' open' : ''}`}>
              <div className="row">
                <button type="button" className="main" onClick={() => setOpenBot(opened ? null : b.id)} aria-expanded={opened} title={t('org.agents.detail.open')}>
                  <Av name={b.name} crew size="sm" company crewId={b.crew_id ?? null} /><span className="name">{b.name}</span>
                  <span className="sub"><span className={`msgr-dot${on ? ' mark' : ''}`} /> {botStatus(b)} · {t('org.agents.by', { name: nameOfUser(b.created_by) })}</span>
                </button>
                {confirmRevoke !== b.id && confirmRotate !== b.id && <>{renaming ? <span className="confirm-inline"><input className="msgr-input inline" value={renameName} maxLength={80} aria-label={t('org.agents.rename')} onChange={(event) => setRenameName(event.target.value)} /><button type="button" className="btn btn-primary sm" disabled={busy || !renameName.trim()} onClick={() => renameBot(b)}>{t('org.agents.rename.save')}</button><button type="button" className="btn sm ghost text" disabled={busy} onClick={() => { setRenamingBot(null); setRenameName(''); }}>{t('ui.cancel')}</button></span> : <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => { setRenamingBot(b.id); setRenameName(b.name); }}>{t('org.agents.rename')}</button>}<button type="button" className="btn sm ghost text" disabled={busy || renaming} onClick={() => { setConfirmRevoke(null); setConfirmRotate(b.id); }}>{t('org.agents.rotate')}</button><button type="button" className="btn sm ghost" disabled={busy || renaming} onClick={() => { setConfirmRotate(null); setConfirmRevoke(b.id); }} title={t('org.agents.revoke')} aria-label={t('org.agents.revoke')}><I name="x" size={13} /></button></>}
                {confirmRotate === b.id && <span className="confirm-inline"><span>{t('org.agents.rotate.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => { setConfirmRotate(null); rotateBot(b); }}>{t('org.agents.rotate.do')}</button><button type="button" className="btn sm ghost text" onClick={() => setConfirmRotate(null)}>{t('ui.cancel')}</button></span>}
                {confirmRevoke === b.id && <span className="confirm-inline"><span>{t('org.agents.revoke.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => revokeBot(b)}>{t('org.agents.revoke')}</button><button type="button" className="btn sm ghost text" onClick={() => setConfirmRevoke(null)}>{t('ui.cancel')}</button></span>}
              </div>
              {opened && (
                <div className="msgr-node-cmd detail">
                  <div className="facts">
                    <div><span className="msgr-klabel">{t('org.agents.detail.status')}</span><span>{botStatus(b)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.kind')}</span><span>{t(`org.agents.kind.${b.kind}`)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.by.label')}</span><span>{nameOfUser(b.created_by)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.created')}</span><span>{fmtWhen(b.created_at, lang)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.token')}</span><span><code>{b.token_hint}…</code>{b.rotated_at ? ` · ${t('org.agents.detail.rotated', { when: fmtWhen(b.rotated_at, lang) })}` : ''}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.adapter')}</span><span>{b.state?.adapter_version ?? t('org.agents.detail.adapter.unknown')}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.approvals')}</span><span>{t(`org.agents.approvals.${approvalLevel(b.state?.approval_mode)}`, { mode: b.state?.approval_mode ?? '' })}</span></div>
                  </div>
                  {adapterOutdated(b) && <p className="note">{t('org.agents.adapter.outdated', { latest: ADAPTER_LATEST[b.kind] })}</p>}
                  {['ai', 'none'].includes(approvalLevel(b.state?.approval_mode)) && <p className="note">{t('org.agents.approvals.fix')} <code>{APPROVAL_FIX[b.kind] ?? APPROVAL_FIX.hermes}</code></p>}
                  {b.created_by === uid && <><label className="msgr-check"><input type="checkbox" checked={!!b.state?.mirror_all} disabled={busy || !b.state?.adapter_version} onChange={(e) => setMirrorAll(b, e.target.checked)} /> {t('org.agents.mirrorAll')}</label>
                    <p className="note">{b.state?.adapter_version ? t(b.state?.mirror_all && b.state?.mirror_all_applied !== b.state?.mirror_all ? 'org.agents.mirrorAll.pending' : 'org.agents.mirrorAll.hint') : t('org.agents.mirrorAll.needUpdate')}</p></>}
                  <p className="note">{t('org.agents.detail.hint')}</p>
                  <div className="acts">{onOpenCrew && <button type="button" className="btn sm" onClick={() => onOpenCrew(b.crew_id)}><I name="star" size={13} />{t('org.agents.detail.openCrew')}</button>}<button type="button" className="btn sm ghost text" onClick={() => setOpenBot(null)}>{t('ui.close')}</button></div>
                </div>
              )}
            </div>); })}
        </div>)}
    </section>
  ); }
  if (part === 'node') return (
    <section className="msgr-setcard">
      <h2>{t('org.node')}</h2><p>{t('org.node.desc')}</p>
      <div className="row">
        <span className={`msgr-tag${nodeAlive ? ' on' : ''}`}>{nodeStatus}</span>
        <button type="button" className={`btn sm${nodeSet ? '' : ' btn-primary'}`} disabled={busy} onClick={() => setNodeGuide((v) => !v)} aria-expanded={nodeGuide}>{nodeSet ? t('org.node.reconnect') : t('org.node.connect')}</button>
      </div>
      {nodeGuide && (
        <div className="msgr-node-cmd">
          <ol className="steps">
            <li>{t('org.node.step1')}</li>
            <li>{t('org.node.step2')}</li>
            <li>{t('org.node.step3')}</li>
          </ol>
          {nodeInvite ? nodeCmdBlock : <div className="acts"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={makeNodeInvite}><I name="doc" size={13} />{t('org.node.make')}</button></div>}
          <p className="note">{t('org.node.hint')}</p>
          <span className="msgr-klabel">{t('org.node.env.h')}</span>
          <code>{NODE_ENV_PREFIX} &lt;{t('org.node.env.cmd')}&gt;</code>
        </div>
      )}
    </section>
  );
  if (part === 'audit') return (
    <section className="msgr-setcard">
      <h2>{t('org.audit')}</h2>
      {audit === null
        ? <div className="row"><button type="button" className="btn sm" onClick={() => loadAudit().catch((e) => onError(e.message))}><I name="doc" size={13} />{t('org.audit.load')}</button></div>
        : (<div className="msgr-audit">
            {!audit.length && <p className="empty">{t('org.audit.empty')}</p>}
            {audit.map((a) => <div key={a.id} className="row"><span className="when">{fmtWhen(a.at, lang)}</span><span className="who">{a.actor_user_id ? nameOfUser(a.actor_user_id) : (a.actor_crew_id ? t('org.crew') : t('org.audit.system'))}</span><span className="act">{a.action}</span><span className="tgt">{a.target_kind}{a.target_id ? ` · ${String(a.target_id).slice(0, 8)}` : ''}</span></div>)}
            <div className="row"><button type="button" className="btn sm" onClick={() => loadAudit().catch((e) => onError(e.message))}>{t('org.audit.reload')}</button></div>
          </div>)}
    </section>
  );
  const nomineeName = transfer && transfer !== 'pick' ? (members.find((m) => m.user_id === transfer)?.display_name || transfer.slice(0, 8)) : '';
  // 이용 상태(2026-10-01 유건 승인 — 9/30 요금 개편): 무료 기간 개념이 없어져 무료 조직도 계속 쓴다(서버 msgr_org_entitled = 멤버면 true).
  // team 플랜(좌석을 산 조직)은 "Team", 결제 기간이 있으면 그 날짜, 나머지는 "무료". 앱 안에는 가격·구매 경로가 없다.
  const isTeamPlan = ent?.plan === 'team';
  const paidActive = !isTeamPlan && !!ent?.paid_until && Date.parse(ent.paid_until) > Date.now();
  return (
    <section className="msgr-setcard">
      <h2>{t('set.org')}</h2><p>{t('set.org.desc')}</p>
      {ent && (
        <div className="row">
          <span className="msgr-klabel">{t('org.trial.label')}</span>
          <span className="sub">{isTeamPlan ? t('org.plan.team') : paidActive ? t('org.period.paid', { date: fmtDay(ent.paid_until, lang)[0] }) : t('org.plan.free')}</span>
        </div>
      )}
      {iAmNominee && (
        <div className="msgr-node-cmd">
          <span className="msgr-klabel">{t('org.owner')}</span>
          <p style={{ margin: 0 }}>{t('org.transfer.offered', { name: nameOfUser(org.owner_user_id) })}</p>
          <div className="acts">
            <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => patchOrg({ owner_user_id: uid }, t('org.transfer.accepted'))}><I name="check" size={13} />{t('org.transfer.accept')}</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => patchOrg({ pending_owner_user_id: null }, t('org.transfer.declined'))}>{t('org.transfer.decline')}</button>
          </div>
        </div>
      )}
      <div className="row">
        <span className="msgr-klabel">{t('org.name')}</span>
        <input className="msgr-input inline" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }} />
        <button type="button" className="btn btn-primary sm" disabled={busy || !name.trim() || name.trim() === org.name} onClick={saveName}><I name="check" size={13} />{t('ui.save')}</button>
      </div>
      {isOwner && (<>
        <div className="row">
          <label className="switchrow"><input type="checkbox" checked={domainOn} disabled={busy || !myDomain} onChange={toggleDomain} /><span>{t('org.domain.toggle', { domain: org.auto_join_domain ?? myDomain })}</span></label>
        </div>
        <p className="note">{t('org.domain.note')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('org.transfer')}</span>
          {org.pending_owner_user_id
            ? <><span className="msgr-tag">{t('org.transfer.pending', { name: nameOfUser(org.pending_owner_user_id) })}</span><button type="button" className="btn sm ghost" disabled={busy} onClick={() => patchOrg({ pending_owner_user_id: null }, t('org.transfer.cancelled'))} title={t('org.transfer.cancel')} aria-label={t('org.transfer.cancel')}><I name="x" size={13} /></button></>
            : transfer === null ? <button type="button" className="btn sm" disabled={busy} onClick={() => setTransfer('pick')}>{t('org.transfer.start')}</button>
            : transfer !== 'pick' ? <span className="confirm-inline"><span>{t('org.transfer.confirm', { name: nomineeName })}</span><button type="button" className="btn btn-primary sm" disabled={busy} onClick={async () => { await patchOrg({ pending_owner_user_id: transfer }, t('org.transfer.sent', { name: nomineeName })); setTransfer(null); }}>{t('org.transfer.do')}</button><button type="button" className="btn sm" onClick={() => setTransfer(null)}>{t('ui.cancel')}</button></span>
            : admins.length ? <div className="picks">{admins.map((m) => <button key={m.user_id} type="button" className="msgr-chan" disabled={busy} onClick={() => setTransfer(m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}<button type="button" className="btn sm ghost" onClick={() => setTransfer(null)}>{t('ui.cancel')}</button></div> : <span className="sub">{t('org.owner.noAdmins')}</span>}
        </div>
        <p className="note">{t('org.transfer.desc')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('org.delete')}</span>
          {delName === null
            ? <button type="button" className="btn sm" disabled={busy} onClick={() => setDelName('')}><I name="x" size={13} />{t('org.delete.start')}</button>
            : <>
                <input className="msgr-input inline" placeholder={t('org.delete.typeName', { name: org.name })} value={delName} onChange={(e) => setDelName(e.target.value)} autoFocus />
                <button type="button" className="btn btn-primary sm danger" disabled={busy || delName.trim() !== org.name} onClick={deleteOrg}>{t('org.delete.confirm')}</button>
                <button type="button" className="btn sm" onClick={() => setDelName(null)}>{t('ui.cancel')}</button>
              </>}
        </div>
        <p className="note">{t('org.delete.desc')}</p>
      </>)}
    </section>
  );
}

function PolicyCard({ org, isAdmin, policy, members = [], onChanged, onNote, onError, part = 'all' }) { // part 'memory'(폰 설정 > 기억): 조직 기억 정책 두 칸만 — 저장은 늘 정책 행 전체(읽어 온 값 그대로 + 바꾼 칸)
  const { t } = useT();
  const [draft, setDraft] = useState(policy); const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(policy); }, [policy]);
  const dirty = ['allow_default', 'allow_locked', 'crew_memory_default', 'crew_memory_locked', 'approval_high_by', 'crew_create', 'crew_runner', 'crew_model', 'guest_seats'].some((k) => draft?.[k] !== policy?.[k]) || JSON.stringify(draft?.approver_user_ids ?? []) !== JSON.stringify(policy?.approver_user_ids ?? []);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_policies').update({ allow_default: draft.allow_default, allow_locked: draft.allow_locked, crew_memory_default: draft.crew_memory_default, crew_memory_locked: draft.crew_memory_locked, approval_high_by: draft.approval_high_by, approver_user_ids: draft.approver_user_ids ?? [], crew_create: draft.crew_create ?? 'channel_admin', crew_runner: draft.crew_runner?.trim() || null, crew_model: draft.crew_model?.trim() || null, guest_seats: !!draft.guest_seats }).eq('org_id', org.id).select('org_id');
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
    if (!res.data?.length) return onError(t('set.policy.adminOnly'));
    onNote(t('set.policy.saved')); onChanged();
  };
  const ro = !isAdmin || busy;
  const nodeRunners = Array.isArray(org?.node_info?.runners) ? org.node_info.runners : []; // 서버가 하트비트에 실은 목록 — 있으면 드롭다운, 없으면 텍스트(정직)
  const [adv, setAdv] = useState(false); // 고급(기억·게스트 좌석·엔진·잠금)은 접어 둔다 — 기본값 그대로면 볼 일이 없다
  if (part === 'memory') return (
    <section className="msgr-setcard">
      <h2>{t('phone.set.memPolicy')}</h2><p>{t('phone.set.memPolicy.desc')}</p>
      <div className="q">
        <label className="switchrow"><input type="checkbox" checked={draft.crew_memory_default !== false} disabled={ro} onChange={(e) => set({ crew_memory_default: e.target.checked })} /><span>{t('set.policy.memory2')}</span></label>
        <label className="switchrow"><input type="checkbox" checked={!!draft.crew_memory_locked} disabled={ro} onChange={(e) => set({ crew_memory_locked: e.target.checked })} /><span>{t('set.policy.lock3')}</span></label>
      </div>
      {isAdmin ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !dirty} onClick={save}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('set.policy.adminOnly')}</p>}
    </section>
  );
  return (
    <section className="msgr-setcard">
      <h2>{t('set.policy')}</h2><p>{t('set.policy.desc')}</p>
      <div className="q">
        <span className="qlabel">{t('set.policy.q.allow')}</span>
        <Seg label={t('set.policy.q.allow')} value={draft.allow_default} onPick={(v) => set({ allow_default: v })} disabled={ro} options={['all', 'list', 'owner'].map((v) => ({ v, label: t(`crew.allow.${v}`) }))} />
        {draft.allow_default === 'list' && <span className="note">{t('set.policy.allow.listNote')}</span>}
        <label className="switchrow"><input type="checkbox" checked={!!draft.allow_locked} disabled={ro} onChange={(e) => set({ allow_locked: e.target.checked })} /><span>{t('set.policy.lock2')}</span></label>
      </div>
      <div className="q">
        <span className="qlabel">{t('set.policy.q.approval')}</span>
        <Seg label={t('set.policy.q.approval')} value={draft.approval_high_by ?? 'admin'} onPick={(v) => set({ approval_high_by: v })} disabled={ro} options={['admin', 'approvers', 'owner'].map((v) => ({ v, label: t(`set.policy.approval.${v}`) }))} />
        {(draft.approval_high_by === 'approvers') && (
          <div className="picks">{members.filter((m) => m.role !== 'owner' && m.role !== 'guest' && m.user_id !== org.service_user_id).map((m) => { const on = (draft.approver_user_ids ?? []).includes(m.user_id); /* 게스트 제외: 공개 채널을 못 읽어 결재를 확정할 수 없다 */ return <button key={m.user_id} type="button" className={`msgr-chan${on ? ' active' : ''}`} aria-pressed={on} disabled={ro} onClick={() => set({ approver_user_ids: on ? (draft.approver_user_ids ?? []).filter((x) => x !== m.user_id) : [...(draft.approver_user_ids ?? []), m.user_id] })}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>; })}</div>
        )}
        <span className="note">{t('set.policy.approval.desc')}</span>
      </div>
      <div className="q">
        <span className="qlabel">{t('set.policy.q.crewCreate')}</span>
        <Seg label={t('set.policy.q.crewCreate')} value={draft.crew_create ?? 'channel_admin'} onPick={(v) => set({ crew_create: v })} disabled={ro} options={['admin', 'channel_admin', 'member'].map((v) => ({ v, label: t(`set.policy.crewCreate.${v}`) }))} />
      </div>
      <div className="msgr-fold">
        <button type="button" className="fold-head" onClick={() => setAdv((v) => !v)} aria-expanded={adv}><h3>{t('set.policy.advanced')}</h3><I name="caret" size={14} className={adv ? 'open' : ''} /></button>
        {adv && (<>
          <div className="q">
            <label className="switchrow"><input type="checkbox" checked={draft.crew_memory_default !== false} disabled={ro} onChange={(e) => set({ crew_memory_default: e.target.checked })} /><span>{t('set.policy.memory2')}</span></label>
            <label className="switchrow"><input type="checkbox" checked={!!draft.crew_memory_locked} disabled={ro} onChange={(e) => set({ crew_memory_locked: e.target.checked })} /><span>{t('set.policy.lock3')}</span></label>
          </div>
          <div className="q">
            <label className="switchrow"><input type="checkbox" checked={!!draft.guest_seats} disabled={ro} onChange={(e) => set({ guest_seats: e.target.checked })} /><span>{t('set.policy.guests.seats')}</span></label>
            <span className="note">{t('set.policy.guests.desc')}</span>
          </div>
          <div className="q">
            <span className="qlabel">{t('set.policy.crewEngine')}</span>
            {nodeRunners.length ? (<>
              <select className="msgr-input inline" value={draft.crew_runner ?? ''} disabled={ro} onChange={(e) => set({ crew_runner: e.target.value || null, crew_model: null })}>
                <option value="">{t('set.policy.crewEngine.default')}</option>
                {nodeRunners.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              {draft.crew_runner && (nodeRunners.find((r) => r.id === draft.crew_runner)?.models ?? []).length > 0 && (
                <select className="msgr-input inline wide" value={draft.crew_model ?? ''} disabled={ro} onChange={(e) => set({ crew_model: e.target.value || null })}>
                  <option value="">{t('set.policy.crewEngine.defaultModel')}</option>
                  {nodeRunners.find((r) => r.id === draft.crew_runner).models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.free ? ` · ${t('set.policy.crewEngine.free')}` : ''}</option>)}
                </select>
              )}
            </>) : (<>
              <input className="msgr-input inline" placeholder={t('set.policy.crewEngine.runner')} value={draft.crew_runner ?? ''} maxLength={32} disabled={ro} onChange={(e) => set({ crew_runner: e.target.value })} />
              <input className="msgr-input inline wide" placeholder={t('set.policy.crewEngine.model')} value={draft.crew_model ?? ''} maxLength={120} disabled={ro} onChange={(e) => set({ crew_model: e.target.value })} />
            </>)}
            <span className="note">{t('set.policy.crewEngine.desc')}</span>
          </div>
          <p className="note">{t('set.policy.limit')}</p>
        </>)}
      </div>
      {isAdmin ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !dirty} onClick={save}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('set.policy.adminOnly')}</p>}
    </section>
  );
}

// 조직 시작 단계(빈 조직 안내와 첫 채널 뒤 남은 단계가 같은 목록을 쓴다 — D3). 표지: 'mark' 지금 할 일 · 'done' 끝남 · '' 아직
function orgSteps({ t, hasChannel, hasPublic, invited, hasCrew, isAdmin, adminName, createChannel, newWhy = null, invite, openAgents, openRunner }) {
  const m = stepMarks({ hasChannel, isAdmin, invited, hasCrew });
  // [실행기 연결] — 'Argo 앱 받기'를 직접 걸던 자리(2026-10-02 아르고 패밀리 구조). 앱 받기 링크는 시트 안에 있고 iOS에서는 숨긴다(총괄 지시 2026-09-26, 3.1.1/3.1.3).
  const agentActs = <span key="c" className="acts">{openRunner && <button type="button" className={`btn sm${m.agent === 'mark' ? ' btn-primary' : ''}`} onClick={openRunner}><I name="node" size={13} />{t('runner.title')}</button>}{isAdmin && openAgents && <button type="button" className="btn sm" onClick={openAgents}><I name="star" size={13} />{t('ch.step3.bot')}</button>}</span>;
  return [
    [m.channel, t('ch.step1'), t(!hasChannel && !createChannel && newWhy ? newWhy : hasPublic ? 'ch.step1.subPrivate' : 'ch.step1.sub'), hasChannel || !createChannel ? null : <button key="a" type="button" className="btn btn-primary sm" onClick={createChannel}><I name="hash" size={13} />{t('ch.new')}</button>], // 만들 수 없으면 단추 대신 이유(2차 검수 L-b)
    ...(isAdmin ? [[m.invite, t('ch.step2'), t('ch.step2.sub'), invite && !invited ? <button key="b" type="button" className={`btn sm${m.invite === 'mark' ? ' btn-primary' : ''}`} onClick={invite}><I name="copy" size={13} />{t('inv.org')}</button> : null]] : []),
    [m.agent, t('ch.step3'), isAdmin ? t('ch.step3.sub') : adminName ? t('ch.step3.member', { name: adminName }) : t('ch.step3.memberAny'), hasCrew ? null : agentActs],
  ];
}
function OrgStepList({ steps }) {
  return (<div className="msgr-steps">
    {steps.map(([mark, title, sub, act], i) => (
      <div key={i} className={`msgr-step${mark === 'done' ? ' done' : ''}`}><span className={`num${mark ? ` ${mark}` : ''}`}>{mark === 'done' ? <I name="check" size={13} /> : i + 1}</span><div className="card"><div><b>{title}</b>{mark !== 'done' && <span>{sub}</span>}</div>{act}</div></div>
    ))}
  </div>);
}
// 첫 채널 뒤에도 남은 단계(초대·에이전트)를 스레드 맨 위에 둔다(D3). 다 끝나거나 닫으면 사라진다(조직별로 기억)
function OnboardCard({ orgId, steps, t }) {
  const key = `argo-onboard-hide:${orgId}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  if (hidden || steps.every(([m]) => m === 'done')) return null;
  return (<section className="msgr-onboard" aria-label={t('ch.onboard.title')}>
    <header><span className="msgr-klabel">{t('ch.onboard.title')}</span><button type="button" className="btn ghost sm" onClick={() => { try { localStorage.setItem(key, '1'); } catch { /* 저장 못 해도 이번엔 닫는다 */ } setHidden(true); }} aria-label={t('ch.onboard.hide')}><I name="x" size={13} /></button></header>
    <OrgStepList steps={steps} />
  </section>);
}

// 조직 없는 첫 화면 단계(데스크톱 본문·폰 홈이 같은 목록 — D22 S109)
function noOrgSteps({ t, createOrg, joinWithCode, joinable = [], joinDomain, deletedOrgs = [], restoreOrg }) {
  return [
    ...(deletedOrgs.length ? [['', t('org.step.restore'), t('org.step.restore.sub'), <div key="r" className="msgr-chips">{deletedOrgs.map((o) => <button key={o.id} type="button" className="msgr-chan" onClick={() => restoreOrg(o)}><span>{o.name}</span><span className="msgr-klabel">{t('org.restore.cta', { days: Math.max(0, Math.ceil((Date.parse(o.purge_at) - Date.now()) / 86_400_000)) })}</span></button>)}</div>]] : []), // J-5
    ...(joinable.length ? [['mark', t('org.step.join'), t('org.step.join.sub'), <div key="j" className="msgr-chips">{joinable.map((o) => <button key={o.id} type="button" className="msgr-chan" onClick={() => joinDomain(o)}><span>{o.name}</span><span className="msgr-klabel">{t('org.join.cta')}</span></button>)}</div>]] : []), // J-3: 회사 도메인 계정이면 초대 없이 바로
    [joinable.length ? '' : 'mark', t('org.step.create'), t('org.step.create.sub'), <button key="a" type="button" className="btn btn-primary sm" onClick={createOrg}><I name="plus" size={13} />{t('org.new')}</button>],
    ['', t('org.step.invite'), t('org.step.invite.sub'), <button key="j" type="button" className="btn sm" onClick={joinWithCode}><I name="link" size={13} />{t('org.join.code')}</button>],
  ];
}

// App Store 5.1.2 재설계(2026-09-27, 유건 결정 "처음 한 번 필수 동의") — 조직 공간 진입 전 필수 동의 화면.
// 동의하면 그대로 조직 공간이 뜨고(같은 페이지가 다시 그려진다), 거부하면 개인 공간으로 보낸다(초안 분실 없음 — 아직 방에 안 들어갔다).
function AiConsentGate({ t, onMenu, onError, onDecline, bare = false, personal = false }) {
  // bare — 검수 M-5(2026-09-27): 폰 홈/DM 탭은 레일이 곧 화면이라 이 레일 안에서도 같은 문구·버튼을 그대로 보여준다(중복
  // 문구 방지 — 새 컴포넌트를 만들지 않는다). 레일에는 이미 자기 상단 바(조직 전환)가 있으니 여기 상단 바는 생략한다.
  const { setAiConsent } = useContext(SafetyCtx);
  const [busy, setBusy] = useState(false);
  const agree = async () => { setBusy(true); try { await setAiConsent(true); } catch { onError?.(t('consent.ai.failed')); } finally { setBusy(false); } };
  // 유건 결정(2026-09-27, 동의 전환 기간) — 거부도 서버에 남긴다. 전용 RPC 이름은 trial-builder가 확정해 전달할 예정이라
  // 그때까지는 기존 msgr_set_ai_consent(false)(= setAiConsent(false))로 맞춰 둔다. 기록이 실패해도 개인 공간 전환은 막지 않는다.
  const decline = async () => { if (personal) return onDecline(); // 개인 공간의 "지금은 안 함"은 거부로 기록하지 않는다 — 기록하면 조직에서 쓴 글까지 에이전트 문맥에서 빠진다(2026-09-30)
    setBusy(true); try { await setAiConsent(false); } catch { /* 거부 기록 실패는 조용히 — 전환은 그대로 진행 */ } finally { setBusy(false); } onDecline(); };
  return (<>
    {!bare && <div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{t(personal ? 'consent.ai.personal.title' : 'consent.ai.title')}</span></div>}
    <div className={bare ? 'msgr-consent-rail' : 'msgr-thread'} style={bare ? undefined : { display: 'flex' }}><div className="msgr-empty">
      <h1>{t(personal ? 'consent.ai.personal.title' : 'consent.ai.title')}</h1>
      <p>{t(personal ? 'consent.ai.personal.desc' : 'consent.ai.desc')}</p>
      <p className="note">{t(personal ? 'consent.ai.personal.declineNote' : 'consent.ai.declineNote')}</p>
      <div className="acts">
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={agree}><I name="check" size={13} />{t('consent.ai.confirm')}</button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={decline}>{t(personal ? 'consent.ai.personal.decline' : 'consent.ai.decline')}</button>
      </div>
      <p className="msgr-legal in-card"><button type="button" className="linkbtn" onClick={() => openExternal(LEGAL.privacy)}>{t('legal.privacy')}</button></p>{/* 밑줄 링크 모양(UXM-19) */}
    </div></div>
  </>);
}

// 3차 검수 L-3(2026-09-27) — 동의 여부를 조회하는 동안 조직 화면(채널·멤버 등)이 비치면 안 된다. AiConsentGate와
// 같은 자리에(본문 또는 bare로 레일 안) 중립적인 로딩 표시만 보여준다 — "동의 안 함"을 단정하지 않는다.
function OrgGateLoading({ t, onMenu, bare = false }) {
  return (<>
    {!bare && <div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{t('ui.loading')}</span></div>}
    <div className={bare ? 'msgr-consent-rail' : 'msgr-thread'} style={bare ? undefined : { display: 'flex' }}><div className="msgr-empty">
      <p>{t('ui.loading')}</p>
    </div></div>
  </>);
}

function EmptyOrg({ org, onMenu, createOrg, createChannel, newWhy = null, invite, askAdmin = null, browse = null, joinable = [], joinDomain, deletedOrgs = [], restoreOrg, joinWithCode, onboard }) {
  const { t } = useT();
  const steps = org ? orgSteps({ t, ...onboard, hasChannel: false, isAdmin: true, createChannel, newWhy, invite }) : noOrgSteps({ t, createOrg, joinWithCode, joinable, joinDomain, deletedOrgs, restoreOrg });
  return (<>
    <div className="msgr-top"><NavButton onMenu={onMenu} /><span className="title">{org?.name ?? t('app.title')}</span><span className="topic">{org ? t(browse ? 'ch.notJoined.short' : 'ch.noneYet.short') : t('org.none')}</span></div>
    <div className="msgr-thread" style={{ display: 'flex' }}><div className="msgr-empty">
      <span className="msgr-klabel">{org ? t('ch.list') : t('org.pick')}</span>
      {org && !invite ? (<>{/* 빈 상태 안전망(설계서 2-4) — 관리자 아닌 사람이 초대로 들어왔는데 볼 채널이 없을 때 */}
        <h1>{t('inv.empty.title')}</h1>
        <p>{t('inv.empty.desc')}{askAdmin ? ` ${askAdmin}` : ''}</p>
        <div className="acts">{browse && <button type="button" className="btn btn-primary sm" onClick={browse}><I name="hash" size={13} />{t('inv.empty.browse')}</button>}{createChannel && <button type="button" className="btn sm" onClick={createChannel}><I name="hash" size={13} />{t('ch.new')}</button>}</div>{!createChannel && newWhy && <p className="msgr-hint">{t(newWhy)}</p>}
      </>) : (<>
      <h1>{org ? t('ch.noChannelTitle') : t('org.noneTitle')}</h1>
      <p>{org ? t('ch.noChannelDesc') : t('org.noneDesc')}</p>
      {org && browse && <div className="acts"><button type="button" className="btn btn-primary sm" onClick={browse}><I name="hash" size={13} />{t('inv.empty.browse')}</button></div>}{/* 공개 채널이 이미 있으면 둘러보기를 먼저(UXM-29 — 첫 채널 만들기를 앞세웠다) */}
      <OrgStepList steps={steps} />
      </>)}
    </div></div>
  </>);
}

/* ─── 채널 본문: 상단(제목·멤버 스택·세그먼트 탭) + 척추 스레드 + 2단 독 ─── */
// 개인 공간 표지 — 조직 아바타(글자) 대신 사람 아이콘 + 액센트 틴트. 색만이 아니라 아이콘·라벨로도 조직과 구분한다(유건 2026-09-18).
function PersonalMark({ sm = false }) { return <span className={`msgr-av personal${sm ? ' sm' : ''}`} aria-hidden="true"><I name="person" size={sm ? 13 : 15} /></span>; }

/** 개인 방 보조 줄(2026-09-30 분리 검수 M6·H3): ① 방을 연 사람(승인자)에게 상대의 에이전트 참여 요청 — 알림함은 친구 항목만이라 어디에도 안 보였다
    ② 에이전트가 든 방에서 AI 이용 동의 전인 사람에게 안내 — 동의 전 글은 에이전트에게 가지 않는다(서버가 명시 동의만 인정). 요청은 방이 바뀌거나 방송이 올 때만 다시 읽는다. */
function PersonalRoomBar({ chId, uid, hasCrews, event, nameOfUser, crewName = () => null, onChanged, onError }) {
  const { t, lang } = useT();
  const { aiConsented, aiConsentKnown, setAiConsent } = useContext(SafetyCtx);
  const [reqs, setReqs] = useState([]); const [busy, setBusy] = useState(false); const [reqFailed, setReqFailed] = useState(false); const [reqTry, setReqTry] = useState(0); // 요청을 확인하지 못함 — 조용히 숨기지 않고 [다시 확인](화면 검수 UL1)
  const reqSignal = event && event.channel_id === chId && (event.kind === 'crew_join' || event.kind === 'approval' || (event.kind === 'message' && event.msgKind === 'system')) ? event.at : 0; // 이 방의 넣기 요청·결재·안내 글 방송에만 다시 읽는다(방송마다 2건 조회하던 것, 기능 점검 D2)
  const nameAsked = useRef(new Set()); // 이름을 다시 읽어 본 요청 id — 옛 서버(대기 크루 이름을 안 주는 정의)에서 방송마다 다시 읽지 않게 요청당 한 번
  useEffect(() => { let live = true; (async () => {
    const { reqs: mine, failed } = await readRoomJoinRequests({ uid, approver: () => supabase.rpc('msgr_dm_approver', { ch: chId }),
      pending: () => q(supabase.from('msgr_channel_crew_requests').select('id, crew_id, requested_by').eq('channel_id', chId).eq('status', 'pending')) });
    if (!live) return;
    setReqs(mine); setReqFailed(failed);
    // 방금 온 요청의 에이전트가 목록에 없으면 한 번 다시 읽는다 — 서버(20261001160000)가 대기 크루 이름을 방 구성원에게 준다. 주기 재조회(30초)를 기다리면 그동안 이름 없이 보였다
    const fresh = mine.filter((r) => !crewName(r.crew_id) && !nameAsked.current.has(r.id));
    if (fresh.length) { fresh.forEach((r) => nameAsked.current.add(r.id)); onChanged?.(); }
  })().catch(() => {}); return () => { live = false; }; }, [chId, uid, reqSignal, reqTry]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (r, ok) => { setBusy(true); try { await q(supabase.rpc('msgr_crew_join_decide', { req: r.id, approve: ok })); setReqs((xs) => xs.filter((x) => x.id !== r.id)); onChanged?.(); } catch (e) { onError?.(friendlyErr(e.message, t)); } finally { setBusy(false); } };
  const agree = async () => { setBusy(true); try { await setAiConsent(true); } catch { onError?.(t('consent.ai.failed')); } finally { setBusy(false); } };
  return (<>
    {reqFailed && <div className="msgr-joinbar" role="status"><span>{t('personal.crewReq.failed')}</span><button type="button" className="btn sm" onClick={() => setReqTry((x) => x + 1)}>{t('personal.crewReq.retry')}</button></div>}
    {reqs.map((r) => <div key={r.id} className="msgr-joinbar" role="region"><span>{(() => { const crew = crewName(r.crew_id); const who = nameOfUser(r.requested_by); return crew ? (lang === 'en' ? (x) => x : koJosa)(t('personal.crewReq.named', { name: who, crew })) : t('personal.crewReq', { name: who }); })()}</span>{/* 에이전트 이름을 알면 이름까지(친구의 에이전트는 같은 방에 든 적이 있을 때만 이름을 읽을 수 있다 — 서버가 크루 행을 주인에게만 연다) */}
      <span className="msgr-joinbar-acts"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => decide(r, true)}>{t('ch.crew.join.approve')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => decide(r, false)}>{t('ch.crew.join.reject')}</button></span></div>)}
    {hasCrews && aiConsentKnown && !aiConsented && <div className="msgr-joinbar" role="region"><span>{t('consent.ai.personal.room')}</span><button type="button" className="btn btn-primary sm" disabled={busy} onClick={agree}>{t('consent.ai.confirm')}</button></div>}
  </>);
}

/** 옛 조직 1:1 안내 띠(유건 2026-10-05) — "이 에이전트와의 1:1은 개인 공간에서 이어집니다" + [개인 1:1로 이동]. 누르면 옮기는 동안 버튼이 '여는 중'으로 바뀐다 */
function LegacyDmBar({ onGo, t }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  return <div className="msgr-joinbar msgr-movedbar" role="status"><span>{t('dm.legacy.note')}</span>
    <button type="button" className="btn btn-primary sm" disabled={busy} aria-busy={busy} onClick={async () => { setBusy(true); try { await onGo(); } finally { if (alive.current) setBusy(false); } }}>{t(busy ? 'dm.legacy.going' : 'dm.legacy.go')}</button></div>;
}
/** 이전 대화 보기(분리 검수 2026-10-05 #2) — 내 에이전트 개인 1:1 위, 그 에이전트의 옛 조직 1:1마다 한 줄("이전 대화 보기 · 조직 N개"). 옛 방이 없거나 글이 0개면 그리지 않는다.
    find = 세션에 에이전트당 한 번 묻는 약속(Shell findEarlier — 내 크루 행을 읽기 전이면 null이라 ready가 바뀌면 다시 부른다) */
function EarlierDmBar({ find, ready, orgs, onOpen, t }) {
  const [list, setList] = useState(null);
  useEffect(() => { if (!ready) return undefined; let live = true; find()?.then((x) => { if (live) setList(x); }); return () => { live = false; }; }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps -- 방(key)마다 한 번
  const lines = earlierLines(list, orgs);
  if (!lines.length) return null;
  return <nav className="msgr-joinbar msgr-movedbar msgr-earlier" aria-label={t('dm.earlier.label')}>{lines.map((l) => (
    <button key={l.channelId} type="button" className="msgr-earlier-line" onClick={() => onOpen(l)}><I name="clock" size={14} /><span>{t(...earlierLineLabel(l))}</span><I name="next" size={14} className="go" /></button>))}</nav>;
}
function Channel({ movedBar = null, onCrewJoined = null, onCrewFailed = null, onScreen = true, namePrompt = null, onOutsideDm = null, outsideDmPersonal = null, onPersonalChanged = null, startCard = null, jumpTo = null, jumpStart = false, onJumped, channel, preview = false, onJoin, orgId, org, uid, isAdmin, locked = false, policy, members, crews, people = [], mentionPeople = null, chCrews = [], nameOfUser, crewOf, event, typing, typingStart = {}, progress = {}, received = {}, onRead, muted = false, onToggleMute, onToggleMemory, broadcast, onError, onNote = () => {}, onMenu, onCrew, onTitle, onCrewAdd, mentionReq, onMentionDone, dmName, channels = [], onOpenRelay, isPersonal = false, onCrewPosted = () => {}, crewPosts = null, seenAt = null }) {
  const { t, lang } = useT();
  // 보관한 방(이전 대화 보기로 연 옛 조직 1:1, 유건 결정 2026-10-08 1-②) — 읽기 전용. 목록·개인 방 조회는 보관 방을 빼고 archived_at을 돌려주지 않아(loadOrg·addRoom·msgr_dm_personal_list)
  // 이 표지는 Shell archivedRoomFor가 넘긴 행에서만 선다. 새 글은 서버도 막는다(msgr_can_write_channel)
  const archived = !!channel.archived_at;
  const phone = useIsPhone(); // 폰 머리 부제(멤버·에이전트 수) — 데스크톱은 그리지 않는다
  const topRef = useRef(null);
  // 상단 바 실제 높이 → .msgr-main의 --msgr-top-h. 우측 패널·크루 시트가 그 아래에서 시작한다(상단 바가 두 줄로 접히면 72px 고정 패널이
  // 둘째 줄의 참여 버튼·탭을 덮어 누를 수 없던 것, 검수 #603 MEDIUM). 폭으로 추정하지 않는다 — 번역·이름 길이에 흔들리지 않게
  // 입력창 받침(.msgr-dock) 높이도 같이 — 본문이 좁아 입력창이 패널 옆으로 비켜서지 못하면 패널이 받침 위에서 끝난다(900·820px 크루 시트가 전송 버튼을 덮던 것)
  useLayoutEffect(() => {
    const el = topRef.current; const main = el?.parentElement;
    if (!el || !main || typeof ResizeObserver === 'undefined') return undefined;
    const dock = main.querySelector(':scope > .msgr-dock');
    const set = () => { main.style.setProperty('--msgr-top-h', `${el.offsetHeight}px`); main.style.setProperty('--msgr-dock-h', `${dock?.offsetHeight ?? 0}px`); };
    set(); const ro = new ResizeObserver(set); ro.observe(el); if (dock) ro.observe(dock);
    return () => { ro.disconnect(); main.style.removeProperty('--msgr-top-h'); main.style.removeProperty('--msgr-dock-h'); };
  }, [preview]); // 미리보기(가입 막대) ↔ 입력창이 바뀌면 받침을 다시 잡는다
  const [msgs, setMsgs] = useState(null); const [aps, setAps] = useState({}); const [atts, setAtts] = useState({});
  // 그 크루의 새 글이 어느 경로로든(방송·재연결·복귀·새로고침) 들어오면 '입력 중'을 내린다 — 방송으로 온 답만 내리던 탓에 다시 읽은 답 뒤에 말풍선이 20초 남았다(검수 #send-feedback MEDIUM)
  const ownPosts = useMemo(() => createCrewPostsMemory(), []); const postsMem = crewPosts ?? ownPosts; // 셸 기록(방을 다시 열어도 남는다) — 없으면 이 화면 것
  useEffect(() => { if (!msgs) return; for (const c of postsMem.read(chId, msgs)) onCrewPosted(c); }, [msgs]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstLoad = useRef({ max: null }); // 이 화면의 첫 목록 표지(noteSeen)
  const seenAtRef = useRef(seenAt ?? new Map()); // 셸 기록(seenAt — 방을 다시 열어도 남는다), 없으면 이 화면 것. 내 글을 이 기기가 처음 본 시각 — 대기 표시의 신호 비교를 기기 시계끼리 하려고(검수 #send-feedback LOW)
  const [pending, setPending] = useState([]); // 보냈지만 서버 행이 아직 안 온 내 글(낙관적 렌더)
  const [uploads, setUploads] = useState({}); // client_msg_id → 이 기기가 올리는 중인 파일 이름(첨부만 보낸 글의 자리표시, MSG-06)
  const [activeMid, setActiveMid] = useState(null); // 로빙 tabindex의 현재 행(없으면 마지막 글) — 목록 전체가 Tab 한 칸(검수 K8)
  const [replyReq, setReplyReq] = useState(null); // hover [답글] → 컴포저에 답글 대상(D17)
  const [tab, setTab] = useState('all');
  const [workOpen, setWorkOpen] = useState(false);
  const [stopping, setStopping] = useState({}); // 중단 요청 "중"(RPC 왕복 동안) — 키 `${crewId}:${sourceMsgId}`(중복 클릭 차단, 유건 확정 2026-09-26 크루 작업 중단)
  const [stopRequested, setStopRequested] = useState({}); // 중단 요청 "됨"(RPC true) — 그 실행 카드가 사라질 때까지 버튼을 비활성 고정(분리 검수 L-3)
  const feed = useRef(null);
  const pullThread = usePullToRefresh(phone, async () => {
    stick.current = false;
    await Promise.all([load(0, true), loadApprovals()]);
  }, onError);
  const setFeed = useCallback((node) => { feed.current = node; pullThread.setRef(node); }, [pullThread.setRef]);
  const [sbw, setSbw] = useState(0); // 스레드 스크롤바 폭의 절반 — 독 좌우를 대화 열과 맞춘다(오버레이 스크롤바면 0)
  useEffect(() => { const el = feed.current; if (!el) return; const m = () => setSbw((el.offsetWidth - el.clientWidth) / 2); m(); window.addEventListener('resize', m); return () => window.removeEventListener('resize', m); }, []);
  useLayoutEffect(() => { const main = topRef.current?.parentElement; if (!main) return undefined; main.style.setProperty('--sbw', `${sbw}px`); return () => main.style.removeProperty('--sbw'); }, [sbw]); // 입력창 받침(.msgr-dock)과 안내 띠(.msgr-joinbar)가 같은 좌우 열(--col-l/--col-r)을 쓰도록 본문에도 스크롤바 보정을 둔다(LA-23)
  const chId = channel.id;
  const hydrate = useCallback(async (ids) => { // 메시지 묶음의 첨부·반응 — 첫 로드·새 메시지·이전 기록 공용
    if (!ids.length) return;
    // 첨부와 반응은 서로 기다릴 이유가 없다 — 순차로 두면 도착 경로마다 왕복이 하나씩 더 붙는다.
    const [a, rx] = await Promise.all([
      q(supabase.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').in('message_id', ids)),
      q(supabase.from('msgr_reactions').select('message_id, user_id, emoji').in('message_id', ids)),
    ]);
    // 첨부는 지우지 않으므로(보존 규칙) 이미 보이는 첨부를 빈 결과로 덮지 않는다 — 첨부 등록 전에 나간 조회가 attach 방송의 재조회(reloadAtts)보다 늦게 도착하는 경합(검수 LOW)
    setAtts((cur) => { const n = { ...cur }; const got = {}; for (const r of a) (got[r.message_id] ??= []).push(r); for (const id of ids) n[id] = got[id] ?? (cur[id]?.length ? cur[id] : []); return n; });
    setReacts((cur) => { const n = { ...cur }; for (const id of ids) n[id] = []; for (const r of rx) (n[r.message_id] ??= []).push(r); return n; });
  }, []);
  // 이전 기록(스크롤백) — 가장 오래된 id 앞을 한 페이지씩. 위로 스크롤(120px 안)하거나 맨 위 버튼으로.
  // 위치 보존은 높이 스냅샷이 아니라 앵커(붙이기 직전 맨 위 메시지의 DOM 노드 — React가 key로 보존)의 위치 델타로: 본문 prepend 커밋(레이아웃 효과)과
  // 그 뒤 늦게 오는 첨부·반응·이미지 로드(척추 ResizeObserver)에서 같은 앵커로 계속 되맞춘다(검수 #531 HIGH-1: 첨부 착지에 3,759px 튐). 델타 가산이라 사용자 스크롤과 충돌하지 않는다.
  const [hasMore, setHasMore] = useState(true); const [older, setOlder] = useState(false); const olderRef = useRef(false); const anchor = useRef(null);
  const live = useRef({}); live.current = { msgs, atts }; // 폴·재개가 최신 목록을 보되 effect 재구독은 피한다
  const failRef = useRef(onCrewFailed); failRef.current = onCrewFailed; // load(useCallback)의 의존을 늘리지 않게 ref로
  const yOf = (el, node) => node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  const keepAnchor = useCallback(() => { const a = anchor.current; const el = feed.current; if (!a || !el || !el.contains(a.node)) return; const y = yOf(el, a.node); if (y !== a.y) { el.scrollTop += y - a.y; a.y = y; } }, []);
  const loadOlder = useCallback(async () => {
    const first = msgs?.[0]?.id; const el = feed.current;
    if (!first || olderRef.current || !hasMore) return;
    const node = el?.querySelector('[data-mid]'); anchor.current = node ? { node, y: yOf(el, node) } : null; // 컨트롤이 '불러오는 중'으로 바뀌는 높이 변화까지 보정 범위에(검수 #531 L-6)
    olderRef.current = true; setOlder(true); // ref 가드 — 한 태스크의 scroll 여러 건이 같은 질의를 겹쳐 내지 않게(검수 #531 L-1)
    stick.current = false; // 이전 기록을 부르는 건 위를 보는 것 — 바닥 추종(toBottom)이 keepAnchor를 덮지 않게 끈다(검수 #531 L-4: 두 주인)
    try {
      const rows = await q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, created_at, edited_at, deleted_at, meta, client_msg_id')
        .eq('channel_id', chId).lt('id', first).order('id', { ascending: false }).limit(PAGE));
      const list = rows.reverse();
      setMsgs((cur) => { const base = cur ?? []; const seen = new Set(base.map((m) => m.id)); return [...list.filter((m) => !seen.has(m.id)), ...base]; });
      setHasMore(rows.length >= PAGE);
      await hydrate(list.map((m) => m.id));
    } catch (e) { onError(e.message); } finally { olderRef.current = false; setOlder(false); }
  }, [msgs, hasMore, chId, hydrate]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(keepAnchor, [msgs, atts, older, keepAnchor]); // 커밋 직후 동기 보정(깜빡임 없음) — 본문·첨부·컨트롤 상태. 채널 전환은 key 리마운트라 별도 초기화 없음
  useEffect(() => { const el = feed.current; if (!el) return; const f = () => { if (el.scrollTop < 120) loadOlder(); }; el.addEventListener('scroll', f, { passive: true }); return () => el.removeEventListener('scroll', f); }, [loadOlder]);
  const noteRef = useRef(null); noteRef.current = (key) => onNote(t(key)); // load(useCallback)의 의존을 늘리지 않게 ref로
  const load = useCallback(async (afterId = 0, preserve = false) => {
    const cols = 'id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, created_at, edited_at, deleted_at, meta, client_msg_id';
    // 새 메시지 구분선 기준(열 때의 읽음 커서)은 글과 같이 읽어 글보다 먼저 고정한다 — 글이 그려지면 읽음 표시(onRead)가 커서를 올리므로,
    // 그 뒤에 읽으면 방금 온 글까지 읽은 것으로 보여 줄이 사라졌다(D15: 다른 채널에 있을 때 온 글)
    // 따라잡기(afterId)는 쪽이 꽉 차면 이어 읽는다(MSG-02 — 100개에서 멈춰 최신 글이 안 보였다). 상한을 넘으면 최신 쪽으로 옮기고 사이는 이전 기록 불러오기가 잇는다
    const [caught, rd] = await Promise.all([
      afterId ? readMissed({ afterId, pageSize: PAGE, maxPages: CATCHUP_PAGES, fetchPage: (cursor, limit) => q(supabase.from('msgr_messages').select(cols).eq('channel_id', chId).gt('id', cursor).order('id', { ascending: true }).limit(limit)) })
        : q(supabase.from('msgr_messages').select(cols).eq('channel_id', chId).gt('id', afterId).order('id', { ascending: false }).limit(PAGE)).then((rows) => ({ rows, more: false })),
      afterId ? null : q(supabase.from('msgr_reads').select('last_read_id').eq('channel_id', chId).eq('user_id', uid).maybeSingle()).catch(() => null),
    ]);
    if (!afterId && !preserve) setDivider(rd?.last_read_id ?? 0);
    if (caught.more) {
      const latest = [...await q(supabase.from('msgr_messages').select(cols).eq('channel_id', chId).order('id', { ascending: false }).limit(PAGE))].reverse();
      setMsgs(latest); setHasMore(true); setPending((cur) => reconcilePending(cur, latest)); stick.current = true;
      noteRef.current('thread.jumped'); // 최신 글로 옮겼다고 알린다 — 위로 올리면 이어진다
      await hydrate(latest.map((m) => m.id));
      return;
    }
    const rows = caught.rows;
    const firstId = live.current.msgs?.[0]?.id;
    const throughId = rows[0]?.id;
    const list = preserve ? await refreshMessageWindow({ firstId, throughId, pageSize: PAGE,
      fetchPage: (cursor, until, limit) => q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, created_at, edited_at, deleted_at, meta, client_msg_id')
        .eq('channel_id', chId).gt('id', cursor).lte('id', until).order('id', { ascending: true }).limit(limit)),
    }) : afterId ? rows : [...rows].reverse(); // 받은 배열은 뒤집지 않는다 — 같은 조회가 같은 배열을 돌려주는 백엔드(테스트 픽스처)에서 두 번째 조회가 거꾸로 그려졌다
    for (const id of failedCrewsInFetch(list, { afterId, preserve })) failRef.current?.(id); // 새로 도착한 실패 답 → 그 크루 얼굴 '오류'(채널을 열 때 읽은 글·재조회·오래 묵은 글은 제외)
    setMsgs((cur) => { const base = cur ?? []; const seen = new Set(base.map((m) => m.id)); if (preserve) return mergeRefreshedMessages(base, list, firstId, throughId); return afterId ? [...base, ...list.filter((m) => !seen.has(m.id))] : list; });
    setPending((cur) => reconcilePending(cur, list)); // 조회로 도착한 내 글도 낙관적 자리를 비운다
    if (!afterId && !preserve) setHasMore(rows.length >= PAGE);
    await hydrate(list.map((m) => m.id));
  }, [chId, hydrate]);
  const catchUp = useMemo(() => createCatchUp(() => load(live.current.msgs?.at(-1)?.id ?? 0)), [load]); // 놓친 글 따라잡기는 한 번에 하나 — 겹친 요청은 끝난 뒤 한 번(검수 L3: 방송마다 겹쳐 '최신으로 옮겼다'가 여러 번)
  // 결재 카드는 메시지 도착 경로에서 분리한다. 전에는 글 한 건이 올 때마다 채널의 결재 전량을
  // 다시 읽었다(방송 1건 = 결재 조회 1회). 이제 채널을 열 때와 approval 방송이 올 때만 읽는다.
  const loadApprovals = useCallback(async () => {
    const apRows = await q(supabase.from('msgr_crew_approvals').select('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id, risk, kind, payload').eq('channel_id', chId));
    setAps(Object.fromEntries(apRows.map((r) => [r.id, r])));
  }, [chId]);
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadApprovals().catch(() => {}); }, [loadApprovals]); // 채널을 열 때 한 번 — 이후는 approval 방송이 갱신한다
  useEffect(() => {
    if (!isMobilePlatform) return;
    return observeMobileResume(() => catchUp().catch((e) => onError(e.message))); // 증분 — 첫 페이지로 통째 교체하면 스크롤백 기록이 사라진다(검수 #531 HIGH-2)
  }, [catchUp]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reacts, setReacts] = useState({}); const [divider, setDivider] = useState(0); // 반응(메시지별)·새 메시지 구분선(열 때의 읽음 커서)
  const reloadReacts = useCallback(async (id) => { const rx = await q(supabase.from('msgr_reactions').select('message_id, user_id, emoji').eq('message_id', id)); setReacts((cur) => ({ ...cur, [id]: rx })); }, []);
  const reloadAtts = useCallback(async (id) => { const a = await q(supabase.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').eq('message_id', id)); setAtts((cur) => ({ ...cur, [id]: a })); }, []);
  const reloadMsg = useCallback(async (id) => { const row = await q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, created_at, edited_at, deleted_at, meta, client_msg_id').eq('id', id).maybeSingle()); if (row) setMsgs((cur) => (cur ?? []).map((m) => (m.id === id ? row : m))); }, []);
  const toggleReact = async (m, emoji) => { try { const mine = (reacts[m.id] ?? []).some((r) => r.user_id === uid && r.emoji === emoji); if (mine) await q(supabase.from('msgr_reactions').delete().eq('message_id', m.id).eq('user_id', uid).eq('emoji', emoji)); else await q(supabase.from('msgr_reactions').insert({ message_id: m.id, user_id: uid, emoji })); await reloadReacts(m.id); broadcast?.('reaction', { channel_id: chId, message_id: m.id }); } catch (e) { onError(e.message); } };
  const editMsg = async (m, body) => { try { await q(supabase.from('msgr_messages').update({ body, edited_at: new Date().toISOString() }).eq('id', m.id)); await reloadMsg(m.id); broadcast?.('edit', { channel_id: chId, message_id: m.id }); } catch (e) { onError(e.message); } };
  const deleteMsg = async (m) => { try { await q(supabase.from('msgr_messages').update({ body: '', deleted_at: new Date().toISOString() }).eq('id', m.id)); await reloadMsg(m.id); broadcast?.('edit', { channel_id: chId, message_id: m.id }); } catch (e) { onError(e.message); } };
  const lastId = msgs?.at(-1)?.id ?? 0;
  const rtSeen = useRef(0); const [rtDown, setRtDown] = useState(false); // 마지막 방송 시각 · 실시간이 끊겼다고 알려진 동안(보정 조회는 이때만 — 기능 점검 D2)
  useEffect(() => {
    if (!event) return;
    // 방송이 실어 오는 것은 id·채널·멘션뿐이라 본문은 조회로 채운다. 이 분기는 구분자가
    // payload에 덮여 있던 동안 한 번도 닿지 않았다(글은 10초 폴백 폴에서야 그려졌다).
    if (event.kind === 'message' && event.channel_id === chId) {
      rtSeen.current = Date.now();
      if (!(live.current.msgs ?? []).some((m) => m.id === event.id)) catchUp().catch(() => {});
      // 결재 카드 글은 approval 방송과 짝으로 온다. 그 방송 하나를 놓치면 채널을 다시 열 때까지 카드가
      // 비어 있게 된다(크루는 결정을 기다리며 멈추고 사람은 요청을 모른다). 카드 글을 봤으면 결재도 읽는다.
      if (event.msgKind === 'approval_card') loadApprovals().catch(() => {});
    }
    if (event.kind === 'rt_down') { rtSeen.current = 0; setRtDown(true); } // 알려진 끊김 — 보정 조회를 켠다
    if (event.kind === 'rt_up') { setRtDown(false); catchUp().catch(() => {}); loadApprovals().catch(() => {}); } // 다시 붙었다 — 끊긴 동안 놓친 글을 한 번 따라잡고 보정 조회를 끈다
    if (event.kind === 'approval' && event.channel_id === chId) { rtSeen.current = Date.now(); loadApprovals().catch(() => {}); catchUp().catch(() => {}); }
    if (event.kind === 'reaction' && event.channel_id === chId && event.message_id) reloadReacts(event.message_id).catch(() => {});
    if (event.kind === 'edit' && event.channel_id === chId && event.message_id) reloadMsg(event.message_id).catch(() => {});
    // 첨부는 글보다 0.2~3.6초 늦게 등록된다(운영 실측 2026-09-30). 글 방송 때 읽은 빈 첨부가 그대로 남아 채널을 다시 열어야 보이던 결함 — 서버가 첨부마다 보내는 attach로 다시 읽는다.
    if (event.kind === 'attach' && event.channel_id === chId && (event.message_id ?? event.id)) reloadAtts(event.message_id ?? event.id).catch(() => {});
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  const [away, setAway] = useState(false); // 바닥에서 한 화면 넘게 올라가 있으면 [맨 아래로](D22 S85)
  const stick = useRef(true); // 바닥 고정 여부 — 사용자가 바닥에서 40px 넘게 올려두면 false(QA: 열릴 때 30px 모자라게 멈춰 마지막 메시지가 가려졌다)
  useEffect(() => { stick.current = true; }, [chId]);
  // 검색에서 고른 글로 가기(D11) — 목록에 없으면 이전 기록을 한 쪽씩 더 불러오고(스크롤백과 같은 길), 찾으면 가운데로 + 1.5초 강조. 끝까지 없으면 그만둔다.
  useEffect(() => {
    if (!jumpTo || !msgs) return;
    if (tab !== 'all') { setTab('all'); return; } // 걸러진 탭에서는 그 글이 안 보일 수 있다
    const node = feed.current?.querySelector(`[data-mid="${jumpTo}"]`);
    if (node) {
      stick.current = false; // 바닥 추종이 다시 끌어내리지 않게
      node.scrollIntoView({ block: jumpStart ? 'start' : 'center' }); // start = 머리 아래(.msgr-thread scroll-padding-top이 머리 높이 + 12)
      node.classList.add('msgr-hit'); setTimeout(() => node.classList.remove('msgr-hit'), 1500);
      onJumped?.(); return;
    }
    if (hasMore) { if (!olderRef.current) loadOlder(); } else onJumped?.();
  }, [jumpTo, msgs, hasMore, older, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = feed.current; if (!el) return;
    // 고정 해제는 사용자 의도(휠·터치·키·스크롤바 드래그)가 있을 때만 — 프로그램 스크롤(toBottom) 뒤 늦게 도착한 scroll 이벤트가
    // 그 사이 자란 내용(실행 카드·Markdown 지연 렌더) 때문에 gap≥40으로 읽혀 고정을 풀던 경합(실측 2026-09-09: gap 294px에서 멈춤).
    let userAt = 0; let dragging = false;
    const mark = () => { userAt = Date.now(); };
    const onScroll = () => { const gap = el.scrollHeight - el.scrollTop - el.clientHeight; if (gap < 40) stick.current = true; else if (dragging || Date.now() - userAt < 600) stick.current = false; setAway(gap > el.clientHeight); };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', mark, { passive: true }); el.addEventListener('touchmove', mark, { passive: true }); el.addEventListener('keydown', mark);
    const down = () => { dragging = true; }; const up = () => { dragging = false; };
    el.addEventListener('pointerdown', down); window.addEventListener('pointerup', up);
    const toBottom = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(() => { keepAnchor(); toBottom(); }); // 렌더 뒤 높이 변화(Markdown·첨부·타이핑 표시)에도 바닥을 따라간다. 앵커 되맞춤이 먼저(바닥 고정이면 toBottom이 이긴다)
    const spine = el.querySelector(':scope > .msgr-spine'); if (spine) ro.observe(spine); // 첫 자식이 아니라 이름으로 — 당김 표시가 늘 붙어 첫 자식이 된 뒤 관찰이 높이 0 요소로 빠져 바닥 따라가기가 꺼졌다(2026-09-29 검수 HIGH-1)
    // 목록 창이 줄면(키보드가 올라옴) 보던 아래쪽을 그대로 둔다 — 바닥이면 바닥, 위를 보던 중이면 줄어든 만큼 올린다(카톡·텔레그램 방식, 유건 실기기 2026-09-29: 말풍선이 키보드에 가렸다)
    let h = el.clientHeight;
    const roBox = new ResizeObserver(() => { const d = h - el.clientHeight; h = el.clientHeight; if (!el.closest('.msgr-phone')) return; if (stick.current) toBottom(); else if (d > 0) el.scrollTop += d; }); // 폰만(검수 L1)
    roBox.observe(el);
    toBottom();
    return () => { el.removeEventListener('scroll', onScroll); el.removeEventListener('wheel', mark); el.removeEventListener('touchmove', mark); el.removeEventListener('keydown', mark); el.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); ro.disconnect(); roBox.disconnect(); };
  }, [chId, keepAnchor]);
  // 폰: 입력 중 대화 목록을 끌거나 짧게 누르면 키보드를 내린다 — iOS 보조 막대 ✓를 숨긴 뒤 아이폰에는 내리기 키가 없다(유건 실기기 2026-10-04). 데스크톱은 붙이지 않는다.
  useEffect(() => { const el = feed.current; if (!el?.closest('.msgr-phone')) return; return attachKeyboardDismiss(el); }, [chId]);
  // 채널을 열 때 스크롤 목표(유건 확정 2026-09-29) — 안 읽은 글(구분선 .msgr-newline)이 있고 한 화면에 안 들어가면 구분선을 위쪽 1/3에 두고 바닥 고정(stick)을 끈다.
  // 한 화면에 다 들어가거나 안 읽은 글이 없으면(또는 100개 넘는 안 읽은 글이라 구분선이 아직 로드 안 된 페이지 밖이면, 미완) 지금처럼 맨 아래.
  // useLayoutEffect라 바로 아래 바닥-스크롤 useEffect보다 먼저 커밋 안에서 실행돼 stick.current를 그 뒤 effect가 그대로 따른다.
  const openScrolledRef = useRef(false);
  useEffect(() => { openScrolledRef.current = false; }, [chId]);
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el || !onScreen || openScrolledRef.current || msgs == null) return; // 숨은 동안(높이 0)엔 계산하지 않고, 보이는 순간 한 번
    openScrolledRef.current = true;
    const line = el.querySelector('.msgr-newline');
    const target = unreadOpenScrollTarget({ scrollHeight: el.scrollHeight, dividerTop: line ? yOf(el, line) : null, clientHeight: el.clientHeight });
    el.scrollTop = target.scrollTop;
    stick.current = target.stick;
  }, [chId, msgs, onScreen]);
  useEffect(() => { const el = feed.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs?.length]);
  useEffect(() => { if (!lastId || !onScreen) return; const mark = () => { if (document.visibilityState !== 'hidden' && document.hasFocus()) onRead?.(chId, lastId); }; mark(); document.addEventListener('visibilitychange', mark); window.addEventListener('focus', mark); return () => { document.removeEventListener('visibilitychange', mark); window.removeEventListener('focus', mark); }; }, [chId, lastId, onScreen]); // eslint-disable-line react-hooks/exhaustive-deps -- 폰 목록 뒤에 숨은 대화는 읽음이 아니다(onScreen). 창이 보여도 초점이 다른 앱에 있으면 읽음으로 치지 않는다(자리 비운 사이 온 글이 조용히 읽음이 되던 결함, 2026-09-12 점검)
  // 앞으로 온 순간 따라잡기 — 가려진 창에서 밀린 글을 다음 폴·밀린 방송 처리까지 기다리지 않고 한 번에(유건 제보 2026-09-18 "앞으로 오면 하나씩 뜬다")
  useEffect(() => onForeground(() => { catchUp().catch(() => {}); loadApprovals().catch(() => {}); }), [catchUp]); // eslint-disable-line react-hooks/exhaustive-deps
  // 보정 조회(10s)는 화면에 보이는 방에서 실시간이 끊겼다고 알려진 동안만 돈다(기능 점검 D2 — 숨겨 둔 방·조용한 방에서 10초마다 글·결재를 읽던 것).
  // 방송이 살아 있으면 새 글은 방송이, 놓친 글은 앞으로 올 때(onForeground)·다시 붙을 때(rt_up)가 따라잡는다.
  useEffect(() => { if (!onScreen || !rtDown) return undefined; const iv = setInterval(() => { catchUp().catch(() => {}); loadApprovals().catch(() => {}); }, 10_000); return () => clearInterval(iv); }, [onScreen, rtDown, catchUp, lastId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 첨부·반응이 빈 묶음 메우기 — 빈 것이 있을 때만 조회한다(없으면 요청 0, 검수 #531 M-1)
  useEffect(() => { if (!onScreen) return undefined; const iv = setInterval(() => { const { msgs: ms, atts: at } = live.current; const miss = (ms ?? []).filter((m) => !(m.id in at)).map((m) => m.id); if (miss.length) hydrate(miss).catch(() => {}); }, 10_000); return () => clearInterval(iv); }, [onScreen, hydrate]);
  // 결재 결정(MSG-07) — 0행이면 다시 읽어 이미 결정된 결재는 오류 없이 결과만(연타·다른 사람이 먼저), 대기 중일 때만 권한 없음(최종 판정은 서버 msgr_can_decide).
  // 끝나면 결재를 바로 다시 읽는다 — approval 방송을 놓쳐도(끊긴 것을 모를 때) 카드가 '대기'와 눌리는 단추로 남지 않게. 진행 중 단추 끄기는 Slip이 한다
  const decide = async (ap, status) => {
    const r = await decideApproval({ update: () => supabase.from('msgr_crew_approvals').update({ status, decided_by: uid, decided_at: new Date().toISOString() }).eq('id', ap.id).select('id'),
      reread: () => q(supabase.from('msgr_crew_approvals').select('status').eq('id', ap.id).maybeSingle()) });
    if (r.result === 'error') onError(friendlyErr(r.message, t));
    else if (r.result === 'denied') onError(t(ap.risk === 'high' ? 'ap.approverOnly' : 'ap.ownerOnly'));
    await loadApprovals().catch(() => {}); catchUp().catch(() => {});
  };
  // 크루 작업 중단(유건 확정 2026-09-26) — 서버(msgr_request_stop)가 권한을 다시 검사한다. 여기 canStop은 화면 노출만 — 숨김이 권한의 전부가 아니다.
  // RPC가 true면 그 카드가 사라질 때까지 버튼을 "중단 요청됨"으로 고정하고(분리 검수 L-3), false(이미 끝난 실행)면 짧게 안내한다.
  const requestStop = async (crewId, sourceMsgId) => {
    const key = `${crewId}:${sourceMsgId}`;
    if (!sourceMsgId || stopping[key] || stopRequested[key]) return;
    setStopping((s) => ({ ...s, [key]: true }));
    try {
      const { data, error } = await supabase.rpc('msgr_request_stop', { p_crew: crewId, p_source: sourceMsgId });
      if (error) onError(stopErr(error.message, t));
      else if (data === true) setStopRequested((s) => ({ ...s, [key]: true }));
      else onNote(t('exec.stop.alreadyDone'));
    } catch (e) { onError(stopErr(e.message, t)); }
    finally { setStopping((s) => { const n = { ...s }; delete n[key]; return n; }); }
  };
  const typingCrews = Object.entries(typing).filter(([k, at]) => k.startsWith(`${chId}:`) && Date.now() - at < TYPING_WINDOW_MS).map(([k]) => crewOf(k.split(':')[1])).filter(Boolean);
  // 요약용 — 이름·시작 시각만 뽑아 typing-summary.mjs 순수 함수에 넘긴다(가장 먼저 입력을 시작한 크루 + 나머지 인원, 유건 확정 2026-09-29)
  const typingForSummary = typingCrews.map((c) => ({ id: c.id, name: c.display_name, startedAt: typingStart[`${chId}:${c.id}`] ?? 0 }));
  const typingLabel = typingLabelParams(typingSummary(typingForSummary));
  // 실행 카드 — progress 방송(1.5초 주기)이 있는 크루는 점 세 개 대신 단계·도구·사고 과정 카드. 8초 무갱신이면 만료(브리지 심박 30초는 typing이 덮는다).
  const working = Object.entries(progress).filter(([k, p]) => k.startsWith(`${chId}:`) && Date.now() - p.at < 8000 && typing[k] && Date.now() - typing[k] < TYPING_WINDOW_MS).map(([k, p]) => [crewOf(k.split(':')[1]), p]).filter(([c]) => c);
  // 보낸 뒤 대기 표시(2026-10-05) — 크루를 겨냥한 내 글이 저장되면 그 즉시 '전달됨 · 준비 중', 그 크루가 내 글 뒤에 글을 올릴 때까지(상한 5분).
  // 방송이 오면 '답변 중'(실행 카드면 중단 버튼과 함께), 끊겨도 남고, 30초 무신호면 '조금 오래', 기기가 꺼져 있으면 꺼짐 안내. 화면 계산뿐(요청·저장 0).
  noteSeen(seenAtRef.current, msgs, { uid, now: Date.now(), first: firstLoad.current }); // 첫 목록에 있던 글은 created_at 기준(2차 검수 L-d)
  const awaiting = awaitingReplies({ msgs: msgs ?? [], uid, isDm: channel.kind === 'dm', roomCrewIds: chCrews.map((c) => c.id),
    signals: (crewId) => { const k = `${chId}:${crewId}`; return { typingAt: typing[k], progressAt: progress[k]?.at, receivedAt: received[k] }; },
    away: (crewId) => crewAway(crewOf(crewId)), now: Date.now(), seenAt: (id) => seenAtRef.current.get(id) }).map((a) => ({ ...a, crew: crewOf(a.crewId) })).filter((a) => a.crew);
  const awaitIds = new Set(awaiting.map((a) => a.crewId));
  const [, setAwaitTick] = useState(0); // 대기 표시가 있는 동안만 5초마다 다시 그린다(30초·5분 단계 전환) — 요청 없음
  useEffect(() => { if (!awaiting.length) return undefined; const iv = setInterval(() => setAwaitTick((x) => x + 1), 5000); return () => clearInterval(iv); }, [awaiting.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const workingIds = new Set(working.map(([c]) => c.id));
  // 스레드 안 '입력 중' 말풍선 — 3명까지는 크루별로 각자, 4명부터는 얼굴을 겹친 말풍선 하나로 묶는다(유건 확정 2026-09-29)
  const typingBubbleShown = typingCrews.filter((c) => !workingIds.has(c.id) && !awaitIds.has(c.id)); // 대기 표시가 있는 크루는 그 줄이 '답변 중'을 맡는다(같은 크루가 두 번 보이지 않게)
  const typingBubbleWithStart = typingBubbleShown.map((c) => ({ id: c.id, name: c.display_name, startedAt: typingStart[`${chId}:${c.id}`] ?? 0, crew: c }));
  const typingBubbleGrouped = shouldGroupTypingBubbles(typingBubbleShown.length);
  const typingBubbleGroupFaces = typingBubbleGrouped ? typingBubbleFaces(typingBubbleWithStart) : [];
  const typingBubbleGroupLabel = typingBubbleGrouped ? typingLabelParams(typingSummary(typingBubbleWithStart)) : null;
  // 카드가 사라진(진행 방송이 끊긴) 실행의 상태는 지운다 — 다음에 같은 크루가 새 메시지에 답할 때 옛 "중단 요청됨"이 남지 않게(분리 검수 L-3).
  useEffect(() => {
    const live = new Set(working.map(([c, p]) => `${c.id}:${p.source_msg_id}`));
    setStopRequested((s) => { const n = Object.fromEntries(Object.entries(s).filter(([k]) => live.has(k))); return Object.keys(n).length === Object.keys(s).length ? s : n; });
  }); // 매 렌더 확인 — working은 progress/typing에서 매번 새 배열이라 값(키 집합)으로만 비교, setState는 얕은 동일성이면 리렌더를 만들지 않는다
  const apOf = (m) => m.kind === 'approval_card' ? aps[(m.mentions ?? []).find((x) => x.kind === 'approval')?.id] : null;
  const isMention = (m) => (m.mentions ?? []).some((x) => x.kind === 'user' && x.id === uid);
  // 글 모양(attach-only.mjs) — 첨부만 보낸 글은 첨부가 붙기 전 '올리는 중' 자리표시, 업로드가 전부 실패해 거둔 글·오래된 빈 글은 그리지 않는다(MSG-06)
  const shapeNow = Date.now();
  const shapeOf = (m) => messageShape(m, { attCount: m.id in atts ? atts[m.id].length : null, uploading: !!uploads[m.client_msg_id], now: shapeNow });
  const all = (msgs ?? []).filter((m) => shapeOf(m) !== 'hidden'); const byId = new Map((msgs ?? []).map((m) => [m.id, m])); // 답글 부모 조회 — 기록이 쌓여도 선형(검수 #531 M-2)
  // 중단 버튼 노출 — 그 턴을 시킨 사람(원본 메시지 작성자, 크루 넘김이면 넘긴 크루의 주인 + 스레드 뿌리의 최초 지시자 — 총괄 결정 L-6)
  // 또는 지금 일하는 크루의 주인만(유건 확정 2026-09-26). 원본 메시지가 아직 이 목록에 없으면(스크롤백 밖) 숨긴다 —
  // 화면 판단은 보수적으로, 최종 판정은 서버(msgr_request_stop)가 한다.
  const senderOf = (m) => !m ? null : m.author_kind === 'user' ? m.author_user_id : (crewOf(m.crew_id)?.owner_user_id ?? null);
  const rootAuthorOf = (m) => { if (!m || m.author_kind !== 'crew' || !m.thread_root) return null; const root = byId.get(m.thread_root); return root?.author_kind === 'user' ? root.author_user_id : null; };
  const canStop = (crew, p) => { if (!crew || !p?.source_msg_id) return false; if (crew.owner_user_id === uid) return true; const m = byId.get(p.source_msg_id); return senderOf(m) === uid || rootAuthorOf(m) === uid; };
  // 결재 탭 목록과 결재 숫자는 같은 술어(검수 M2): 대기 중인 결재만
  const isPending = (m) => apOf(m)?.status === 'pending';
  // 탭 숫자 = 지난번에 본 뒤 온 것(D45) — 이번에 열 때의 읽음 커서(divider, '새 메시지' 줄과 같은 기준) 뒤의 글. 보는 중에 온 글도 다시 열 때까지 센다
  // (열면 곧 읽음 처리되므로 현재 커서로 세면 늘 0이 된다 — 검수 권고 (b)). 결재는 결정할 일이라 대기 중이면 센다. 탭 목록은 종전대로 전부 보인다
  const unreadHere = (m) => m.id > divider && !(m.author_kind === 'user' && m.author_user_id === uid);
  const counts = { mention: all.filter((m) => isMention(m) && unreadHere(m)).length, approval: all.filter(isPending).length, crew: all.filter((m) => m.author_kind === 'crew' && unreadHere(m)).length };
  const shown = all.filter((m) => tab === 'all' || (tab === 'mention' && isMention(m)) || (tab === 'approval' && isPending(m)) || (tab === 'crew' && m.author_kind === 'crew'));
  const tabMid = shown.some((x) => x.id === activeMid) ? activeMid : shown.at(-1)?.id; // 지워졌거나 걸러진 행이면 마지막 글로
  const rows = []; let day = null; let newLine = false;
  // 보낸 직후의 내 글(낙관적)은 목록 끝에 같은 Message로 그린다. 키는 client_msg_id — 서버 행이 오면 같은 키의 같은 요소가
  // 제자리에서 바뀐다(떼었다 붙이면 등장 애니메이션을 다시 타 깜빡였다, 유건 제보 2026-09-18).
  const pendingRows = tab === 'all' ? pending.map((x) => ({ id: `pending:${x.clientId}`, client_msg_id: x.clientId, author_kind: 'user', author_user_id: uid, crew_id: null,
    kind: 'text', body: x.body, mentions: [], reply_to: x.replyTo ?? null, created_at: x.at, edited_at: null, deleted_at: null, meta: null, pending: true })) : []; // 답글이면 보내는 중에도 인용 줄을 그린다
  const seq = [...shown, ...pendingRows];
  const isNewAt = (m) => divider > 0 && m.id > divider && !(m.author_kind === 'user' && m.author_user_id === uid);
  const newAt = seq.findIndex(isNewAt); // "새 메시지" 줄이 끼는 자리 — 거기서 묶음을 끊는다
  const flags = groupFlags(seq, (i) => i === newAt);
  const turns = tailTurns(seq, flags); // 턴(같은 사람이 이어 보낸 묶음) — 마지막 글이 전체 복사 버튼을 그린다
  for (const [i, m] of seq.entries()) {
    if (divider > 0 && !newLine && isNewAt(m)) { newLine = true; rows.push(<div key="newline" className="msgr-newline"><span>{t('msg.new')}</span></div>); }
    const k = dayKey(m.created_at);
    if (k !== day) { day = k; const [d, w] = fmtDay(m.created_at, lang); const today = k === new Date().toDateString(); rows.push(<div key={`d${k}`} className="msgr-tnode"><span className={`msgr-dot${today ? ' mark' : ''}`} /><span className="msgr-klabel"><b>{d}</b> {w}</span></div>); }
    rows.push(<Message key={m.client_msg_id || m.id} shape={shapeOf(m)} uploadNames={uploads[m.client_msg_id] ?? null} rowTab={m.id === tabMid ? 0 : -1} onRowFocus={setActiveMid} m={m} uid={uid} lang={lang} t={t} nameOfUser={nameOfUser} crewOf={crewOf} isAdmin={isAdmin} policy={policy} ap={apOf(m)} atts={atts[m.id] ?? []} decide={decide} parent={m.reply_to ? byId.get(m.reply_to) ?? null : null} onCrew={onCrew} onError={onError} reacts={reacts[m.id] ?? []} onReact={archived ? undefined : toggleReact} onEdit={editMsg} onDelete={deleteMsg} onReply={(x) => setReplyReq({ id: x.id, who: x.author_kind === 'user' ? nameOfUser(x.author_user_id) : crewOf(x.crew_id)?.display_name ?? '', body: (x.body ?? '').replace(/\s+/g, ' ').slice(0, 120) })} channels={channels} onOpenRelay={onOpenRelay} dmName={dmName} isPersonal={isPersonal} cont={flags[i].cont} tail={flags[i].tail} turn={turns[i]} inDm={phone && channel.kind === 'dm'} readOnly={archived} />);
  }
  const tabs = [['all', null, 0], ['mention', 'at', counts.mention], ['approval', 'check', counts.approval], ['crew', 'star', counts.crew]];
  return (<>
    <div className="msgr-top" ref={topRef}>
      <NavButton onMenu={onMenu} />
      <button type="button" className="title msgr-titlebtn" onClick={archived ? undefined : onTitle} title={t('ch.sheet')}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} />{phone ? <span className="msgr-channel-name">{channel.kind === 'dm' ? dmName(channel) : channel.name}</span> : (channel.kind === 'dm' ? dmName(channel) : channel.name)}<I name="caret" size={13} className="caret" /></button>
      {channel.org_id === null && <span className="msgr-klabel msgr-scope-badge">{t('personal.badge')}</span>}
      {channel.org_id && org && <span className="msgr-klabel msgr-scope-badge">{org.name}</span>}
      {channel.topic && <span className="topic">{channel.topic}</span>}
      {phone && <span className="msgr-sub">{channel.org_id === null && `${t('personal.badge')} · `}{channel.kind === 'dm' && chCrews.length === 1 && people.length <= 1 ? (chCrews[0].role_text || t('org.crew')) : t('phone.meta', { n: people.length, c: chCrews.length })}</span>}
      {/* 켜고 끄는 자리가 안 보인다(유건 2026-09-09) → 표지 자체가 토글. 아이콘만, 꺼짐 = 취소선·붉은색 */}
      {!archived && <span className="msgr-hchips"><button type="button" className={`msgr-hchip${muted ? ' off' : ''}`} onClick={onToggleMute} title={t(muted ? 'ch.mute.off.tip' : 'ch.mute.on.tip')} aria-pressed={muted} aria-label={t('ch.muted')}><I name={muted ? 'belloff' : 'bell'} size={14} /></button>
      {!isPersonal && <button type="button" className={`msgr-hchip${channel.crew_memory === false ? ' off' : ''}`} onClick={onToggleMemory} title={t(channel.crew_memory === false ? 'ch.memory.off.tip' : 'ch.memory.on.tip')} aria-pressed={channel.crew_memory === false} aria-label={t('ch.memoryOff')}><I name={channel.crew_memory === false ? 'memoff' : 'folder'} size={14} /></button>}</span>}
      <button type="button" className="members" onClick={archived ? undefined : onTitle} title={t('ch.composition')} aria-label={t('ch.composition')}>{phone && <I name="dots" size={20} className="ph-dots" />}{people.slice(0, 4).map((m) => <Av key={m.user_id} name={m.display_name || m.user_id} size="sm" userId={m.user_id} />)}{chCrews.slice(0, 3).map((c) => <Av key={c.id} name={c.display_name} crew size="sm" company={crewTier(c, org) === 'company'} crewId={c.id} />)}<span className="n">{t('ch.composition.count', { p: people.length, c: chCrews.length })}</span></button>
      {!isPersonal && !archived && <button type="button" className="btn sm msgr-work-button" onClick={() => setWorkOpen((v) => !v)} aria-pressed={workOpen} aria-label={t('work.title')}>{t('work.button')}</button>}
      <Seg kind="tab" label={t('ch.tabs')} value={tab} onPick={setTab} options={tabs.map(([k, ic, n]) => ({ v: k, title: t(`tab.${k}`), aria: n > 0 ? `${t(`tab.${k}`)} ${n}` : t(`tab.${k}`), icon: ic ? <I name={ic} size={13} /> : null, label: <span className={ic ? 'lbl' : undefined}>{t(`tab.${k}`)}</span>, n: n > 0 ? n : null }))} />{/* .lbl = 좁은 폭에서 숨기는 글자(아이콘 있는 탭만). 이름은 title·aria-label로 남는다 */}
    </div>
    {movedBar}
    <div className="msgr-thread" ref={setFeed}>
      <PullIndicator phase={pullThread.phase} pulse={pullThread.pulse} t={t} />
      <div className="msgr-spine" onPointerOver={markTurnHover} onPointerLeave={markTurnHover}>
        {msgs === null && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-skel"><i /><i /><i /></div></div>}
        {tab === 'all' && msgs !== null && !hasMore && startCard}
        {msgs !== null && roomTabEmptyKey({ tab, total: all.length, shown: shown.length }) && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-sys">{t(roomTabEmptyKey({ tab, total: all.length, shown: shown.length }))}</div></div>}{/* 멘션·결재·에이전트 탭이 비면 안내(점검 A·B #6) */}
        {msgs !== null && !all.length && !pendingRows.length && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-sys">{t(chCrews.length && channel.kind !== 'dm' ? 'ch.empty' : 'ch.empty.plain')}</div></div>}{/* 보내는 중인 첫 글도 내용으로 센다 — 서버 확인 때 안내 줄이 바뀌며 말풍선이 밀리지 않게 */}
        {tab === 'all' && (all.length > 0 || pendingRows.length > 0) && (hasMore
          ? <div className="msgr-older"><button type="button" className="btn sm ghost" onClick={loadOlder} disabled={older} aria-busy={older || undefined}>{t(older ? 'thread.loading' : 'thread.older')}</button></div>
          : <div className="msgr-older start"><span className="msgr-klabel">{t('thread.start')}</span></div>)}
        {rows}
        {awaiting.map((a) => { const p = working.find(([c]) => c.id === a.crewId)?.[1]; const c = a.crew; // 실행 카드가 있으면 그 자리에서 중단 버튼과 함께(같은 크루를 두 번 그리지 않는다)
          return <ExecCard key={`exec-${c.id}`} crew={c} t={t} wait label={a.phase === 'preparing' ? t('await.preparing', { name: c.display_name }) : t(`await.${a.phase}`)} long={a.phase === 'slow' || a.phase === 'offline'}
            canStop={!!p && canStop(c, p)} stopping={!!p && !!stopping[`${c.id}:${p.source_msg_id}`]} stopRequested={!!p && !!stopRequested[`${c.id}:${p.source_msg_id}`]} onStop={() => p && requestStop(c.id, p.source_msg_id)} />; })}
        {working.filter(([c]) => !awaitIds.has(c.id)).map(([c, p]) => <ExecCard key={`exec-${c.id}`} crew={c} t={t} canStop={canStop(c, p)} stopping={!!stopping[`${c.id}:${p.source_msg_id}`]} stopRequested={!!stopRequested[`${c.id}:${p.source_msg_id}`]} onStop={() => requestStop(c.id, p.source_msg_id)} />)}
        {typingBubbleGrouped
          ? <div className="msgr-row msgr-typing-group"><span className="msgr-facestack">{typingBubbleGroupFaces.map((f) => <Av key={f.id} name={f.name} crew crewId={f.id} size="xs" />)}</span><div className="msgr-typing"><i /><i /><i /><span className="lb">{typingBubbleGroupLabel && t(typingBubbleGroupLabel.key, typingBubbleGroupLabel.vars)}</span></div></div>
          : typingBubbleShown.map((c) => <div key={`typing-${c.id}`} className="msgr-row"><Av name={c.display_name} crew crewId={c.id} /><div><div className="who">{c.display_name}<span className="role">{c.role_text}</span></div><div className="msgr-typing"><i /><i /><i /><span className="lb">{t('msg.typing', { name: c.display_name })}</span></div></div></div>)}
      </div>
      {away && <div className="msgr-tobottom"><button type="button" className="btn sm" onClick={() => { const el = feed.current; if (!el) return; stick.current = true; el.scrollTop = el.scrollHeight; setAway(false); }} aria-label={t('thread.toBottom')}><I name="caret" size={13} /><span className="lbl">{t('thread.toBottom')}</span></button></div>}
    </div>
    {workOpen && <WorkPanel key={chId} channel={channel} roomName={channel.kind === 'dm' ? dmName(channel) : channel.name} uid={uid} isAdmin={isAdmin} locked={locked} crews={chCrews} t={t} lang={lang} onClose={() => setWorkOpen(false)} sheet={!phone} />}{/* 데스크톱: 채널 패널과 같은 시트(폭 380 + 24, #600·#603 비킴 규칙 공유 — 유건 2026-09-18) */}
    {!preview && !archived && namePrompt}
    {(isPersonal || channel.kind === 'dm') && !preview && !archived && <PersonalRoomBar chId={chId} uid={uid} hasCrews={isPersonal && chCrews.length > 0} event={event} nameOfUser={nameOfUser} crewName={(id) => crews.find((c) => c.id === id)?.display_name ?? null} onChanged={onPersonalChanged} onError={onError} />}
    {!preview && !archived && (() => { const off = crewAwayNotice({ channel, chCrews, people, uid, now: Date.now(), awayMs: AWAY_MS }); return off && <div className="msgr-joinbar msgr-awaybar" role="status"><span>{(lang === 'en' ? (x) => x : koJosa)(t(off.mine ? 'crew.dm.away.mine' : 'crew.dm.away', { name: off.name }))}</span>{off.mine && <RunnerButton />}</div>; })()}{/* 에이전트 1:1에서 에이전트가 꺼져 있으면 — 보내도 답이 없는 이유(검수 F, 2026-10-01) */}
    {preview
      ? <div className="msgr-joinbar" role="region" aria-label={t('ch.preview.title')}><span>{t('ch.preview.note', { name: channel.name })}</span><button type="button" className="btn btn-primary" onClick={onJoin}><I name="plus" size={14} />{t('ch.browse.join')}</button></div>
      : archived ? <div className="msgr-joinbar msgr-archivedbar" role="status"><span>{t('dm.archived.note')}</span></div> /* 보관한 옛 1:1(유건 결정 2026-10-08 1-②) — 입력창 자리에 읽기 전용 안내. 새 글은 서버도 막는다(msgr_can_write_channel) */
      : <Composer broadcast={broadcast} onOutsideDm={onOutsideDm} outsideDmPersonal={outsideDmPersonal} onCrewJoined={onCrewJoined} isPersonal={isPersonal} chId={chId} orgId={orgId} org={org} uid={uid} members={members} crews={crews} channel={channel} scopePeople={mentionPeople ?? people} scopeCrews={chCrews} locked={locked} sbw={sbw} typingLabel={typingLabel} mentionReq={mentionReq} onMentionDone={onMentionDone} replyReq={replyReq} onReplyDone={() => setReplyReq(null)} onPending={(x) => { stick.current = true; setPending((cur) => [...cur, x]); if (x.files?.length) setUploads((m) => ({ ...m, [x.clientId]: x.files })); }} onPendingSettled={(clientId, ok) => { if (!ok) setPending((cur) => cur.filter((x) => x.clientId !== clientId)); setUploads((m) => withoutKey(m, clientId)); }} onDiscarded={(id) => reloadMsg(id).catch(() => {})} onSent={async (id) => {
      try {
        await catchUp();
        // Realtime may already have loaded the body before an attachment finished (or was retried).
        const attached = await q(supabase.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').eq('message_id', id));
        setAtts((current) => ({ ...current, [id]: attached }));
      } catch (error) { onError(error.message); }
    }} onError={onError} />}
  </>);
}

/** 슬랙식 반응 피커 — 검색 + 자주 사용 + 분류. 선택·Esc·바깥 클릭으로 닫힘. */
function EmojiPicker({ t, anchor, onPick, onClose }) {
  const [q, setQ] = useState(''); const ref = useRef(null);
  const phone = useIsPhone(); // 폰: 앵커 좌표 대신 아래 시트(CSS) — 앵커 계산이 화면 밖·키보드 밑으로 밀었다(유건 2026-09-11). 검색칸 자동 초점도 끈다(키보드가 시트를 가린다)
  // 화면 고정(fixed) + 열린 동안 스레드 스크롤 잠금(유건 지시 2026-09-09 "드롭박스 열렸을 때는 스크롤 고정, 닫히고 스크롤"). 위치는 창 크기(clientWidth/Height) 기준으로
  // 버튼 아래(자리 없으면 위), 가로는 버튼 왼쪽에 맞추되 창 밖이면 버튼 오른쪽 끝에 맞춘다 — 오른쪽 정렬된 내 글에서 창 밖으로 나가던 결함.
  const W = 322, H = 320, COLS = 9; // 322 = 격자 9×30 + 틈 8 + 안쪽 여백 16 + 세로 스크롤바 자리 ≤ 18 — 가로 스크롤 없음 // COLS = 격자 열 수 — 자주 사용 줄은 이 수만큼
  const viewport = window.visualViewport;
  const vw = viewport?.width ?? document.documentElement.clientWidth, vh = viewport?.height ?? document.documentElement.clientHeight;
  const vtop = viewport?.offsetTop ?? 0;
  const left = Math.max(8, anchor.left + W + 8 <= vw ? anchor.left : Math.min(anchor.right - W, vw - W - 8));
  const top = Math.max(vtop + 8, Math.min(anchor.bottom + H + 8 <= vtop + vh ? anchor.bottom + 6 : anchor.top - H - 6, vtop + vh - H - 8));
  useEffect(() => {
    document.body.classList.add('msgr-lock'); // .msgr-thread overflow hidden — 열린 동안 스크롤 없음
    const armed = performance.now();
    const off = (e) => { if (performance.now() - armed < 400) return; if (ref.current && !ref.current.contains(e.target)) onClose(); }; const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', key);
    return () => { document.body.classList.remove('msgr-lock'); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key); };
  }, [onClose]);
  const hits = searchEmoji(q);
  const grid = (list, key) => <div key={key} className="grid">{list.map((e) => <button key={e} type="button" onClick={() => onPick(e)} title={e}>{e}</button>)}</div>;
  return createPortal( // body 포털 — 상위의 transform이 fixed 기준점을 바꿔 좌표가 502px 밀리던 결함(실측 2026-09-09: style 602 → 실제 1104)
    <div className={`msgr-emojipop${phone ? ' phone' : ''}`} ref={ref} role="dialog" aria-label={t('msg.react')} style={phone ? undefined : { left, top, width: W, maxHeight: H }} onClick={(e) => e.stopPropagation()}>
      <input className="msgr-input sm" placeholder={t('emoji.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus={!phone} />
      <div className="body">
        {hits ? (hits.length ? grid(hits, 'hits') : <p className="msgr-sys">{t('emoji.none')}</p>) : (<>
          <div className="msgr-klabel">{t('emoji.frequent')}</div>{grid(topEmoji(COLS), 'freq')}
          {EMOJI_GROUPS.map((g) => <div key={g.key} className="sec"><div className="msgr-klabel">{t(`emoji.${g.key}`)}</div>{grid(g.items.map(([e]) => e), g.key)}</div>)}
        </>)}
      </div>
    </div>,
    document.body,
  );
}
// 부적절 표현 가리기(App Store 1.2) — 받는 메시지에 명백한 욕설이 있으면 접고, 눌러서만 본다. 설정 꺼짐·내 글이면 그대로 그린다.
function FilteredBody({ text, on, t, children }) {
  const [reveal, setReveal] = useState(false);
  if (on && !reveal && containsProfanity(text)) return <button type="button" className="msgr-hidden-msg" onClick={() => setReveal(true)}>{t('msg.profanity.hidden')}</button>;
  return children;
}
function Message({ m, shape = 'bubble', uploadNames = null, uid, lang, t, nameOfUser, crewOf, isAdmin, policy, ap, atts, decide, parent, onCrew, onError, reacts = [], onReact, onEdit, onDelete, onReply, channels = [], onOpenRelay, dmName, rowTab = -1, onRowFocus, isPersonal = false , cont = false, tail = true, inDm = false, turn = null, readOnly = false}) {
  const [copied, setCopied] = useState(false);
  const [pick, setPick] = useState(false); const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(''); const [confirmDel, setConfirmDel] = useState(false);
  const [ctxAt, setCtxAt] = useState(null); // 데스크톱 우클릭: 동작 줄을 커서 자리에 고정(유건 지시 2026-09-12)
  const [ctxMore, setCtxMore] = useState(false); // ⋯(더보기)로 연 메뉴 — 아이콘 줄에 없는 나머지 동작만
  const [actsOpen, setActsOpen] = useState(false); // 터치는 길게 눌러야 액션이 열린다(마우스는 hover) — 상시 노출은 화면당 대화를 두세 건으로 줄였다
  const safety = useContext(SafetyCtx);
  reacts = reacts.filter((r) => r.user_id === uid || !safety.blocked.has(r.user_id)); // 차단한 사람의 반응은 수·이름 모두 뺀다
  const [reporting, setReporting] = useState(false); const [reportReason, setReportReason] = useState(''); const [safetyBusy, setSafetyBusy] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  useBackClose(actsOpen, () => setActsOpen(false)); useBackClose(!!pick, () => setPick(false)); // Android 뒤로 — 동작 시트·반응 고르기부터 닫는다(MSG-10)
  const [confirmMute, setConfirmMute] = useState(false); // 폰: 에이전트 숨기기 확인 창(숨기면 무엇이 바뀌는지 한 줄, 유건 2026-10-02). 데스크톱은 그대로 바로 숨긴다
  const openedAt = useRef(0); // 길게 눌러 연 시트는 손을 떼는 순간의 클릭이 바로 배경에 떨어져 닫혔다(에뮬레이션 실측 2026-09-29) — 열린 직후 잠깐은 배경 누름을 무시
  const hold = useLongPress(() => { if (!m.pending) { openedAt.current = Date.now(); setActsOpen(true); } });
  // 키보드(검수 K8): 메시지 목록은 로빙 tabindex — 목록 전체가 Tab 한 칸, ↑↓·Home·End로 행 이동, Enter·Shift+F10·메뉴 키로 동작 메뉴(우클릭과 같은 .ctx), 메뉴 안 ↑↓, Esc면 행으로
  const rowRef = useRef(null); const kbCtx = useRef(false);
  const rowKey = (e) => {
    if (e.target !== e.currentTarget) return;
    const rows = () => [...(e.currentTarget.closest('.msgr-thread')?.querySelectorAll('[data-mid][tabindex]') ?? [])];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const list = rows(); list[list.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); const list = rows(); (e.key === 'Home' ? list[0] : list.at(-1))?.focus(); return; }
    if ((e.key === 'Enter' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && !m.pending && !ap && !m.deleted_at && !editing) {
      e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); kbCtx.current = true; setCtxMore(false); setCtxAt({ x: r.left + 48, y: r.top + 20 }); setActsOpen(true);
    }
  };
  const menuKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setActsOpen(false); rowRef.current?.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const bs = [...e.currentTarget.querySelectorAll('button')]; const i = bs.indexOf(document.activeElement); bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus(); }
  };
  // 메뉴(.ctx)는 body 포털 — 행의 애니메이션 transform이 fixed 기준을 행으로 바꿔 우클릭·키보드 메뉴가 행 폭만큼(약 500px) 오른쪽에 떴다(K8 검증 중 실측, main도 같음)
  const ctxRef = useRef(null); // 아이콘 줄 버튼은 탭 순서 밖(tabIndex -1) — 메시지마다 서너 칸이라 입력창까지 Tab 76번(검수 D11). 키보드는 Enter·Shift+F10 메뉴로 닿는다
  useEffect(() => { if (actsOpen && ctxAt && kbCtx.current) { kbCtx.current = false; ctxRef.current?.querySelector('button')?.focus(); } }, [actsOpen, ctxAt]);
  // 현재 행이 아닌 행의 안쪽 컨트롤(아바타·이름·반응 칩·링크·파일)도 탭 순서 밖 — 현재 행에서만 Tab으로 들어간다. 아이콘 줄은 늘 탭 순서 밖이다
  useEffect(() => {
    const el = rowRef.current; if (!el) return;
    for (const x of el.querySelectorAll('a[href], button, input, textarea, select')) {
      if (x.closest('.msgr-acts')) continue;
      if (rowTab === 0) { if (x.dataset.rove) { x.removeAttribute('tabindex'); delete x.dataset.rove; } }
      else if (!x.hasAttribute('tabindex') || x.dataset.rove) { x.setAttribute('tabindex', '-1'); x.dataset.rove = '1'; }
    }
  }, [rowTab, atts.length, reacts.length, m.body, editing, parent]);
  const phone = useIsPhone(); // 폰: 길게 누르면 슬랙식 아래 시트(빠른 반응 줄 + 동작 목록)
  // 밀어서 답장(유건 승인 2026-09-29) — 왼쪽으로 60px 넘게 밀고 놓으면 답장. 오른쪽은 뒤로가기 몫이라 받지 않는다
  const replyLive = useRef(null); replyLive.current = () => onReply?.(m);
  const canSwipeReply = !readOnly && phone && !!onReply && !m.pending && !m.deleted_at;
  useEffect(() => { const el = rowRef.current; if (!canSwipeReply || !el || el.classList.contains('msgr-sys')) return undefined; return bindSwipeReply(el, () => replyLive.current?.()); }, [canSwipeReply]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!actsOpen) return undefined;
    const off = (e) => { if (!e.target.closest?.('.msgr-acts, .msgr-actsheet, .msgr-emojipop')) setActsOpen(false); }; // 폰 시트는 body 포털이라 행 밖 — 안에서 누른 건 바깥이 아니다
    document.addEventListener('pointerdown', off, true);
    return () => document.removeEventListener('pointerdown', off, true);
  }, [actsOpen]);
  const groups = Object.entries(reacts.reduce((acc, r) => { (acc[r.emoji] ??= []).push(r.user_id); return acc; }, {}));
  const chips = groups.length > 0 && <div className="msgr-reacts">{groups.map(([e, users]) => <button key={e} type="button" className={users.includes(uid) ? 'on' : ''} onClick={() => onReact?.(m, e)} title={users.map((u) => nameOfUser(u)).join(', ')}>{e}<span>{users.length}</span></button>)}</div>;
  const react = (e) => { bumpEmoji(e); onReact?.(m, e); };
  const picker = pick && <EmojiPicker t={t} anchor={pick} onPick={(e) => { setPick(false); react(e); }} onClose={() => setPick(false)} />; // 자주 쓰는 것은 hover가 아니라 피커 상단 한 줄(유건 지시 2026-09-09)
  const edited = m.edited_at && !m.deleted_at && <span className="msgr-klabel">{t('msg.edited')}</span>;
  const crew = m.crew_id ? crewOf(m.crew_id) : null;
  const name = m.author_kind === 'user' ? nameOfUser(m.author_user_id) : (crew?.display_name ?? t('org.crew'));
  const body = m.deleted_at ? '' : m.body;
  const { note: awayNote, text: shown } = splitAwayNote(body); // 게이트웨이가 첫 줄에 붙인 부재중 안내 — 크루 답에선 작은 머리줄, 전달본에선 숨김
  const deliveryRecipients = !m.deleted_at && (m.mentions ?? []).filter((r) => r.kind === 'crew' && ['to', 'cc'].includes(r.role));
  const deliveryLabels = deliveryRecipients?.length > 0 && <div className="msgr-message-recipients">{deliveryRecipients.map((r) => <span key={r.id}>{t(`dm.delivery.${r.role}`)} · {crewOf(r.id)?.display_name || t('org.crew')}</span>)}</div>;
  // 전달(relay) — 이 글이 다른 1:1에서 넘어온 지시면 출처 캡션(원래 방이 내 목록에 있을 때만 클릭 가능). role(수신/참조) 라벨은 위 deliveryLabels가 이미 mentions에서 그린다.
  const relay = !m.deleted_at && m.meta?.relay;
  // 넘김 한도에 걸려 멘션을 뺀 봇 답(서버 msgr_bot_finish가 meta에 남김) — 왜 아무도 이어받지 않는지 답 위에 한 줄(유건 2026-09-29, 페퍼 - v 9명 공지)
  const handoffNote = !m.deleted_at && Number.isInteger(m.meta?.handoff_dropped) && m.meta.handoff_dropped > 0 && // 크루 소유자가 자기 크루 글 meta를 직접 쓸 수 있다 — 양의 정수만(검수 LOW-6)
    <div className="msgr-message-recipients">{t(m.meta.handoff_reason === 'hop' ? 'msg.handoffDropped.hop' : 'msg.handoffDropped.mentions', { n: m.meta.handoff_dropped })}</div>;
  // 첨부만 보낸 내 글 — 본문·인용·수신 표시가 모두 없으면 빈 말풍선을 그리지 않는다(첨부 줄만). 빈 검은 알약이 이미지 위에 떴다(D21)
  const bareAttach = shape === 'files'; // 판정은 attach-only.mjs messageShape(본문·인용·전달·수신 표시가 없고 첨부가 붙은 글)
  const uploadingPill = shape === 'uploading' && <div className="msgr-uploading" role="status"><span className="msgr-spin sm" aria-hidden="true" />{uploadNames?.length ? t('att.placeholder.names', { names: uploadNames.join(', ') }) : t('att.placeholder')}</div>; // 올리는 동안 빈 말풍선 대신(MSG-06)
  const relayChannel = relay && channels.find((c) => c.id === relay.channel_id); // 원래 방 — 내가 항상 그 방 멤버라 목록에 있으면 표시 이름을 안다
  const relayCapKey = relay && relayCaptionKey(relay, relayChannel && dmName?.(relayChannel));
  const relayCapText = relay && t(relayCapKey.key, relayCapKey.vars);
  const relayCap = relay && (
    <div className="msgr-quote"><I name="reply" size={13} />
      {relayChannel
        ? <button type="button" className="q msgr-namebtn" onClick={() => onOpenRelay?.(null, relay.channel_id)}>{relayCapText}</button>
        : <span className="q">{relayCapText}</span>}
    </div>
  );
  // 전달 안내(system) — 원래 방에 남는 "누구에게 전달했다" 알림. 각 대상은 그 1:1로 바로 이동하는 버튼.
  // meta.relay_to는 같은 방 멤버가 임의로 넣을 수 있는 값이라 배열이 아닐 수 있다 — .map 크래시 방지(검수 MEDIUM).
  const relayTo = m.kind === 'system' && Array.isArray(m.meta?.relay_to) && m.meta.relay_to.length > 0 ? m.meta.relay_to : null;
  const relayCapped = m.kind === 'system' && !relayTo && m.meta?.relay_capped;
  const sysBody = m.kind === 'system' && (relayTo && relayNoticeView(m, uid).audience === 'other' ? (
    <div className="msgr-sys msgr-relay"><span>{t('dm.relay.to.other', { who: nameOfUser(m.author_user_id), names: relayToNames(relayTo, t('dm.delivery.cc')) })}</span></div>
  ) : relayTo ? (
    <div className="msgr-sys msgr-relay">
      <span>{t('dm.relay.to', { names: relayToNames(relayTo, t('dm.delivery.cc')) })}</span>
      <div className="msgr-chips">{relayTo.map((e) => <button key={`${e.crew_id}:${e.role}`} type="button" className="msgr-chan" onClick={() => onOpenRelay?.(e.crew_id, e.channel_id)}><span>{t('dm.relay.open', { name: relayToLabel(e, t('dm.delivery.cc')) })}</span></button>)}</div>
    </div>
  ) : relayCapped ? <div className="msgr-sys">{t(m.meta?.relay_cycle ? 'dm.relay.cycle' : 'dm.relay.capped')}</div>
  : <div className="msgr-sys">{body}</div>);
  const copyText = (text) => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const copy = () => copyText(body); // 이 글 하나(폰 시트·우클릭 메뉴)
  const turnText = turn ? turnCopyText(turn) : ''; // 턴 마지막 글만 받는다 — 본문이 하나도 없으면 복사 버튼만 뺀다
  const report = async () => {
    setSafetyBusy(true);
    try {
      await q(supabase.rpc('msgr_report_message', { msg: m.id, reason: reportReason.trim() || null }));
      setReporting(false); setReportReason(''); safety.onNote(t('report.done'));
    } catch (e) {
      onError?.(/msgr_report_own/.test(e.message) ? t('report.err.own') : t('report.failed'));
    } finally { setSafetyBusy(false); }
  };
  const block = async () => {
    setSafetyBusy(true);
    try { await safety.block(m.author_user_id); setConfirmBlock(false); } catch { onError?.(t('friends.block.failed')); } finally { setSafetyBusy(false); }
  };
  const muteCrewAct = async () => { setSafetyBusy(true); try { await safety.muteCrew(m.crew_id); } catch { onError?.(t('crew.mute.failed')); } finally { setSafetyBusy(false); } }; // 크루·봇 숨기기(App Store 1.2) — 확인 모달 없이 바로(설정에서 언제든 되돌릴 수 있다)
  const mine = m.author_kind === 'user' && m.author_user_id === uid;
  const canReport = canReportMessage(m, uid); // 사람 글과 에이전트 명의 글(kind 무관) — 진짜 시스템 글만 제외(유건 결정 2026-10-06, 서버 msgr_report_message)
  const canBlock = !mine && !m.pending && m.author_kind === 'user' && !!m.author_user_id && !!safety.block;
  const canMuteCrew = !mine && !m.pending && m.author_kind === 'crew' && !!m.crew_id && !!safety.muteCrew && !safety.mutedCrewIds.has(m.crew_id) && crew?.owner_user_id !== uid; // 검수 L5: 내 크루는 숨길 수 없다
  const hasMore = canReport || canBlock || canMuteCrew || mine; // ⋯ 메뉴에 담을 나머지(신고·차단·숨기기·편집·삭제)가 있을 때만
  const parentBlockedUser = parent?.author_kind === 'user' && parent.author_user_id !== uid && safety.blocked.has(parent.author_user_id);
  const parentMutedCrew = parent?.author_kind === 'crew' && safety.mutedCrewIds.has(parent.crew_id);
  const quote = parent && <div className="msgr-quote"><I name="reply" size={13} /><span className="q">{parentBlockedUser ? t('msg.blockedUser') : parentMutedCrew ? t('msg.mutedCrew') : <>{parent.author_kind === 'user' ? nameOfUser(parent.author_user_id) : crewOf(parent.crew_id)?.display_name}: {plainPreview(parent.body, 300)}</>}</span></div>; // 긴 원문은 한 줄 말줄임(QA: 카드 밖으로 잘림)
  const attRow = atts.length > 0 && <MediaAttachments atts={atts} onError={onError} rowTab={rowTab} mine={mine} />; // 사람·에이전트 첨부 같은 말풍선(사진 묶음·파일)
  const linkCard = !m.deleted_at && m.kind !== 'system' && <LinkCard m={m} tab={rowTab === 0 ? undefined : -1} />; // 보낼 때 한 번 저장한 미리보기만 그린다
  const bareOther = shape === 'files'; // 상대·에이전트가 파일만 보낸 글 — 빈 말풍선 대신 첨부 줄만(내 글과 같은 판정, attach-only.mjs)
  // 턴 끝 동작 줄(유건 2026-10-02) — 턴(같은 사람이 이어 보낸 묶음)의 마지막 글 아래에 복사·답글·반응·더보기 아이콘 한 줄, 폰·데스크톱 같고 늘 보인다.
  // 이 줄은 턴의 마지막 글(turn을 받은 이 Message)이 그린다 — 복사는 턴 전체, 답글·반응·더보기는 이 글(m). 턴 중간 글은 우클릭(데스크톱)·길게 누르기(폰).
  // 더보기: 데스크톱은 나머지 동작 메뉴(신고·차단·숨기기·편집·삭제), 폰은 길게 누르기와 같은 시트. 보내는 중인 글은 자리는 두고 누를 수만 없게(서버 행으로 바뀔 때 아이콘이 밀리지 않게)
  const barTab = rowTab === 0 ? undefined : -1;
  // readOnly = 보관한 방(이전 대화 보기, 유건 결정 2026-10-08 1-②) — 복사(읽기 동작)만 남기고 답글·반응·더보기(편집·삭제·신고)와 길게 누르기 시트는 없다
  const turnActs = (!readOnly || turnText) && turn && !editing && !ap && !m.deleted_at && m.kind !== 'system' && (<div className="msgr-turnacts" role="toolbar" aria-label={t('msg.actions')}>
    {turnText && <button type="button" data-act="copy" tabIndex={barTab} onClick={() => copyText(turnText)} title={copied ? t('ui.copied') : t('msg.copyTurn')} aria-label={copied ? t('ui.copied') : t('msg.copyTurn')}><I name={copied ? 'check' : 'copy'} size={16} /></button>}
    {!readOnly && onReply && <button type="button" data-act="reply" tabIndex={barTab} disabled={m.pending} onClick={() => onReply(m)} title={t('msg.reply')} aria-label={t('msg.reply')}><I name="reply" size={16} /></button>}
    {!readOnly && <button type="button" data-act="react" tabIndex={barTab} disabled={m.pending} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick((v) => (v ? false : { left: r.left, right: r.right, top: r.top, bottom: r.bottom })); }} aria-expanded={!!pick} title={t('msg.react')} aria-label={t('msg.react')}><I name="react" size={16} /></button>}
    {!readOnly && (phone || hasMore) && <button type="button" data-act="more" tabIndex={barTab} disabled={m.pending} aria-haspopup={phone ? 'dialog' : 'menu'} aria-expanded={!!(actsOpen && (phone || ctxMore))} onClick={(e) => { if (phone) { openedAt.current = Date.now(); setActsOpen(true); return; } const r = e.currentTarget.getBoundingClientRect(); setCtxMore(true); setCtxAt({ x: r.left, y: r.bottom + 4 }); setActsOpen(true); }} title={t('msg.more')} aria-label={t('msg.more')}><I name="dots" size={16} /></button>}
  </div>);
  const acts = !readOnly && !ap && !m.deleted_at && !editing && ( // 보내는 중에도 자리는 그린다(숨김·inert) — 서버 행으로 바뀔 때 행 높이가 36px 늘며 밀리지 않게
    phone && actsOpen ? createPortal( // body 포털 — 행의 animation(transform)이 fixed 기준점을 바꿔 시트가 글 안에 그려졌다(실측 2026-09-11)
      <div className="msgr-actsheetwrap" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && Date.now() - openedAt.current > 450) setActsOpen(false); }}>{/* 슬랙 참고(유건 2026-09-11): 빠른 반응 줄 → 타일 → 목록. 있는 기능만 싣는다 */}
        <div className="msgr-actsheet" role="dialog" onClick={(e) => e.stopPropagation()}>
          <div className="grab" />
          <div className="quick">
            {topEmoji(5).map((e) => <button key={e} type="button" onClick={() => { react(e); setActsOpen(false); }}>{e}</button>)}
            <button type="button" className="more" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }); setActsOpen(false); }} aria-label={t('msg.react')}><I name="plus" size={18} /></button>
          </div>
          <div className="tiles">
            {onReply && !m.pending && <button type="button" onClick={() => { onReply(m); setActsOpen(false); }}><I name="reply" size={20} /><span>{t('msg.reply')}</span></button>}
            <button type="button" onClick={() => { copy(); setActsOpen(false); }}><I name="copy" size={20} /><span>{copied ? t('ui.copied') : t('ui.copy')}</span></button>
            {canReport && <button type="button" onClick={() => { setActsOpen(false); setReporting(true); }}><I name="flag" size={20} /><span>{t('report.action')}</span></button>}
            {canBlock && <button type="button" onClick={() => { setActsOpen(false); setConfirmBlock(true); }}><I name="block" size={20} /><span>{t('report.block')}</span></button>}
            {canMuteCrew && <button type="button" onClick={() => { setActsOpen(false); setConfirmMute(true); }}><I name="block" size={20} /><span>{t('crew.mute')}</span></button>}
            {mine && m.kind === 'text' && <button type="button" onClick={() => { setDraft(m.body); setEditing(true); setActsOpen(false); }}><I name="gear" size={20} /><span>{t('ui.edit')}</span></button>}
          </div>
          {mine && (confirmDel
            ? <button type="button" className="row danger" onClick={() => { setConfirmDel(false); setActsOpen(false); onDelete?.(m); }}><I name="trash" size={16} />{t('msg.delete.confirm')}</button>
            : <button type="button" className="row danger" onClick={() => setConfirmDel(true)}><I name="trash" size={16} />{t('ui.delete')}</button>)}
        </div>
      </div>, document.body,
    ) : !phone && (<>
      {ctxAt && actsOpen && createPortal(
        <div ref={ctxRef} className="msgr-acts ctx" onKeyDown={menuKey} role="menu" style={{ left: Math.max(4, Math.min(ctxAt.x, window.innerWidth - 200)), top: Math.max(4, Math.min(ctxAt.y, window.innerHeight - 220)) }}>
          {!ctxMore && onReply && !m.pending && <button type="button" onClick={() => { setActsOpen(false); onReply(m); }}><I name="reply" size={12} />{t('msg.reply')}</button>}
          {!ctxMore && <button type="button" onClick={copy}><I name="copy" size={12} />{copied ? t('ui.copied') : t('ui.copy')}</button>}
          {canReport && <button type="button" onClick={() => { setActsOpen(false); setReporting(true); }}><I name="flag" size={12} />{t('report.action')}</button>}
          {canBlock && <button type="button" onClick={() => { setActsOpen(false); setConfirmBlock(true); }}><I name="block" size={12} />{t('report.block')}</button>}
          {canMuteCrew && <button type="button" onClick={() => { setActsOpen(false); muteCrewAct(); }}><I name="block" size={12} />{t('crew.mute')}</button>}
          {!ctxMore && <button type="button" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick((v) => (v ? false : { left: r.left, right: r.right, top: r.top, bottom: r.bottom })); }} aria-expanded={!!pick}><I name="react" size={12} />{t('msg.react')}</button>}
          {mine && m.kind === 'text' && <button type="button" onClick={() => { setActsOpen(false); setDraft(m.body); setEditing(true); }}><I name="gear" size={12} />{t('ui.edit')}</button>}
          {mine && (confirmDel ? <button type="button" className="danger" onClick={() => { setConfirmDel(false); setActsOpen(false); onDelete?.(m); }}><I name="trash" size={12} />{t('msg.delete.confirm')}</button> : <button type="button" onClick={() => setConfirmDel(true)}><I name="trash" size={12} />{t('ui.delete')}</button>)}
        </div>, document.body)}
    </>)
  );
  const editor = editing && (
    <form className="msgr-editbox" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) onEdit?.(m, draft.trim()); setEditing(false); }}>
      <textarea className="msgr-input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} autoFocus onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }} />
      <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!draft.trim()}>{t('ui.save')}</button><button type="button" className="btn sm" onClick={() => setEditing(false)}>{t('ui.cancel')}</button></div>
    </form>
  );
  const reportModal = (reporting || confirmBlock || confirmMute) && createPortal(<div className="shell" style={{ display: 'contents' }} role="dialog" aria-modal="true" aria-label={t(reporting ? 'report.title' : confirmMute ? 'fm.hideAgent.title' : 'report.block')} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>{/* 포털이어도 React 이벤트는 행으로 올라간다 — 입력칸 길게 누르기가 동작 시트를 열던 것(검수 M5) */}
    {reporting
      ? <ConfirmModal tone="primary" title={t('report.title')} confirmLabel={t('report.action')} busy={safetyBusy} onConfirm={report} onClose={() => { if (!safetyBusy) { setReporting(false); setReportReason(''); } }}
          description={<>{t(isPersonal ? 'report.desc.personal' : 'report.desc')}{/* 불러온 글은 org_id를 싣지 않는다(검수 N1) — 채널 문맥으로 가른다 */}<textarea className="msgr-input" rows={3} maxLength={500} value={reportReason} onChange={(e) => setReportReason(e.target.value)} placeholder={t('report.reason.ph')} aria-label={t('report.reason.ph')} style={{ display: 'block', width: '100%', marginTop: 10, boxSizing: 'border-box', padding: '8px 10px', font: 'inherit', fontSize: 16, resize: 'vertical' }} /></>} />
      : confirmMute ? <ConfirmModal tone="primary" title={t('fm.hideAgent.title')} description={t('fm.hideAgent.note')} confirmLabel={t('fm.hide')} busy={safetyBusy} onConfirm={async () => { await muteCrewAct(); setConfirmMute(false); }} onClose={() => { if (!safetyBusy) setConfirmMute(false); }} />
      : <ConfirmModal title={t('report.block')} description={t('friends.block.confirm', { name: nameOfUser(m.author_user_id) })} confirmLabel={t('report.block')} busy={safetyBusy} onConfirm={block} onClose={() => { if (!safetyBusy) setConfirmBlock(false); }} />}
  </div>, document.body);
  if (!mine && m.author_kind === 'user' && safety.blocked.has(m.author_user_id)) return <div className="msgr-sys" ref={rowRef} data-mid={m.id} tabIndex={rowTab} onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus?.(m.id); }} onKeyDown={(e) => { if (e.key !== 'Enter' && e.key !== 'ContextMenu') rowKey(e); }}>{t('msg.blockedUser')}</div>; // 차단한 사람의 글 — 본문·첨부·반응을 그리지 않는다
  if (!mine && !ap && m.author_kind === 'crew' && safety.mutedCrewIds.has(m.crew_id)) return <div className="msgr-sys" ref={rowRef} data-mid={m.id} tabIndex={rowTab} onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus?.(m.id); }} onKeyDown={(e) => { if (e.key !== 'Enter' && e.key !== 'ContextMenu') rowKey(e); }}>{t('msg.mutedCrew')}</div>; // 숨긴 크루·봇의 글(App Store 1.2, 2026-09-26) — 본문·첨부·반응을 그리지 않는다. 결재 카드(ap)는 예외(검수 L5 — 숨겨도 나에게 온 결재는 항상 보여야 한다)
  if (mine) return ( // 내 글 — 척추 반대편 차콜 버블(20/6/20/20)
    <div className={`msgr-mine${cont ? ' cont' : ''}${tail ? '' : ' notail'}`} ref={rowRef} tabIndex={m.pending ? undefined : rowTab} onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus?.(m.id); }} onKeyDown={rowKey} data-mid={m.id} data-acts={actsOpen ? 'open' : undefined} {...hold} onContextMenu={(e) => { if (phone || m.pending || ap || m.deleted_at || editing || e.target.closest?.('a, input, textarea')) return; e.preventDefault(); setCtxMore(false); setCtxAt({ x: e.clientX, y: e.clientY }); setActsOpen(true); }}>
      {editing ? editor : bareAttach ? null : uploadingPill || <div className="bubble" onClick={onLinkClick}>{quote}{relayCap}{deliveryLabels}{m.deleted_at ? <i>{t('msg.deleted')}</i> : m.kind === 'system' ? sysBody : relay ? <Markdown text={shown} /> : <Body text={body} />}</div>}
      {attRow}
      {linkCard}
      {chips}
      <div className="meta">{edited}<span className={m.pending ? 'sent pending' : 'sent'} title={m.pending ? t('msg.sending') : undefined} aria-label={m.pending ? t('msg.sending') : undefined}><I name={m.pending ? 'clock' : 'check'} size={12} /></span><span className="mono">{fmtTs(m.created_at, lang)}</span></div>
      {turnActs}
      {acts}
      {picker}
      {reportModal}
    </div>
  );
  const isCrew = m.author_kind === 'crew';
  return ( // 동료·크루 글 — 척추 위 아바타(사람 원 / 크루 타일), 크루 답은 척추에 붙는 시트
    <div className={`msgr-row${cont ? ' cont' : ''}${tail ? '' : ' notail'}`} ref={rowRef} tabIndex={m.pending ? undefined : rowTab} onFocus={(e) => { if (e.target === e.currentTarget) onRowFocus?.(m.id); }} onKeyDown={rowKey} data-mid={m.id} data-acts={actsOpen ? 'open' : undefined} {...hold} onContextMenu={(e) => { if (phone || m.pending || ap || m.deleted_at || editing || e.target.closest?.('a, input, textarea')) return; e.preventDefault(); setCtxMore(false); setCtxAt({ x: e.clientX, y: e.clientY }); setActsOpen(true); }}>
      {isCrew && crew && onCrew ? <button type="button" className="msgr-avbtn" onClick={() => onCrew(crew.id)} title={t('crew.sheet')}><Av name={name} crew crewId={crew.id} /></button> : <Av name={name} crew={isCrew} crewId={isCrew ? m.crew_id : null} userId={isCrew ? null : m.author_user_id} />}
      <div className="msgr-col">{/* 간격 표(--msg-gap-in)를 쓰는 세로 칸 — 이름 줄·글·사진·파일·링크 카드 사이 같은 간격 */}
        <div className="who">{isCrew && crew && onCrew ? <button type="button" className="msgr-namebtn" onClick={() => onCrew(crew.id)}>{name}</button> : name}{edited}{crew?.role_text && !inDm && <span className="role">{crew.role_text} · {t('org.crew')}</span>}<span className="ts">{fmtTs(m.created_at, lang)}</span></div>
        {m.deleted_at ? <div className="msgr-sys">{t('msg.deleted')}</div>
          : ap ? <Slip ap={ap} uid={uid} lang={lang} t={t} crew={crew} nameOfUser={nameOfUser} decide={decide} isAdmin={isAdmin} policy={policy} />
          : m.kind === 'system' ? sysBody
          : bareOther ? null
          : uploadingPill ? uploadingPill
          : isCrew ? <div className="msgr-sheet" onClick={onLinkClick}>{quote}{relayCap}{deliveryLabels}{handoffNote}{awayNote && <div className="msgr-away">{awayNote}</div>}<FilteredBody text={shown} on={safety.profanityFilterOn} t={t}><Markdown text={shown} /></FilteredBody></div>
          : <div className="text" onClick={onLinkClick}>{quote}{relayCap}{deliveryLabels}<FilteredBody text={relay ? shown : body} on={safety.profanityFilterOn} t={t}>{relay ? <Markdown text={shown} /> : <Body text={body} />}</FilteredBody></div>}
        {attRow}
        {linkCard}
        {chips}
        {turnActs}
        {acts}
        {picker}
        {reportModal}
      </div>
    </div>
  );
}

/** 실행 표시 — 크루가 일하는 동안 "답변 준비 중" 한 줄만(유건 결정 2026-09-24: 메신저에는 사고 과정·도구 단계·작성 중 본문을 보이지 않는다).
    canStop이면 그 옆에 중단 버튼(유건 확정 2026-09-26) — 시킨 사람 또는 크루 주인에게만, 서버가 권한을 다시 검사한다.
    상태 3단: 평소(중단) → 누르는 동안(중단 중…, disabled) → 서버가 받아준 뒤(중단 요청됨, disabled — 이 카드가 사라질 때까지 고정, 분리 검수 L-3). */
function ExecCard({ crew, t, canStop = false, stopping = false, stopRequested = false, onStop, wait = false, label: stateLabel = null, long = false }) {
  const label = stopRequested ? t('exec.stopRequested') : stopping ? t('exec.stopping') : t('exec.stop');
  // wait = 보낸 뒤 대기 표시(await-reply.mjs) — 점 대신 회전 표시, 단계 문구는 화면 낭독기에 알린다. long = 긴 안내(조금 오래·꺼짐)는 줄바꿈 허용(폰 폭)
  return (
    <div className={`msgr-row${wait ? " msgr-await-row" : ""}`}>
      <Av name={crew.display_name} crew crewId={crew.id} />
      <div style={{ minWidth: 0 }}>
        <div className="who">{crew.display_name}<span className="role">{crew.role_text}</span></div>
        <div className={`msgr-exec${wait ? ' wait' : ''}`} {...(wait ? { role: 'status', 'aria-live': 'polite' } : {})}><div className="summary">{wait ? <span className="msgr-spin" aria-hidden="true" /> : <span className="msgr-dot mark pulse" />}<span className={`st${long ? ' long' : ''}`}>{stateLabel ?? t('exec.preparing')}</span>
          {canStop && <button type="button" className={`btn sm ghost msgr-stop-btn${stopRequested ? ' requested' : ''}`} disabled={stopping || stopRequested} onClick={onStop} aria-label={label}>{label}</button>}
        </div></div>
      </div>
    </div>
  );
}

/** 결재 슬립 — 머리띠(요청=옐로 / 확정=차콜 / 만료=회색) + 본문 + 도장 실. 보는 사람이 소유자면 버튼, 아니면 대기 표시. */
function Slip({ ap, uid, lang, t, crew, nameOfUser, decide, isAdmin, policy }) {
  // 누르는 즉시 두 단추를 끄고 진행 표시(MSG-07 — 서버 왕복 동안 변화가 없어 한 번 더 누르면 이미 처리된 결재에 권한 오류가 떴다). 끝나면 카드가 결과로 바뀐다
  const live = useRef(null); live.current = { decide, ap };
  const [busy, setBusy] = useState(null);
  const run = useMemo(() => singleFlight(async (status) => { setBusy(status); try { await live.current.decide(live.current.ap, status); } finally { setBusy(null); } }), []);
  // 결재권 판정은 화면용 — 최종은 RLS(msgr_can_decide, decide의 0행 처리). 크루가 목록에 없으면(비활성 등) 소유자 미상으로 보고 버튼을 띄운다(검수 M1).
  // H-1: 고위험은 정책의 결재권자(기본 관리자). J-1: 'approvers'면 지정 결재권자도. 판정은 폰 결재 페이지와 같은 함수(approval-display.js approvalDecider)
  const { can, byAdmin, mode, high } = approvalDecider({ ap, uid, crewOwnerId: crew ? crew.owner_user_id : undefined, isAdmin, policy });
  const ownerName = nameOfUser(crew?.owner_user_id);
  const cls = `msgr-slip ${ap.status}${ap.status === 'pending' && !can ? ' wait' : ''}${high ? ' high' : ''}`;
  const band = ap.status === 'pending' ? (can ? t('ap.request') : (byAdmin ? t('ap.wait.admin') : t('ap.wait', { name: ownerName }))) : t(`ap.${ap.status}.band`);
  const bandIcon = ap.status === 'expired' ? 'clock' : 'stamp';
  const when = ap.decided_at ? fmtTs(ap.decided_at, lang) : '';
  return (
    <div className={cls}>
      <div className="band"><I name={bandIcon} size={14} />{band}{high && <span className="msgr-klabel risk">{t('ap.level.must')}</span>}</div>{/* 내부 id(ap-…)는 사람에게 의미가 없다 — 보이지 않는다(점검 A·B #7) */}
      <div className="body">
        {/* 쉬운 문장화(유건 확정 2026-09-26) — 크루가 목적·할 일·필요한 것을 채웠으면 그 문장을 먼저 보이고
            원래 action/reason은 "명령 보기" 접힘으로(고위험이면 기본 펼침 — 분리 검수 M-1). 하나도 안 채웠으면(폴백)
            기존처럼 action/reason 그대로. approvalPlainFields가 문자열이 아닌 값(손상·조작 데이터)을 걸러낸다
            (분리 검수 M-2 — 안 걸러내면 React가 던져 채널 화면 전체가 죽는다). */}
        {(() => { const plain = approvalPlainFields(ap.payload); return plain ? (
          <>
            {plain.purpose && <div className="plain-line"><b>{t('ap.plain.purpose')}</b> {plain.purpose}</div>}
            {plain.task && <div className="plain-line task"><b>{t('ap.plain.task')}</b> {plain.task}</div>}
            {plain.need && <div className="plain-line"><b>{t('ap.plain.need')}</b> {plain.need}</div>}
            <details className="plain-raw" open={high}>
              <summary>{t('ap.plain.raw')}</summary>
              <div className="action">{ap.action}</div>
              {ap.reason && <div className="reason">{ap.reason}</div>}
            </details>
          </>
        ) : (
          <>
            <div className="action">{ap.action}</div>
            {ap.reason && <div className="reason">{ap.reason}</div>}
          </>
        ); })()}
        {ap.kind === 'org_doc' && ap.payload && (
          <div className="docprop">
            <div className="msgr-klabel">{t('ap.orgDoc')} · {ap.payload.scope === 'org' ? t('docs.scope.org') : t('docs.scope.channel')} · {ap.payload.path}</div>
            <div className="title">{orgDocTitle(ap.payload, ap.action)}</div>
            <div className="msgr-sheet"><Markdown text={String(ap.payload.body ?? '').slice(0, 1200)} />{String(ap.payload.body ?? '').length > 1200 && <p className="note">{t('ap.orgDoc.more')}</p>}</div>
            {ap.status === 'approved' && <p className="note">{t('ap.orgDoc.applied')}</p>}
          </div>
        )}
        <div className="row2">
          {ap.status === 'pending' && can && (<>
            <button type="button" className="btn btn-primary sm" disabled={!!busy} aria-busy={busy === 'approved' || undefined} onClick={() => run('approved')}>{busy === 'approved' ? <span className="msgr-spin sm" aria-hidden="true" /> : <I name="check" size={13} />}{t(busy === 'approved' ? 'ap.deciding' : 'ap.approve')}</button>
            <button type="button" className="btn sm" disabled={!!busy} aria-busy={busy === 'rejected' || undefined} onClick={() => run('rejected')}>{busy === 'rejected' ? <span className="msgr-spin sm" aria-hidden="true" /> : <I name="x" size={13} />}{t(busy === 'rejected' ? 'ap.deciding' : 'ap.reject')}</button>
          </>)}
          {ap.status === 'pending' && !can && <span className="note">{byAdmin ? (mode === 'approvers' ? t('ap.approverNote') : t('ap.adminNote')) : t('ap.ownerNote')}</span>}
          {ap.status === 'approved' && <span className="msgr-seal ok"><I name="check" />{nameOfUser(ap.decided_by)} · {when}</span>}
          {ap.status === 'rejected' && <span className="msgr-seal no"><I name="x" />{nameOfUser(ap.decided_by)} · {when}</span>}
          {ap.status === 'expired' && <span className="msgr-seal"><I name="clock" />{t('ap.noDecision')}</span>}
        </div>
      </div>
    </div>
  );
}
/* ─── 2단 다크 독: 입력 줄 + 도구 줄(첨부·멘션 │ 기억 상태) + 옐로 원형 전송. @멘션 팝업(사람·크루), Enter 전송(IME 조합 제외) ─── */
function Composer({ broadcast = null, onCrewJoined = null, outsideDmPersonal = null, chId, orgId, org, uid, members, crews, channel, scopePeople = null, scopeCrews = null, locked = false, sbw = 0, typingLabel = null, mentionReq, onMentionDone, replyReq = null, onReplyDone, onSent, onPending, onPendingSettled, onDiscarded = null, onError, isPersonal = false, onOutsideDm = null }) {
  const { t, lang } = useT();
  const phone = useIsPhone(); // 폰은 짧은 안내문(슬랙)
  const broadcastRef = useRef(broadcast); broadcastRef.current = broadcast; const discardedRef = useRef(onDiscarded); discardedRef.current = onDiscarded;
  const delivery = useMemo(() => bindComposerSession(JSON.stringify([SB_URL, uid, orgId, chId]), composerTransport(supabase, { orgId, chId, uid, personal: isPersonal, onDiscard: (id) => { broadcastRef.current?.('edit', { channel_id: chId, message_id: id }); discardedRef.current?.(id); } })), [uid, orgId, chId]); // 거둔 글 — 남에게는 edit 방송, 내 화면은 그 글을 다시 읽는다(방송은 나에게 오지 않는다, MSG-06)
  const { text, busy, files, mentions, recipients, uploading, job, replyTo } = useSyncExternalStore(delivery.subscribe, delivery.snapshot);
  useEffect(() => { if (!replyReq) return; delivery.setReplyTo(replyReq); onReplyDone?.(); ta.current?.focus(); }, [replyReq]); // eslint-disable-line react-hooks/exhaustive-deps
  const { setText, setFiles, setMentions, setRecipients } = delivery;
  const isDm = channel?.kind === 'dm';
  const [dmCandidates, setDmCandidates] = useState([]);
  const [recipientLoad, setRecipientLoad] = useState('loading');
  const [recipientRetry, setRecipientRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (!isDm) return undefined;
    setRecipientLoad('loading');
    q(supabase.rpc('msgr_dm_candidates', { p_channel: chId })).then((rows) => {
      if (!Array.isArray(rows)) throw new Error('Invalid DM recipient response');
      if (active) { setDmCandidates(withoutCopies(rows)); setRecipientLoad('ready'); }
    }).catch(() => { if (active) setRecipientLoad('error'); });
    return () => { active = false; };
  }, [isDm, chId, recipientRetry]);
  const roomCrews = useMemo(() => (isPersonal && scopeCrews ? scopeCrews.filter((c) => dmCandidates.some((p) => p.id === c.id)) : scopeCrews), [isPersonal, scopeCrews, dmCandidates]); // 개인 방: 방 안이어도 지시 못 하는 친구 에이전트는 부르지 않는다
  const mentionCrews = useMemo(() => isDm ? dmMentionCrews(roomCrews ?? [], isPersonal ? [] : dmCandidates) : roomCrews ?? crews, [isDm, isPersonal, roomCrews, crews, dmCandidates]);
  const allByName = useMemo(() => [...(roomCrews ?? crews).map((c) => ({ kind: 'crew', id: c.id, name: c.display_name })), ...(scopePeople ?? members).map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8) }))], [roomCrews, crews, scopePeople, members]);
  const [dragging, setDragging] = useState(false); // 파일을 끌어다 놓는 중 — 컴포저 테두리 강조
  const [pop, setPop] = useState(null); const [sel, setSel] = useState(0);
  const ta = useRef(null); const fileRef = useRef(null);
  const byName = useMemo(() => [...mentionCrews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name })), ...(scopePeople ?? members).map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8) }))], [mentionCrews, scopePeople, members]); // 이 채널에서 부를 수 있는 사람·크루(팝업 제외 목록·전송 대조 공용)
  const currentDeliveryMentions = dmDeliveryMentions(mentionsFromBody(text.trim(), byName, mentions, allByName), recipients);
  const unavailableRecipients = isDm ? dmUnavailableRecipients(currentDeliveryMentions, recipientLoad === 'ready' ? dmCandidates : [], (scopeCrews ?? []).map((c) => c.id)) : [];
  const deliveryBlocked = unavailableRecipients.length > 0;
  const dmRetryBlocked = isDm && job && !job.messageId && dmUnavailableRecipients(job.mentions, recipientLoad === 'ready' ? dmCandidates : [], (scopeCrews ?? []).map((c) => c.id)).length > 0;
  const retryBlocked = !!job?.permanent || dmRetryBlocked; // 영구 거절(RLS — D14)도 다시 보내기를 막는다. 아래 받는 사람 경고는 dmRetryBlocked일 때만
  const candidates = useMemo(() => {
    if (!pop) return [];
    const needle = pop.q.toLowerCase();
    const exclude = new Set(mentionsFromBody(text, byName, [], allByName).map((x) => `${x.kind}:${x.id}`)); if (ALL_RE.test(text)) exclude.add('all:all'); // 이미 본문에 있는 멘션은 목록에서 뺀다(유건 2026-09-12)
    const usable = (limitsPersonal(channel) ? crews.filter((c) => crewTier(c, org) === 'company') : crews).filter((c) => !(channel?.excluded_crew_ids ?? []).includes(c.id)); // 내보낸 크루는 후보에서 뺀다 // I-3: 이 채널이 회사 크루만이면 개인 크루는 멘션 후보에서 뺀다(안 될 버튼 노출 금지 — 최종 판정은 서버)
    return mentionCandidates({ q: needle, crews: mentionPopupCrews({ isDm, roomCrews, usable }), members: scopePeople ?? members, uid, exclude, all: !isDm || allByName.some((c) => c.kind === 'crew' || c.id !== uid) }).map((c) => (c.kind === 'all' ? { ...c, sub: t('mention.all') } : { ...c, away: c.kind === 'crew' && crewAway(crews.find((k) => k.id === c.id)), disabled: isDm && c.kind === 'crew' && !(scopeCrews ?? []).some((p) => p.id === c.id) && dmCandidates.find((p) => p.id === c.id)?.delivery_ready !== true })); // 사람 먼저·나 제외·상한 없음(팝업 스크롤). 맨 위 @all. 후보는 이 채널의 참여 구성만(사설 채널 밖 크루가 걸리던 실사고 2026-09-11)
  }, [pop, crews, members, uid, channel?.personal_crews, org, scopeCrews, scopePeople, text, byName, allByName, isDm, mentionCrews, dmCandidates, t]);
  const autosize = (el) => { if (!el) return; el.style.height = 'auto'; const h = Math.min(el.scrollHeight, 200); el.style.height = h ? `${h}px` : ''; }; // 높이를 못 재는 때(숨은 입력창)는 0px로 굳히지 않는다
  useLayoutEffect(() => { autosize(ta.current); }, [chId]); // 열릴 때 — 방을 옮겨 오거나 새로고침으로 되살린 여러 줄 초안이 2줄 높이로 잘려 보였다(MSG-09)
  // '/' 커맨더(유건 지시 2026-09-14) — 채널 크루가 미러한 본체 명령(별칭·스킬, msgr_crews.commands). 팝업이 열리는 순간 최신 목록을
  // 한 번 다시 읽는다(본체에서 스킬·별칭이 바뀜 → 게이트웨이 폴이 행 갱신 → 여기). 실행은 본체 몫이고 여기서는 지시문을 입력창에 넣는다.
  const slashCrews = scopeCrews ?? crews;
  const [freshCmds, setFreshCmds] = useState(null); // crewId → commands(팝업 열 때 재조회분)
  const slashOpen = /^\/(\S*)$/.test(text);
  useEffect(() => {
    if (!slashOpen) { setFreshCmds(null); return; }
    const ids = slashCrews.map((c) => c.id); if (!ids.length) return;
    let alive = true;
    supabase.from('msgr_crews').select('id, commands').in('id', ids).then(({ data }) => { if (alive && data) setFreshCmds(Object.fromEntries(data.map((r) => [r.id, r.commands]))); }).catch(() => {});
    return () => { alive = false; };
  }, [slashOpen, chId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 1:1 방 수신·참조 = 입력창 명령(유건 결정 2026-09-14: 별도 패널 대신 "/to·/cc 치면 목록"). 서버는 역할 없는 @멘션을 to로 보므로 /to는 @ 삽입,
  // /cc만 참조 칩(recipients)에 남긴다. 후보 = 서버가 준 msgr_dm_candidates(지원 여부 포함). 이미 고른 크루는 빼고, 이 방 상대는 /to에서만 뺀다(/cc는 "참고만"이 가능).
  // 채널에서도 연다(유건 2026-09-14: "메신저 기능인데 왜 1:1에서만") — /to = @멘션, /cc = 답하지 않는 멘션(브리지 targetsCrew·서버 클레임이 cc를 실행에서 뺀다).
  // 후보: 1:1 = 서버 전달 후보(지원 여부 게이트), 채널 = 이 채널에서 부를 수 있는 크루(@ 후보와 같은 규칙, 내보낸 크루 제외).
  const roleCands = useMemo(() => {
    if (isDm) return recipientLoad === 'ready' ? dmCandidates : [];
    const usable = (limitsPersonal(channel) ? crews.filter((c) => crewTier(c, org) === 'company') : crews).filter((c) => !(channel?.excluded_crew_ids ?? []).includes(c.id)); // @ 후보(candidates)와 같은 규칙
    return (scopeCrews ?? usable).map((c) => ({ ...c, delivery_ready: true }));
  }, [isDm, recipientLoad, dmCandidates, scopeCrews, crews, channel?.excluded_crew_ids, channel?.personal_crews, org]);
  const rolePick = useMemo(() => {
    const exclude = new Set([...mentionsFromBody(text, byName, [], allByName).map((x) => x.id), ...recipients.map((r) => r.id)]);
    return rolePickCandidates(text, roleCands, { exclude, participants: new Set(isDm ? (scopeCrews ?? []).map((c) => c.id) : []) });
  }, [isDm, text, scopeCrews, byName, allByName, recipients, roleCands]);
  const [slashOff, setSlashOff] = useState(null); // Esc로 닫은 그 글자에서는 '/' 목록을 다시 띄우지 않는다(D18 S95) — 글자가 바뀌면 다시
  useEffect(() => { if (slashOff !== null && text !== slashOff) setSlashOff(null); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const slashCands = useMemo(() => rolePick || text === slashOff ? null : slashCandidates(text, slashCrews.map((c) => ({ ...c, commands: freshCmds?.[c.id] ?? c.commands })), { skillPrefix: (title) => t('cmd.skillPrefix', { name: title }), builtins: [{ cmd: 'to', desc: t('cmd.to') }, { cmd: 'cc', desc: t('cmd.cc') }] }), [rolePick, text, slashOff, slashCrews, freshCmds, t]);
  const [slashSel, setSlashSel] = useState(0);
  useEffect(() => { setSlashSel(0); }, [text]);
  const pickSlash = (cand) => {
    const { text: next, mention } = slashInsert(cand, { isDm });
    setText(next); if (mention) setMentions((ms) => ms.some((x) => x.id === mention.id) ? ms : [...ms, mention]);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(next.length, next.length); autosize(ta.current); });
  };
  const rsel = (() => { const l = rolePick?.list ?? []; if (!l.length) return -1; const i = Math.min(sel, l.length - 1); return l[i].disabled ? l.findIndex((x) => !x.disabled) : i; })(); // 첫 행이 미지원이면 하이라이트를 첫 가능 행으로(검수 2R 신규-3)
  const pickRole = (c) => { // /to → @이름 삽입(= 수신), /cc → 참조 칩. 둘 다 전송이 아니다
    if (c.disabled) return;
    if (rolePick.role === 'cc') { setRecipients((rows) => setDmRecipient(rows, { id: c.id, display_name: c.name }, 'cc')); setText(''); }
    else { setText(`@${c.name} `); setMentions((ms) => ms.some((x) => x.id === c.id) ? ms : [...ms, { kind: 'crew', id: c.id, name: c.name }]); }
    requestAnimationFrame(() => { const el = ta.current; if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length); autosize(el); });
  };
  const detect = (v, caret) => { const upto = v.slice(0, caret); const m = ROLE_PICK_RE.test(v) ? null : upto.match(/(?:^|\s)@([^\s@]*)$/); setPop(m ? { q: m[1], start: upto.length - m[1].length - 1 } : null); setSel(0); }; // /to·/cc 중에는 @팝업을 열지 않는다(둘이 겹쳐 Enter가 죽던 것 — 검수 L-1). 역할 명령은 모든 방에서 열리므로 방 조건 없음(있으면 그 방의 @멘션이 죽는다 — 2R 실사고)
  const onChange = (e) => { const v = e.target.value; setText(v); autosize(e.target); detect(v, e.target.selectionStart); };
  const insertAt = () => { // 도구 줄 '멘션' — 커서 자리에 @를 넣고 팝업을 연다
    const el = ta.current; const pos = el?.selectionStart ?? text.length;
    const before = text.slice(0, pos); const sp = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${sp}@${text.slice(pos)}`; setText(next);
    requestAnimationFrame(() => { el?.focus(); const p = before.length + sp.length + 1; el?.setSelectionRange(p, p); autosize(el); detect(next, p); });
  };
  const pick = (c) => {
    if (c.disabled) return;
    const before = text.slice(0, pop.start); const after = text.slice(ta.current.selectionStart);
    const next = `${before}@${c.name} ${after}`;
    setText(next); setMentions((ms) => ms.some((x) => x.id === c.id) ? ms : [...ms, c]); setPop(null);
    requestAnimationFrame(() => { ta.current?.focus(); const p = before.length + c.name.length + 2; ta.current?.setSelectionRange(p, p); autosize(ta.current); });
  };
  const mentionCrew = (c) => { // 채널 시트 "@로 부르기" — 작성창 끝에 멘션을 넣는다(공개 채널은 이것이 '추가')
    const name = c.display_name ?? c.name; const base = text && !/\s$/.test(text) ? `${text} ` : text; const next = `${base}@${name} `;
    setText(next); setMentions((ms) => ms.some((x) => x.id === c.id) ? ms : [...ms, { kind: 'crew', id: c.id, name }]);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(next.length, next.length); autosize(ta.current); });
  };
  useEffect(() => { if (!mentionReq) return; mentionCrew(mentionReq); onMentionDone?.(); }, [mentionReq]); // eslint-disable-line react-hooks/exhaustive-deps
  const addFiles = (list) => { // 선택창·드래그앤드롭 공용 — 상한 초과는 이유를 알리고, 같은 파일은 한 번만, 기존 첨부에 누적(유건 제보 2026-09-11 밤)
    const incoming = [...(list ?? [])];
    const { rejected } = acceptFiles([], incoming, ATTACH_MAX);
    if (rejected.length) onError(rejected.map((f) => t('att.tooBig', { name: f.name })).join(' '));
    setFiles((cur) => acceptFiles(cur, incoming, ATTACH_MAX).files);
  };
  const send = async () => {
    if (locked || busy || deliveryBlocked || rolePick) return; // 명령(/to·/cc)만 있는 글은 보내지 않는다 — 폰은 전송 버튼이 유일한 경로(검수 M-1)
    // 실패 카드가 있으면 Enter가 그 글부터 다시 보낸다 — 순서를 지키고, 새 글은 성공한 뒤에 이어 보낸다(D50: 실패 카드가 전송을 통째로 막았다)
    if (job) { if (retryBlocked || !await delivery.retry()) return; onSent(delivery.snapshot().lastDeliveredId); if (!text.trim() && !files.length) return; }
    // 직접 친 "@이름"이 이 방에 같은 이름 둘 이상(대소문자 무시)이고 목록에서 고르지 않았으면 누구를 부르는지 모른다 — 아무도 고르지 않고 보내지 않는다(2026-10-05).
    // 재전송 뒤에 본다 — 앞에 두면 모호하지 않은 실패 글의 재전송까지 막혔다(검수 #send-feedback LOW)
    const twins = ambiguousMentions(text.trim(), byName.filter((x) => !(x.kind === 'user' && x.id === uid)), mentions);
    if (twins.length) { setAmbiguous(twins); haptic('medium'); return; }
    const inline = mentionsFromBody(text.trim(), byName, mentions, allByName);
    const awayNow = inline.filter((x) => x.kind === 'crew').map((x) => crews.find((c) => c.id === x.id)).filter((c) => c && crewAway(c)); // 꺼진 에이전트를 부른 글 — 보낸 뒤 알린다(D24)
    const outsideNow = outsideCrewMentions(text.trim(), [...byName, ...allByName], crews, uid); const sentBody = text.trim(); // 방 밖 에이전트 @이름 — 글은 평문으로 가고, 보낸 뒤 이유와 다음 행동을 알린다(D14)
    haptic('light'); // 보내기 = 가벼운 진동
    const result = delivery.send(dmDeliveryMentions(inline, recipients)); // 참조 칩은 방 종류와 무관하게 role cc로 합쳐진다
    // delivery.send는 왕복을 기다리기 전에 job을 먼저 세운다 — 그 clientId로 화면에 먼저 올린다.
    const posted = delivery.snapshot().job; // 이름을 job으로 두면 이 함수 첫 줄 가드의 바깥 job이 TDZ에 걸린다
    if (posted) onPending?.({ clientId: posted.clientId, body: posted.body, replyTo: posted.replyTo, at: new Date().toISOString(), files: posted.files.map((item) => item.file.name) }); // 파일 이름 — 올리는 동안 대화에 자리표시(MSG-06)
    setPop(null); if (ta.current) ta.current.style.height = 'auto';
    const ok = await result;
    if (posted) onPendingSettled?.(posted.clientId, ok); // 실패하면 자리를 비우고 실패 카드가 재시도를 맡는다
    if (ok) { onSent(delivery.snapshot().lastDeliveredId); setAwayNote(awayNow.length ? awayNow : null); setOutside(outsideNow.length ? { crews: outsideNow, body: sentBody, done: {} } : null); }
  };
  // 방 밖 에이전트 안내(D14) — 시킬 수 있으면 [1:1로 시키기](위임 DM에 본문을 옮겨 연다), 내 에이전트면 [이 방에 추가 요청](방장 승인 경로), 아니면 이유만
  const [outside, setOutside] = useState(null);
  useEffect(() => { setOutside(null); }, [chId]);
  const requestAdd = async (c) => {
    const mark = (done) => setOutside((o) => o && { ...o, done: { ...o.done, [c.id]: done } });
    mark('pending'); // 응답 전 버튼을 숨긴다 — 두 번 누르면 늦게 온 already가 방금 넣은 줄을 덮었다(검수 #826 LOW-6)
    const r = await supabase.rpc('msgr_crew_join', { ch: chId, crew: c.id });
    if (r.error) { mark(undefined); return onError?.(joinErr(r.error.message, t)); }
    const done = outsideAddDone(r.data);
    if (done !== 'requested') onCrewJoined?.(); // 방 구성원을 다시 읽는다 — 안 읽으면 다시 불러도 후보에 없어 '없어요'만 반복됐다(0.1.49 실기기 "반응 없음")
    mark(done);
  };
  // 꺼진 에이전트 안내(D24) — 종전엔 90초 넘게 입력 중·안내·오류 없이 조용했다. 켜지면 부재중 대기분으로 이 글에 답한다(원장 P-R5).
  const [awayNote, setAwayNote] = useState(null);
  useEffect(() => { setAwayNote(null); }, [chId]);
  const [ambiguous, setAmbiguous] = useState(null); // 같은 이름이 여럿인 직접 입력 @이름 — 글자를 고치면(목록에서 고르면) 사라진다
  useEffect(() => { setAmbiguous(null); }, [text, chId]);
  const onKey = (e) => {
    if (rolePick) { // /to·/cc 목록 — @멘션 팝업과 같은 키. Escape는 명령을 지운다
      const list = rolePick.list;
      const step = (from, dir) => { for (let k = 1; k <= list.length; k++) { const i = (from + dir * k + list.length * k) % list.length; if (!list[i].disabled) return i; } return from; }; // 미지원(disabled) 행은 건너뛴다(검수 M-3)
      if (list.length && e.key === 'ArrowDown') { e.preventDefault(); setSel(step(rsel < 0 ? 0 : rsel, 1)); return; }
      if (list.length && e.key === 'ArrowUp') { e.preventDefault(); setSel(step(rsel < 0 ? 0 : rsel, -1)); return; }
      if (list.length && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); if (rsel >= 0) pickRole(list[rsel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return; } // 명령만 있는 글은 보내지 않는다
    }
    if (slashCands?.length) { // '/' 커맨더 — @멘션 팝업과 같은 키(↑↓ 이동, Enter·Tab 선택). 선택은 삽입일 뿐 전송이 아니다
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((i) => (i + 1) % slashCands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((i) => (i - 1 + slashCands.length) % slashCands.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashCands[Math.min(slashSel, slashCands.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashOff(text); return; } // 목록만 닫는다 — 쓴 글은 그대로
    }
    if (pop && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[sel]); return; }
      if (e.key === 'Escape') { setPop(null); return; }
    }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); delivery.setReplyTo(null); return; } // 답글 취소(팝업이 먼저 닫힌다)
    if (e.key === 'Enter' && !e.shiftKey && !isMobilePlatform) { e.preventDefault(); send(); }
  };
  // 첨부 칩 — 폰은 알약 위 자기 줄(흐름 안, 멘션 후보창과 같은 쌓임)로, 데스크톱은 기존처럼 툴바 줄 안에(유건 2026-09-27 재검수)
  const fileChipsNode = files.length > 0 && <span className="msgr-filechips">{files.map((f) => <span key={`${f.name}:${f.size}`} className={`filechip${uploading === f.name ? ' busy' : ''}`}><I name="doc" size={12} /><span className="filechip-name">{f.name}</span><span className="msgr-klabel">{uploading === f.name ? t('att.uploading') : `${Math.max(1, Math.round(f.size / 1024))}KB`}</span>
    {uploading !== f.name && <button type="button" className="x" onMouseDown={(e) => e.preventDefault()} onClick={() => setFiles((cur) => withoutFile(cur, f))} disabled={busy} aria-label={t('att.remove', { name: f.name })} title={t('att.remove', { name: f.name })}>×</button>}</span>)}</span>;
  const card = job ? deliveryCardView({ busy, job, isDm }) : null; // 카드 제목·오류 줄 선택은 delivery-card.mjs(행동 테스트가 잠근다)
  return (
    <div className="msgr-dock" style={{ '--sbw': `${sbw}px` }}><div>
      {rolePick && (
        <div className="msgr-pop msgr-rolepop">
          <p className="head" id="msgr-rolepop-head">{t(rolePick.role === 'cc' ? 'cmd.cc' : 'cmd.to')}</p>
          {isDm && recipientLoad === 'loading' && <p className="empty" role="status">{t('ui.loading')}</p>}
          {isDm && recipientLoad === 'error' && <div className="empty" role="alert"><p>{t('dm.delivery.loadError')}</p><button type="button" className="btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setRecipientRetry((n) => n + 1)}>{t('dm.delivery.retry')}</button></div>}
          {(!isDm || recipientLoad === 'ready') && rolePick.list.length === 0 && <p className="empty">{t(rolePick.q ? 'cmd.noMatch' : 'dm.delivery.empty')}</p>}
          <div role="listbox" aria-labelledby="msgr-rolepop-head">{rolePick.list.map((c, i) => <button key={c.id} type="button" role="option" aria-selected={i === rsel} disabled={c.disabled} className={i === rsel ? 'on' : ''} ref={i === rsel ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : null} onMouseDown={(e) => { e.preventDefault(); pickRole(c); }}>
            <Av name={c.name} crew size="sm" crewId={c.id} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span><span className="msgr-klabel tag">{c.disabled ? t('dm.delivery.update') : c.sub || t('org.crew')}</span>
          </button>)}</div>
          {isDm && recipientLoad === 'ready' && <p className="foot"><button type="button" className="btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setRecipientRetry((n) => n + 1)}>{t('dm.delivery.retry')}</button></p>}
        </div>
      )}
      {slashCands && (
        <div className="msgr-pop msgr-slashpop" role="listbox" aria-label={t('cmd.title')}>
          {slashCands.length === 0 && <p className="empty">{t('cmd.empty')}</p>}
          {slashCands.map((c, i) => <button key={c.key} type="button" role="option" aria-selected={i === slashSel} className={i === slashSel ? 'on' : ''} ref={i === slashSel ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : null} onMouseDown={(e) => e.preventDefault()} onClick={() => pickSlash(c)}>
            <span className="cmd">/{c.cmd}</span><span className="desc">{c.desc}</span>
          </button>)}
        </div>
      )}
      {pop && candidates.length > 0 && (
        <div className="msgr-pop" role="listbox">
          {candidates.map((c, i) => <button key={`${c.kind}:${c.id}`} type="button" role="option" aria-selected={i === sel} disabled={c.disabled} className={i === sel ? 'on' : ''} ref={i === sel ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : null} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
            <Av name={c.kind === 'all' ? '@' : c.name} crew={c.kind === 'crew'} size="sm" crewId={c.kind === 'crew' ? c.id : null} userId={c.kind === 'user' ? c.id : null} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span><span className="msgr-klabel tag">{c.disabled ? t('dm.delivery.update') : c.kind === 'all' ? c.sub : c.kind === 'crew' ? (c.away ? `${t('org.crew')} · ${t('crew.offline')}` : t('org.crew')) : t(`role.${c.sub}`)}</span>
          </button>)}
        </div>
      )}
      {isDm && (deliveryBlocked || dmRetryBlocked) && <p className="msgr-dm-delivery-warning" role="alert">{t('dm.delivery.blocked')}</p>}
      {recipients.length > 0 && <div className="msgr-chips msgr-cc-chips" role="group" aria-label={t('dm.delivery.cc')}>{recipients.map((r) => <button key={r.id} type="button" className="msgr-chan" aria-label={t('dm.delivery.remove', { name: r.name })} disabled={busy || locked} onMouseDown={(e) => e.preventDefault()} onClick={() => setRecipients((rows) => rows.filter((x) => x.id !== r.id))}><span>{t(`dm.delivery.${r.role}`)} · {r.name}</span><I name="x" size={12} className="mi" /></button>)}</div>}
      {job && (!busy || job.files.length > 0) && <div className="msgr-delivery" role="status" aria-live="polite">
        <strong>{t(card.titleKey)}</strong>
        <p className="delivery-preview">{job.body || job.files.map((item) => item.file.name).join(', ')}</p>
        {uploading && <p>{t('att.uploading')} · {uploading}</p>}
        {card.errorLine && <p className="delivery-error">{card.errorLine.key ? t(card.errorLine.key) : friendlyErr(card.errorLine.raw, t)}{card.errorLine.files.length > 0 && ` · ${card.errorLine.files.join(', ')}`}</p>}
        {!busy && <div className="delivery-actions">{card.canRetry && <button type="button" className="btn" disabled={locked || retryBlocked} onClick={async () => { if (!locked && !retryBlocked && await delivery.retry()) onSent(delivery.snapshot().lastDeliveredId); }}>{t(card.retryKey)}</button>}
          <button type="button" className="btn" onClick={() => { delivery.dismiss(); requestAnimationFrame(() => autosize(ta.current)); }}>{t(card.dismissKey)}</button></div>}
      </div>}
      {awayNote && <div className="msgr-replychip msgr-awaychip" role="status"><span className="q">{awayNote.map((c) => (lang === 'en' ? (x) => x : koJosa)(t('mention.away', { name: c.display_name }))).join(' ')}</span><button type="button" className="msgr-titlebtn" onClick={() => setAwayNote(null)} aria-label={t('ui.close')}><I name="x" size={13} /></button></div>}
      {outside && <div className="msgr-outsidechip" role="status"><div className="rows">{outside.crews.map((c) => { const can = canInstructCrew(c, uid); const view = outsideRowView({ crew: c, uid, done: outside.done[c.id], isDm, can }); return (
        <OutsideRow key={c.id} text={<>{(lang === 'en' ? (x) => x : koJosa)(t(view.line, { name: c.display_name }))}{view.denied && ` ${t('mention.outside.denied')}`}{view.suffix && ` · ${t(view.suffix)}`}</>}
          dm={t(outsideDmPersonal?.(c) ? 'mention.outside.dm.personal' : 'mention.outside.dm')} onDm={can && onOutsideDm ? () => { const body = outside.body; setOutside(null); onOutsideDm(c.id, body); } : null}
          request={view.request} requestLabel={t('mention.outside.request')} onRequest={() => requestAdd(c)} />); })}</div><button type="button" className="msgr-titlebtn" onClick={() => setOutside(null)} aria-label={t('ui.close')}><I name="x" size={13} /></button></div>}
      {ambiguous && <p className="msgr-dm-delivery-warning msgr-mention-twins" role="alert">{t('mention.ambiguous', { name: ambiguous.join(', ') })}</p>}
      {replyTo && <div className="msgr-replychip" role="status"><I name="reply" size={13} /><span className="q"><b>{t('composer.replyTo', { name: replyTo.who })}</b> {replyTo.body}</span><button type="button" className="x" onClick={() => { delivery.setReplyTo(null); ta.current?.focus(); }} aria-label={t('composer.replyCancel')} title={t('composer.replyCancel')}><I name="x" size={12} /></button></div>}
      {phone && fileChipsNode}
      <form className={`msgr-composer${dragging ? ' drop' : ''}`} onSubmit={(e) => { e.preventDefault(); send(); }}
        onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) addFiles(e.dataTransfer?.files); }}>{/* 개인 공간도 첨부(2026-10-02) — 저장 경로 p/<방>/<글>/<파일>(composerTransport personal, 20261002100000) */}
        <input hidden multiple type="file" ref={fileRef} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <textarea ref={ta} rows={1} maxLength={20000} value={text} onChange={onChange} onBlur={() => setPop(null)} {...imeGuardWith(onKey)}
          onPaste={(e) => { const pasted = [...(e.clipboardData?.files ?? [])]; if (!pasted.length || busy) return; /* 개인 공간도 붙여넣기 첨부(2026-10-02 — 개인 경로 p/) */ e.preventDefault(); addFiles(pasted.map((f) => (f.name && f.name !== 'image.png') ? f : new File([f], `paste-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))); }} /* 클립보드 이미지 붙여넣기(유건 2026-09-11 밤) — 이름 없는 캡처는 paste-시각.png */ placeholder={t(phone ? 'phone.composer.ph' : 'msg.placeholder2')} /> {/* 초점이 빠지면 멘션 팝업을 닫는다 — 폰엔 Esc가 없다. 후보 단추는 mousedown preventDefault라 초점을 뺏지 않는다 */}
        <div className="msgr-tools">
          <button type="button" className="tb" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()} disabled={busy} title={t('msg.attach')}><I name="clip" size={15} /><span>{t('msg.attach')}</span></button>{/* 개인 방도 같은 버튼(2026-10-02) */}
          <button type="button" className="tb" onMouseDown={(e) => e.preventDefault()} onClick={insertAt} disabled={busy} title={t('msg.mention')}><I name="at" size={15} /><span>{t('msg.mention')}</span></button>
          {!phone && (files.length > 0 || channel.crew_memory === false) && <span className="sep" />}
          {!phone && fileChipsNode}
          {channel.crew_memory === false && <span className="tb on" title={t('ch.crewMemory')}><I name="memoff" size={15} /><span>{t('ch.memoryOff')}</span></span>}
          <button className="send" onMouseDown={(e) => e.preventDefault()} disabled={busy || locked || deliveryBlocked || !!rolePick || (job ? retryBlocked : (!text.trim() && !files.length))} aria-label={t('msg.send')} title={locked ? t('org.locked.short') : t('msg.send')}><I name="up" size={16} /></button>
        </div>
      </form>
      <div className="msgr-sub">
        <span className="typing-line">{typingLabel && <><span className="msgr-dot mark" />{t(typingLabel.key, typingLabel.vars)}</>}</span>
      </div>
    </div></div>
  );
}
