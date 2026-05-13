import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User, SharedDatabaseModule } from '@mova-back/shared-database';
import { UsersService } from './users.service';

@Module({
  imports: [
    SharedDatabaseModule,
    TypeOrmModule.forFeature([User])
  ],
  providers: [UsersService],
  exports: [UsersService]
})
export class UsersModule {}
