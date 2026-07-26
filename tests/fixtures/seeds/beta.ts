import { defineSeed } from '../../../src/define.ts';

export default defineSeed({
  name: 'renamed-on-purpose',
  dependsOn: ['alpha'],
  environments: ['development'],
  mode: 'always',
  transaction: false,
  async run() {},
});
