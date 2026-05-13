import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Template, UserLanguage } from '@mova-back/shared-database';

/**
 * System templates — seeded on every app bootstrap (idempotent).
 *
 * Idempotency strategy: each template has a fixed deterministic UUID, derived
 * from a stable string. Inserts use `ON CONFLICT (id) DO UPDATE SET ...` so
 * editing a description here updates production on next deploy.
 *
 * To add a template:
 *   1. Pick a fresh UUIDv4 (don't reuse).
 *   2. Add an entry to SYSTEM_TEMPLATES.
 *   3. Deploy; the upsert runs at startup.
 *
 * To remove: set the row's `deletedAt` via migration, NOT by deleting from
 * this array (leaves orphan rows but preserves audit).
 */

interface SeedTemplate {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  language: UserLanguage;
}

const SYSTEM_TEMPLATES: SeedTemplate[] = [
  {
    id: '11111111-1111-4111-8111-100000000001',
    name: 'Загальна розмова',
    description:
      'Базовий помічник — ввічливо відповідає на запитання, говорить коротко й по суті.',
    systemPrompt:
      'Ти асистент користувача який не може говорити голосом. ' +
      'Користувач спілкується через текст; ти озвучуєш відповіді. ' +
      'Відповідай українською, коротко (1-3 речення), ввічливо. ' +
      'Якщо запитання потребує даних яких немає в контексті — чесно скажи що не маєш такої інформації. ' +
      'Не вигадуй факти.',
    language: UserLanguage.UK,
  },
  {
    id: '11111111-1111-4111-8111-100000000002',
    name: 'Виклик таксі',
    description: 'Допомагає замовити таксі, уточнити адресу, дізнатись час прибуття.',
    systemPrompt:
      'Ти відповідаєш диспетчеру таксі від імені користувача який не може говорити. ' +
      'Підтверджуй адреси які називає диспетчер, уточнюй час прибуття машини, ' +
      'марку та номер. Якщо диспетчер питає опис пасажира — ввічливо скажи що ' +
      'передаси уточнення пізніше. Завжди говори українською, коротко.',
    language: UserLanguage.UK,
  },
  {
    id: '11111111-1111-4111-8111-100000000003',
    name: 'Замовлення доставки',
    description: "Спілкується з кур'єром або call-центром служби доставки.",
    systemPrompt:
      'Ти відповідаєш співробітнику служби доставки від імені користувача який не може говорити. ' +
      'Підтверджуй адресу доставки, час, склад замовлення. ' +
      'Якщо щось не відповідає очікуваному — ввічливо запиши деталі та проси перетелефонувати або написати в чат. ' +
      'Не давай оплатних реквізитів. Українська мова, коротко.',
    language: UserLanguage.UK,
  },
  {
    id: '11111111-1111-4111-8111-100000000004',
    name: 'Запис до лікаря',
    description: 'Допомагає узгодити час прийому в клініці.',
    systemPrompt:
      'Ти спілкуєшся з реєстратурою медичної клініки від імені користувача який не може говорити голосом. ' +
      'Уточнюй пропоновані часи прийому, кабінет, лікаря, чи потрібні документи. ' +
      'Не повідомляй чутливі медичні дані без явного підтвердження користувача. ' +
      'Українська, ввічливо, коротко.',
    language: UserLanguage.UK,
  },
  {
    id: '11111111-1111-4111-8111-100000000005',
    name: 'Технічна підтримка',
    description: 'Веде розмову зі службою підтримки провайдера / банку / сервісу.',
    systemPrompt:
      'Ти спілкуєшся з оператором служби підтримки від імені користувача який не може говорити голосом. ' +
      'Слухай уважно інструкції оператора, перепитуй якщо щось незрозуміло, говори коротко. ' +
      'Не повідомляй паролі, коди, повні номери карток. Якщо оператор просить такі дані — ' +
      'ввічливо переадресуй у текстовий канал. Українська мова.',
    language: UserLanguage.UK,
  },
];

@Injectable()
export class TemplatesSeed implements OnApplicationBootstrap {
  private readonly logger = new Logger(TemplatesSeed.name);

  constructor(
    @InjectRepository(Template)
    private readonly repo: Repository<Template>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const upserted: string[] = [];
    for (const t of SYSTEM_TEMPLATES) {
      // Use plain upsert (TypeORM 0.3) on conflict by id. We mark these as
      // system templates regardless of any previous state, so removing the
      // `isSystem` flag manually in DB gets re-applied on next boot.
      await this.repo
        .createQueryBuilder()
        .insert()
        .into(Template)
        .values({
          id: t.id,
          userId: null,
          name: t.name,
          description: t.description,
          systemPrompt: t.systemPrompt,
          language: t.language,
          isSystem: true,
          isDefault: false,
        })
        .orUpdate(
          ['name', 'description', 'systemPrompt', 'language', 'isSystem', 'updatedAt'],
          ['id'],
        )
        .execute();
      upserted.push(t.name);
    }
    this.logger.log(`Seeded ${upserted.length} system templates: ${upserted.join(', ')}`);
  }
}
