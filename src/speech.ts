// Spracheingabe über die Web Speech API (de-DE).

type Rec = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

export function speechSupported(): boolean {
  return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
}

let current: Rec | null = null;

/**
 * Hört einmal zu. Liefert alle Alternativen (beste zuerst) oder einen Fehlertext.
 */
export function listenOnce(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Ctor) {
      reject(new Error('Spracheingabe wird von diesem Browser nicht unterstützt.'));
      return;
    }
    current?.abort();
    const rec: Rec = new Ctor();
    current = rec;
    rec.lang = 'de-DE';
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 5;
    let got = false;
    rec.onresult = (e) => {
      got = true;
      const res = e.results[0];
      const alts: string[] = [];
      for (let i = 0; i < res.length; i++) alts.push(res[i].transcript);
      resolve(alts);
    };
    rec.onerror = (e) => {
      got = true;
      const map: Record<string, string> = {
        'no-speech': 'Nichts gehört.',
        network: 'Spracherkennung braucht hier Internet. Bitte Tastatur benutzen.',
        'not-allowed': 'Mikrofon nicht erlaubt.',
        'service-not-allowed': 'Spracherkennung nicht verfügbar.',
        aborted: 'Abgebrochen.',
      };
      reject(new Error(map[e.error] ?? 'Spracherkennung fehlgeschlagen.'));
    };
    rec.onend = () => {
      current = null;
      if (!got) reject(new Error('Nichts gehört.'));
    };
    try {
      rec.start();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function stopListening() {
  current?.abort();
  current = null;
}
