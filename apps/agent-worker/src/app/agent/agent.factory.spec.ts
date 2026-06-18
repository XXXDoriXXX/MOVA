import { AgentFactory, type AgentContext } from './agent.factory';

// getInitialGreeting is pure (uses only its `context` arg), so the factory deps
// are irrelevant here — stub them out.
const factory = new AgentFactory(
  {} as never,
  {} as never,
  {} as never,
);

function ctx(overrides: Partial<AgentContext>): AgentContext {
  return { userName: '', userRole: '', callReason: '', ...overrides } as AgentContext;
}

describe('AgentFactory.getInitialGreeting', () => {
  it('leads with the reason, THEN the deaf + MOVA-assistant disclosure', () => {
    const g = factory.getInitialGreeting(
      ctx({ userName: 'Вадим', callReason: 'забрати доставку' }),
    );
    expect(g).toBe(
      'Доброго дня! Телефоную ось чому: забрати доставку. ' +
        'Це Вадим, я спілкуюся через голосового асистента МОВА, бо не чую.',
    );
    // Reason must come before the disclosure.
    expect(g.indexOf('забрати доставку')).toBeLessThan(g.indexOf('не чую'));
  });

  it('omits the name clause when no name is set', () => {
    const g = factory.getInitialGreeting(ctx({ callReason: 'записатись до лікаря' }));
    expect(g).toBe(
      'Доброго дня! Телефоную ось чому: записатись до лікаря. ' +
        'Я спілкуюся через голосового асистента МОВА, бо не чую.',
    );
  });

  it('falls back to name + disclosure when there is no reason', () => {
    const g = factory.getInitialGreeting(ctx({ userName: 'Оля' }));
    expect(g).toBe(
      'Доброго дня! Це Оля, я спілкуюся через голосового асистента МОВА, бо не чую.',
    );
  });

  it('uses the bare disclosure when neither reason nor name is set', () => {
    const g = factory.getInitialGreeting(ctx({}));
    expect(g).toBe(
      'Доброго дня! Я спілкуюся через голосового асистента МОВА, бо не чую.',
    );
  });

  it('does not double up punctuation when the reason already ends with a period', () => {
    const g = factory.getInitialGreeting(ctx({ callReason: 'забрати доставку.' }));
    expect(g).toContain('Телефоную ось чому: забрати доставку.');
    expect(g).not.toContain('доставку..');
  });
});
