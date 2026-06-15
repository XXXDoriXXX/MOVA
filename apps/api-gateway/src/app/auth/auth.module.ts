import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PasswordBreachService } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';
import { RefreshToken } from '@mova-back/shared-database';

import { MetricsModule } from '../metrics/metrics.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FetchGoogleTokenVerifier } from './google/fetch-google-token-verifier';
import { GOOGLE_TOKEN_VERIFIER } from './google/google-token-verifier';
import { FetchFirebaseTokenVerifier } from './firebase/fetch-firebase-token-verifier';
import { FIREBASE_TOKEN_VERIFIER } from './firebase/firebase-token-verifier';
import { JwtStrategy } from './jwt.strategy';
import { RefreshTokenService } from './refresh-token.service';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    MetricsModule,
    TypeOrmModule.forFeature([RefreshToken]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          expiresIn: config.get('JWT_ACCESS_TTL', { infer: true }),
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    RefreshTokenService,
    PasswordBreachService,
    { provide: GOOGLE_TOKEN_VERIFIER, useClass: FetchGoogleTokenVerifier },
    { provide: FIREBASE_TOKEN_VERIFIER, useClass: FetchFirebaseTokenVerifier },
  ],
  controllers: [AuthController],
  exports: [AuthService, RefreshTokenService, JwtModule],
})
export class AuthModule {}
