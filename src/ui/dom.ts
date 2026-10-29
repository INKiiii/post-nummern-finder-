// Mini-Helfer zum Erzeugen von DOM-Elementen.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; onClick?: (e: MouseEvent) => void };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k in e && typeof v !== 'string') (e as any)[k] = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

/**
 * Kurze Meldung oben am Bildschirm (verdeckt nie Tastatur, Leiste oder die Karte unten),
 * nach 2 s weg. Mit Aktion (z. B. „Rückgängig“) bleibt sie 6 s stehen.
 */
export function toast(msg: string, ms = 2000, action?: { label: string; run: () => void }) {
  document.querySelectorAll('.toast').forEach((o) => o.remove());
  const t = h('div', { class: 'toast', role: 'status' }, h('span', null, msg));
  if (action) {
    ms = Math.max(ms, 6000);
    t.append(
      h(
        'button',
        {
          class: 'toast-action',
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            t.remove();
            action.run();
          },
        },
        action.label,
      ),
    );
  }
  t.addEventListener('click', () => t.remove());
  document.body.appendChild(t);
  t.classList.add('show');
  setTimeout(() => t.remove(), ms);
}

const reduceMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * Bottom-Sheet (bzw. Vollbild-Dialog); liefert eine Schließen-Funktion. Es gleitet weich herein
 * und hinaus. Mit `dismissible` hat es oben einen Griff: nach unten wischen oder daneben tippen
 * schließt es (nur für Sheets ohne offene Entscheidung, z. B. das Menü).
 */
export function overlay(content: HTMLElement, onClose?: () => void, opts: { dismissible?: boolean } = {}) {
  // Meldungen oben würden den Kopf des Dialogs verdecken
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const o = h('div', { class: 'overlay' }, content);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
    if (reduceMotion()) {
      o.remove();
      return;
    }
    // sanft hinaus; Tipps gehen sofort wieder an die Seite darunter
    o.classList.add('closing');
    setTimeout(() => o.remove(), 240);
  };
  if (opts.dismissible) {
    const grip = h('div', { class: 'sheet-grip', 'aria-hidden': 'true' });
    content.prepend(grip);
    o.addEventListener('click', (e) => {
      if (e.target === o) close();
    });
    // Nach unten wischen: Sheet folgt dem Finger, ab 90 px (oder schnellem Wisch) schließt es
    let start: { y: number; t: number } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      start = { y: e.clientY, t: performance.now() };
      grip.setPointerCapture(e.pointerId);
      content.style.transition = 'none';
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dy = Math.max(0, e.clientY - start.y);
      content.style.transform = `translateY(${dy}px)`;
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      const dy = Math.max(0, e.clientY - start.y);
      const fast = dy > 30 && dy / Math.max(1, performance.now() - start.t) > 0.6;
      start = null;
      content.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
      if (dy > 90 || fast) {
        content.style.transform = 'translateY(110%)';
        close();
      } else content.style.transform = '';
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }
  document.body.appendChild(o);
  return close;
}

export function confirmBig(question: string, yes = 'Ja', no = 'Abbrechen'): Promise<boolean> {
  return new Promise((resolve) => {
    let close = () => {};
    const box = h(
      'div',
      { class: 'dialog' },
      h('p', { class: 'dialog-text' }, question),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn big', onClick: () => (close(), resolve(false)) }, no),
        h('button', { class: 'btn big primary', onClick: () => (close(), resolve(true)) }, yes),
      ),
    );
    close = overlay(box);
  });
}

export function formatBytes(b: number): string {
  if (b >= 1e6) return `${(b / 1e6).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}

export function formatDate(t: number | string): string {
  const d = new Date(t);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
