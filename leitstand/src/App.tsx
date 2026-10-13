import { useEffect, useState } from 'react';
import { useLeitstand } from './state/store';
import { KernAnsicht } from './ui/KernAnsicht';
import { Leitstand } from './ui/Leitstand';
import { RechenwegDialog } from './ui/Rechenweg';

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
  const laden = useLeitstand((s) => s.laden);
  const hash = useHash();
  useEffect(() => {
    void laden();
  }, [laden]);
  return (
    <>
      {hash === '#/kern' ? <KernAnsicht /> : <Leitstand />}
      <RechenwegDialog />
    </>
  );
}
