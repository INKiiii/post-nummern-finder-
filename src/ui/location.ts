// Klare Anleitung, wenn der Standortzugriff verweigert wurde.

import { h } from './dom';

function platformSteps(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'iPhone: Einstellungen › Datenschutz & Sicherheit › Ortungsdienste einschalten › Safari-Websites (bzw. die App) › „Beim Verwenden der App“. Danach diese Seite neu laden.';
  }
  if (/Android/.test(ua)) {
    return 'Android: Einstellungen › Standort einschalten. Im Browser: Schloss-Symbol neben der Adresse › Berechtigungen › Standort › Zulassen. Danach neu laden.';
  }
  return 'Im Browser: Schloss-Symbol neben der Adresse › Standort › Zulassen. Danach neu laden.';
}

/** Großer Hinweiskasten mit Anleitung. */
export function locationDeniedBox(compact = false) {
  return h(
    'div',
    { class: 'loc-denied' + (compact ? ' compact' : ''), role: 'alert' },
    h('div', { class: 'loc-title' }, '📍 Standort erlauben: Einstellungen, Datenschutz, Ortungsdienste'),
    compact ? null : h('div', { class: 'loc-steps' }, platformSteps()),
    h('div', { class: 'loc-note' }, 'Ohne Standort gibt es keine Entfernung und keine Straßenseite. Suche und Karte funktionieren trotzdem.'),
  );
}
