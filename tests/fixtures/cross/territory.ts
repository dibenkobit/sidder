import { defineSeed } from '../../../src/define.ts';

/** Shared data, living in a seed file — which is the half of the finding sidder cannot name. */
export const REGIONS = ['north', 'south'];

/** This seed's own work, exported and callable — the half that applies twice. */
export async function seedTerritory(): Promise<void> {}

export default defineSeed({
  async run() {
    await seedTerritory();
  },
});
