// Bildschirm-Navigation. Jeder Bildschirm liefert eine Aufräumfunktion.

export type ScreenName = 'start' | 'result' | 'regions' | 'data' | 'newstreet';
export type Params = Record<string, any>;
type Screen = (root: HTMLElement, params: Params) => (() => void) | void;

const screens = new Map<ScreenName, Screen>();
let cleanup: (() => void) | void;
let root: HTMLElement;
let current: ScreenName | null = null;

export function registerScreen(name: ScreenName, fn: Screen) {
  screens.set(name, fn);
}

export function initApp(el: HTMLElement) {
  root = el;
  // Zurück-Taste (Android) führt immer zum Startbildschirm
  window.addEventListener('popstate', () => {
    if (current !== 'start') show('start', {}, false);
  });
}

export function show(name: ScreenName, params: Params = {}, push = true) {
  cleanup?.();
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  root.replaceChildren();
  root.className = `screen screen-${name}`;
  if (push && name !== 'start' && current === 'start') history.pushState({ name }, '');
  current = name;
  cleanup = screens.get(name)!(root, params);
  window.scrollTo(0, 0);
}
