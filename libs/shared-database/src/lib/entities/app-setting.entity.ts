import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'app_setting' })
@Index('idx_app_setting_updated', ['updatedAt'])
export class AppSetting {
  @PrimaryColumn('varchar', { length: 80 })
  key!: string;

  @Column('text', { name: 'value_encrypted' })
  valueEncrypted!: string;

  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
