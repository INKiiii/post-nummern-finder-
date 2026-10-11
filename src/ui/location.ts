// Klare Anleitung, wenn der Standortzugriff verweigert wurde.

import { h } from './dom';
import { gps } from '../gps';

function platformSteps(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'iPhone: Einstellungen › Datenschutz & Sicherheit › Ortungsdienste einschalten › Safari-Websites (bzw. die App) › „Beim Verwenden der App“. Danach hierher zurückkehren.';
  }
  if (/Android/.test(ua)) {
    return 'Android: Einstellungen › Standort einschalten. Im Browser: Schloss-Symbol neben der Adresse › Berechtigungen › Standort › Zulassen. Danach hierher zurückkehren.';
  }
  return 'Im Browser: Schloss-Symbol neben der Adresse › Standort › Zulassen. Danach hierher zurückkehren.';
}

/** Großer Hinweiskasten mit Anleitung. */
export function locationDeniedBox(compact = false) {
  return h(
    'div',
    { class: 'loc-denied' + (compact ? ' compact' : ''), role: 'alert' },
    h('div', { class: 'loc-title' }, '📍 Standort erlauben: Einstellungen, Datenschutz, Ortungsdienste'),
    compact ? null : h('div', { class: 'loc-steps' }, platformSteps()),
    h('button', { class: 'btn big loc-retry', onClick: () => gps.retry() }, '↻ Standort erneut prüfen'),
    h('div', { class: 'loc-note' }, 'Ohne Standort gibt es keine Entfernung und keine Straßenseite. Suche und Karte funktionieren trotzdem.'),
  );
}
