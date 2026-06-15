import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ContactStatus } from '@mova-back/shared-database';

import { ContactsService } from './contacts.service';

type RepoMock = {
  findOne: jest.Mock;
  find: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
};

function build() {
  const repo: RepoMock = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn((x) => Promise.resolve(x)),
    create: jest.fn((x) => x),
  };
  const users = { findVerifiedByHandle: jest.fn() };
  const svc = new ContactsService(repo as never, users as never);
  return { svc, repo, users };
}

const target = {
  id: 'target-1',
  username: 'alice',
  name: 'Alice',
  isDeafMute: true,
};

describe('ContactsService.request', () => {
  it('rejects an unknown handle with 404', async () => {
    const { svc, users } = build();
    users.findVerifiedByHandle.mockResolvedValue(null);
    await expect(svc.request('me', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects adding yourself', async () => {
    const { svc, users } = build();
    users.findVerifiedByHandle.mockResolvedValue({ ...target, id: 'me' });
    await expect(svc.request('me', 'me@x.io')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('auto-accepts when the target already requested us', async () => {
    const { svc, repo, users } = build();
    users.findVerifiedByHandle.mockResolvedValue(target);
    repo.findOne.mockResolvedValueOnce({
      id: 'r1',
      requesterId: target.id,
      addresseeId: 'me',
      status: ContactStatus.PENDING,
    });
    const res = await svc.request('me', 'alice');
    expect(res.status).toBe(ContactStatus.ACCEPTED);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ContactStatus.ACCEPTED }),
    );
  });

  it('creates a pending request when none exists', async () => {
    const { svc, repo, users } = build();
    users.findVerifiedByHandle.mockResolvedValue(target);
    repo.findOne.mockResolvedValue(null); // no reverse, no existing
    const res = await svc.request('me', 'alice');
    expect(res.status).toBe(ContactStatus.PENDING);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterId: 'me',
        addresseeId: target.id,
        status: ContactStatus.PENDING,
      }),
    );
  });

  it('returns the existing status without duplicating', async () => {
    const { svc, repo, users } = build();
    users.findVerifiedByHandle.mockResolvedValue(target);
    repo.findOne
      .mockResolvedValueOnce(null) // no reverse
      .mockResolvedValueOnce({ status: ContactStatus.PENDING }); // existing
    const res = await svc.request('me', 'alice');
    expect(res.status).toBe(ContactStatus.PENDING);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('ContactsService.areContacts', () => {
  it('is true when an accepted row exists in either direction', async () => {
    const { svc, repo } = build();
    repo.findOne.mockResolvedValue({ id: 'x' });
    await expect(svc.areContacts('a', 'b')).resolves.toBe(true);
  });

  it('is false when no accepted row exists', async () => {
    const { svc, repo } = build();
    repo.findOne.mockResolvedValue(null);
    await expect(svc.areContacts('a', 'b')).resolves.toBe(false);
  });
});
