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

/** Kurze Meldung unten am Bildschirm. */
export function toast(msg: string, ms = 3000) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/** Vollbild-Dialog; liefert eine Schließen-Funktion. */
export function overlay(content: HTMLElement, onClose?: () => void) {
  const o = h('div', { class: 'overlay' }, content);
  document.body.appendChild(o);
  const close = () => {
    o.remove();
    onClose?.();
  };
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
