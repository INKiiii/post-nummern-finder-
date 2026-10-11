// Einheitliche Symbole (SVG) statt Emojis – sehen auf jedem Gerät gleich aus.

const NS = 'http://www.w3.org/2000/svg';

const PATHS: Record<string, string> = {
  pin: '<path d="M12 22s7-6.4 7-12a7 7 0 1 0-14 0c0 5.6 7 12 7 12z" fill="currentColor"/><circle cx="12" cy="10" r="2.6" fill="rgba(0,0,0,.55)"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  search: '<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2.4" fill="none"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" fill="currentColor"/><circle cx="12" cy="21" r="2" fill="currentColor"/>',
  bellOff: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" fill="currentColor" opacity=".45"/><path d="M4 3l17 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  back: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M9 4v14M15 6v14" stroke="currentColor" stroke-width="2.2"/>',
  data: '<path d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M12 3l10 18H2z" fill="currentColor"/><path d="M12 10v5M12 18v.5" stroke="#000" stroke-width="2.4" stroke-linecap="round"/>',
  turnRight: '<path d="M7 21V12c0-3 2.2-5 5-5h7M15 3l4 4-4 4" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  turnLeft: '<path d="M17 21V12c0-3-2.2-5-5-5H5M9 3L5 7l4 4" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  straight: '<path d="M12 21V4M6 10l6-6 6 6" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  uturn: '<path d="M8 21V9a4 4 0 0 1 8 0v4M12 9l4 4 4-4" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="rotate(180 12 12)"/>',
  flag: '<path d="M6 21V4M6 4h11l-2 4 2 4H6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  locate: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  house: '<path d="M4 11l8-7 8 7v9H4z" fill="currentColor"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  minus: '<path d="M5 12h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>',
  gear: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.6" fill="currentColor"/><circle cx="4.5" cy="12" r="1.6" fill="currentColor"/><circle cx="4.5" cy="18" r="1.6" fill="currentColor"/>',
  road: '<path d="M8 3L5 21M16 3l3 18M12 4v3M12 10v3M12 16v3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  undo: '<path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -3)"/>',
};

export type IconName = keyof typeof PATHS;

/** Symbol als SVG-Element (Farbe über CSS "color"). */
export function icon(name: IconName, size = 24, cls = ''): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ic ${cls}`.trim());
  svg.innerHTML = PATHS[name];
  return svg;
}
