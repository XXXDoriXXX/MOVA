import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { Contact, ContactStatus, User } from '@mova-back/shared-database';

import { UsersService } from '../users/users.service';

export interface ContactUser {
  id: string;
  username: string | null;
  name: string;
  isDeafMute: boolean;
}

export interface IncomingRequest {
  requestId: string;
  from: ContactUser;
  createdAt: string;
}

function toContactUser(u: User): ContactUser {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    isDeafMute: u.isDeafMute,
  };
}

@Injectable()
export class ContactsService {
  constructor(
    @InjectRepository(Contact)
    private readonly contacts: Repository<Contact>,
    private readonly users: UsersService,
  ) {}

  // Find a verified user by nickname or email to send a request to.
  async search(query: string): Promise<ContactUser | null> {
    const user = await this.users.findVerifiedByHandle(query);
    return user ? toContactUser(user) : null;
  }

  async request(requesterId: string, handle: string): Promise<{ status: ContactStatus }> {
    const target = await this.users.findVerifiedByHandle(handle);
    if (!target) {
      throw new NotFoundException('No verified user with that nickname or email');
    }
    if (target.id === requesterId) {
      throw new BadRequestException('You cannot add yourself');
    }

    // If the target already requested us, accept that instead of duplicating.
    const reverse = await this.contacts.findOne({
      where: { requesterId: target.id, addresseeId: requesterId },
    });
    if (reverse) {
      if (reverse.status !== ContactStatus.ACCEPTED) {
        reverse.status = ContactStatus.ACCEPTED;
        await this.contacts.save(reverse);
      }
      return { status: ContactStatus.ACCEPTED };
    }

    const existing = await this.contacts.findOne({
      where: { requesterId, addresseeId: target.id },
    });
    if (existing) {
      return { status: existing.status };
    }

    try {
      const created = await this.contacts.save(
        this.contacts.create({
          requesterId,
          addresseeId: target.id,
          status: ContactStatus.PENDING,
        }),
      );
      return { status: created.status };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('Request already exists');
      }
      throw err;
    }
  }

  async incomingRequests(userId: string): Promise<IncomingRequest[]> {
    const rows = await this.contacts.find({
      where: { addresseeId: userId, status: ContactStatus.PENDING },
      relations: { requester: true },
      order: { createdAt: 'DESC' },
    });
    return rows.map((r) => ({
      requestId: r.id,
      from: toContactUser(r.requester),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async respond(
    userId: string,
    requestId: string,
    accept: boolean,
  ): Promise<void> {
    const req = await this.contacts.findOne({
      where: { id: requestId, addresseeId: userId, status: ContactStatus.PENDING },
    });
    if (!req) throw new NotFoundException('Request not found');
    req.status = accept ? ContactStatus.ACCEPTED : ContactStatus.DECLINED;
    await this.contacts.save(req);
  }

  async list(userId: string): Promise<ContactUser[]> {
    const rows = await this.contacts.find({
      where: [
        { requesterId: userId, status: ContactStatus.ACCEPTED },
        { addresseeId: userId, status: ContactStatus.ACCEPTED },
      ],
      relations: { requester: true, addressee: true },
      order: { updatedAt: 'DESC' },
    });
    return rows.map((r) =>
      toContactUser(r.requesterId === userId ? r.addressee : r.requester),
    );
  }

  // Either party may remove the contact, identified by the OTHER user's id
  // (which is all the contact list exposes). Deletes the pair row in whichever
  // direction it was created.
  async remove(userId: string, otherUserId: string): Promise<void> {
    await this.contacts
      .createQueryBuilder()
      .delete()
      .where(
        new Brackets((qb) =>
          qb
            .where(
              '"requesterId" = :userId AND "addresseeId" = :otherUserId',
              { userId, otherUserId },
            )
            .orWhere(
              '"requesterId" = :otherUserId AND "addresseeId" = :userId',
              { userId, otherUserId },
            ),
        ),
      )
      .execute();
  }

  // True iff the two users have an ACCEPTED contact in either direction —
  // the precondition for placing a peer call.
  async areContacts(a: string, b: string): Promise<boolean> {
    const row = await this.contacts.findOne({
      where: [
        { requesterId: a, addresseeId: b, status: ContactStatus.ACCEPTED },
        { requesterId: b, addresseeId: a, status: ContactStatus.ACCEPTED },
      ],
    });
    return row !== null;
  }
}
