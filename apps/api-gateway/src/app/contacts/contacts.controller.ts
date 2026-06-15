import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '@mova-back/shared-auth';

import {
  ContactsService,
  type ContactUser,
  type IncomingRequest,
} from './contacts.service';
import { ContactRequestDto, ContactSearchDto } from './dto/contacts.schemas';

@ApiTags('contacts')
@ApiBearerAuth()
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get('search')
  @ApiOperation({ summary: 'Find a verified user by nickname or email' })
  search(
    @CurrentUser() _user: AuthenticatedUser,
    @Query() query: ContactSearchDto,
  ): Promise<{ user: ContactUser | null }> {
    return this.contacts.search(query.q).then((user) => ({ user }));
  }

  @Post('requests')
  @ApiOperation({ summary: 'Send a contact request by nickname or email' })
  request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ContactRequestDto,
  ): Promise<{ status: string }> {
    return this.contacts.request(user.id, dto.handle);
  }

  @Get('requests')
  @ApiOperation({ summary: 'List incoming pending contact requests' })
  incoming(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<IncomingRequest[]> {
    return this.contacts.incomingRequests(user.id);
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Accept a contact request' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.contacts.respond(user.id, id, true);
  }

  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline a contact request' })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.contacts.respond(user.id, id, false);
  }

  @Get()
  @ApiOperation({ summary: 'List accepted contacts' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ContactUser[]> {
    return this.contacts.list(user.id);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a contact by the other user id' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.contacts.remove(user.id, userId);
  }
}
