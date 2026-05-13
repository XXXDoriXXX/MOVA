import { sharedDatabase } from './shared-database';

describe('sharedDatabase', () => {
  it('should work', () => {
    expect(sharedDatabase()).toEqual('shared-database');
  })
})
