import { sharedAgent } from './shared-agent';

describe('sharedAgent', () => {
  it('should work', () => {
    expect(sharedAgent()).toEqual('shared-agent');
  })
})
