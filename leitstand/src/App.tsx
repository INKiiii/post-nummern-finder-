import { useEffect } from 'react';
import { useLeitstand } from './state/store';
import { KernAnsicht } from './ui/KernAnsicht';
import { RechenwegDialog } from './ui/Rechenweg';

export function App() {
  const laden = useLeitstand((s) => s.laden);
  useEffect(() => {
    void laden();
  }, [laden]);
  return (
    <>
      <KernAnsicht />
      <RechenwegDialog />
    </>
  );
}
