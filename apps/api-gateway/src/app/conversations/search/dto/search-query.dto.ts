import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class SearchQueryDto {
  @IsString()
  q!: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({ description: 'ISO date — inclusive lower bound on startedAt' })
  from?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({ description: 'ISO date — inclusive upper bound on startedAt' })
  to?: string;

  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? value : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
