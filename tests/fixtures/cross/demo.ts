import { defineSeed } from '../../../src/define.ts';
import { REGIONS, seedTerritory } from './territory.ts';

/**
 * The real consumer's shape, in two lines: one statement importing another seed's constants
 * and its work together, so nothing about the names can tell the two apart.
 */
export default defineSeed({
  dependsOn: ['territory'],
  async run() {
    await seedTerritory();
    if (REGIONS.length === 0) throw new Error('unreachable');
  },
});
