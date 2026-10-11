// Ehrliche Statusanzeige: offline bereit, Speicher dauerhaft, Update verfügbar,
// Gebiet unvollständig, Sicherung fällig.

import { state } from './data';
import { offlineStatus } from './offline';
import { backupState } from './exportimport';

let updateReady = false;
const listeners = new Set<() => void>();

export function onStatusChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const l of listeners) l();
}

/** Neue App-Version liegt bereit (Service Worker hat gewechselt). Daten bleiben unberührt. */
export function setUpdateReady() {
  updateReady = true;
  emit();
}
export function isUpdateReady() {
  return updateReady;
}

/** Bittet den Browser, die Daten nicht automatisch zu löschen (iOS kann sonst aufräumen). */
export async function requestPersist(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageInfo(): Promise<{ persisted: boolean | null; usage: number | null; quota: number | null }> {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
  } catch {
    return { persisted: null, usage: null, quota: null };
  }
}

/** Gebiete mit Straßen, an denen Häuser stehen, aber keine Hausnummern bekannt sind. */
export function incompleteRegions(): { name: string; gaps: number }[] {
  return state.packages.filter((p) => (p.entry.gaps ?? 0) > 0).map((p) => ({ name: p.entry.name, gaps: p.entry.gaps }));
}

export interface StatusSummary {
  offline: boolean;
  regions: number;
  updateReady: boolean;
  backupDue: boolean;
  incomplete: { name: string; gaps: number }[];
  /** Etwas braucht Aufmerksamkeit (für das Zeichen am Menü) */
  attention: boolean;
}

export async function statusSummary(): Promise<StatusSummary> {
  const [off, b] = await Promise.all([offlineStatus(), backupState()]);
  const backupDue = b.count > 0 && b.due;
  const incomplete = incompleteRegions();
  return {
    offline: off.app && off.regions > 0,
    regions: off.regions,
    updateReady,
    backupDue,
    incomplete,
    attention: updateReady || backupDue || off.regions === 0,
  };
}
