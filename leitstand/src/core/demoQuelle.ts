import { erzeugeDemoTag } from './demo';
import type { TourDataSource } from './quellen';
import { DEMO_SEED, erzeugeDemoWelt } from './welt';

/** Tourdaten aus der erfundenen Demo-Welt (deterministisch) */
export class DemoTourDataSource implements TourDataSource {
  constructor(private seed = DEMO_SEED) {}

  async ladeTag(optionen: { mengenFaktor?: number } = {}) {
    const welt = erzeugeDemoWelt(this.seed);
    const { tag, plan } = erzeugeDemoTag(welt, { mengenFaktor: optionen.mengenFaktor });
    return { welt, tag, plan };
  }
}
