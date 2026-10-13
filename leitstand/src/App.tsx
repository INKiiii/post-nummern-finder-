import { useEffect, useState } from 'react';
import { useLeitstand } from './state/store';
import { Datenquellen } from './ui/Datenquellen';
import { IdeeInZahlen } from './ui/IdeeInZahlen';
import { ScannerApp } from './ui/fahrer/ScannerApp';
import { KernAnsicht } from './ui/KernAnsicht';
import { DemoOverlay, demoLos } from './ui/demo/DemoOverlay';
import { Leitstand } from './ui/Leitstand';
import { RechenwegDialog } from './ui/Rechenweg';
import { useSimulationsTakt } from './ui/takt';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const f = () => setHash(window.location.hash);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  // Geräte-Ansicht: eigenes Fenster, eigene Daten, nur über die Schnittstelle FahrerGeraet verbunden
  if (hash.startsWith('#/fahrer')) {
    const tour = hash.split('/')[2] || null;
    return <ScannerApp key={tour ?? 'wahl'} tourId={tour} />;
  }
  return <LeitstandFenster hash={hash} />;
}

function LeitstandFenster({ hash }: { hash: string }) {
  const laden = useLeitstand((s) => s.laden);
  const geladen = useLeitstand((s) => !!s.welt);
  useEffect(() => {
    void laden();
  }, [laden]);
  useSimulationsTakt();
  // ?demo startet die geführte Demo gleich nach dem Laden (z. B. für eine Aufnahme)
  useEffect(() => {
    if (geladen && new URLSearchParams(window.location.search).has('demo')) demoLos();
  }, [geladen]);
  const leitstand = hash === '' || hash === '#/' || hash === '#';
  return (
    <>
      {hash === '#/kern' ? <KernAnsicht /> : hash === '#/datenquellen' ? <Datenquellen /> : hash === '#/zahlen' ? <IdeeInZahlen /> : <Leitstand />}
      <RechenwegDialog />
      <DemoOverlay unten={!leitstand} />
    </>
  );
}
