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

/** Seite aus der Adresse: „#/zahlen“ und „#zahlen“ führen zur selben Seite („zahlen“) */
function useSeite(): string {
  const lesen = () => window.location.hash.replace(/^#\/?/, '');
  const [seite, setSeite] = useState(lesen);
  useEffect(() => {
    const f = () => setSeite(lesen());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return seite;
}

export function App() {
  const seite = useSeite();
  // Geräte-Ansicht: eigenes Fenster, eigene Daten, nur über die Schnittstelle FahrerGeraet verbunden
  if (seite.startsWith('fahrer')) {
    const tour = seite.split('/')[1] || null;
    return <ScannerApp key={tour ?? 'wahl'} tourId={tour} />;
  }
  return <LeitstandFenster seite={seite} />;
}

function LeitstandFenster({ seite }: { seite: string }) {
  const laden = useLeitstand((s) => s.laden);
  const geladen = useLeitstand((s) => !!s.welt);
  useEffect(() => {
    void laden();
  }, [laden]);
  useSimulationsTakt();
  // ?demo oder #demo startet die geführte Demo gleich nach dem Laden (z. B. für eine Aufnahme)
  const demoAdresse = seite === 'demo';
  useEffect(() => {
    if (geladen && (demoAdresse || new URLSearchParams(window.location.search).has('demo'))) demoLos();
  }, [geladen, demoAdresse]);
  const leitstand = seite === '' || seite === 'demo';
  return (
    <>
      {seite === 'kern' ? <KernAnsicht /> : seite === 'datenquellen' ? <Datenquellen /> : seite === 'zahlen' ? <IdeeInZahlen /> : <Leitstand />}
      <RechenwegDialog />
      <DemoOverlay unten={!leitstand} />
    </>
  );
}
