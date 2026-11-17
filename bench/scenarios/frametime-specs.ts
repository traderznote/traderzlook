// Frame-time scenarios (browser runner only, since timings are noise-sensitive) plus S12, whose
// memory gates also have a node approximation in node-mem.mjs.
import type { ScenarioSpec } from '../gates';
import S1 from './S1';
import S4 from './S4';
import S5 from './S5';
import S6 from './S6';
import S7 from './S7';
import S9 from './S9';
import S10 from './S10';
import S11 from './S11';
import S12 from './S12';
import S13 from './S13';
import S14 from './S14';
import S17 from './S17';

export const FRAMETIME_SCENARIOS: readonly ScenarioSpec[] = [
  S1, S4, S5, S6, S7, S9, S10, S11, S12, S13, S14, S17,
];

export const NODE_MEMORY_SCENARIOS: readonly ScenarioSpec[] = [S12];
