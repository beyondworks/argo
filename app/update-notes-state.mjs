import { cmpVersion } from '../src/version-compare.mjs';

export const UPDATE_NOTES_STORAGE_KEY = 'argo-update-notes-version';
export const UPDATE_NOTES = Object.freeze({
  '0.1.89': Object.freeze(['updates.note.models', 'updates.note.effort', 'updates.note.background', 'updates.note.workflow']),
  '0.1.90': Object.freeze(['updates.note.steer', 'updates.note.firstSend']),
  '0.1.91': Object.freeze(['updates.note.sonnet55', 'updates.note.msgrMarker']),
  '0.1.92': Object.freeze(['updates.note.personalCrews', 'updates.note.crewCalendar', 'updates.note.msgrAutoConnect']),
  '0.1.93': Object.freeze(['updates.note.cliBundled', 'updates.note.delegationSwitch', 'updates.note.splash']),
  '0.1.94': Object.freeze(['updates.note.sessionMsg', 'updates.note.inboundCard', 'updates.note.fullAutoScope', 'updates.note.autoAttach', 'updates.note.shipSplash']),
});

export function stableVersion(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split('.').every((part) => Number.isSafeInteger(Number(part)));
}

export function updateNotesFor(current, bundleVersion) {
  if (!stableVersion(current) || !stableVersion(bundleVersion) || current !== bundleVersion) return [];
  return Object.hasOwn(UPDATE_NOTES, current) ? UPDATE_NOTES[current] : [];
}

export function shouldShowUpdateNotes({ current, bundleVersion, ready, loaded, ackVersion = null,
  dismissed = false, blocked = false, hidden = false, editing = false, overlay = false }) {
  return !!(ready && loaded && !dismissed && !blocked && !hidden && !editing && !overlay
    && updateNotesFor(current, bundleVersion).length
    && (!stableVersion(ackVersion) || cmpVersion(current, ackVersion) > 0));
}

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
