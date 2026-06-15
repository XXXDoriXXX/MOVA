jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@mova-back/shared-config', () => {
  const noop = (): undefined => undefined;
  return {
    CallLogger: class {
      event = noop;
      warn = noop;
      error = noop;
      debug = noop;
      child(): unknown {
        return this;
      }
    },
  };
});

import { Test } from '@nestjs/testing';

import { REDIS_CLIENT } from '@mova-back/shared-redis';

import { BillingService } from '../billing/billing.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ConversationLifecycleService } from '../conversations/conversation-lifecycle.service';
import { TemplatesService } from '../templates/templates.service';
import { UsersService } from '../users/users.service';
import { ContactsService } from '../contacts/contacts.service';
import { MetricsModule } from '../metrics/metrics.module';
import { LivekitService } from './livekit.service';
import { PeerCallService } from './peer-call.service';
import { PushNotifierService } from '../push/push-notifier.service';
import { PushTokenService } from '../push/push-token.service';

describe('api-gateway DI wiring (peer-call metrics)', () => {
  it('resolves PeerCallService with injected prometheus metrics', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MetricsModule],
      providers: [
        PeerCallService,
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: ConversationsService, useValue: {} },
        { provide: ConversationLifecycleService, useValue: {} },
        { provide: BillingService, useValue: {} },
        { provide: TemplatesService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: ContactsService, useValue: {} },
        { provide: LivekitService, useValue: {} },
        { provide: PushTokenService, useValue: {} },
        { provide: PushNotifierService, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(PeerCallService)).toBeInstanceOf(PeerCallService);
  });
});
