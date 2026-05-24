# Contributing to Mova

Short guide. Read alongside the per-area `README.md` files
(`infra/README.md`, `infra/vps/README.md`).

## Branch flow

- `master` — protected. Direct push disallowed; everything lands via PR.
- `feat/<short-name>` — feature branches. CI runs on push.
- PR target is always `master`. Squash-merge preferred so the merge
  commit body carries the full story.

## Commit messages

Imperative, ≤72 chars subject, blank line, then a body explaining WHY.
Use `Co-Authored-By:` trailers for pairing. Tag the affected area in
the subject when the diff spans more than the obvious one:

```
billing: harden FREE branch with SQL CAS (defence in depth)

Phase 2.3 / 2.4 already prevent the parallel-charge race at the
application layer, but a CAS in the UPDATE statement closes the
last theoretical window — and surfaces a typed
InsufficientBalanceError instead of silent quota overshoot if
upstream guards leak.
```

## Code style

- Strict TypeScript everywhere (`strict: true` in tsconfig). No `any`
  in production code; if you must, justify it in a comment.
- No `// eslint-disable` without a one-line "why".
- Comments explain WHY, not WHAT. The diff already shows what
  changed; the comment should tell a future reader the constraint
  they're not seeing.
- Skim the surrounding file's comment density before adding more —
  this repo runs heavier on comments than most because the call-flow
  invariants are subtle. Match the local style.

## Tests

- Every PR that touches a service runs the full `nx affected --target=test`
  + lint + build via CI.
- New behaviour ⇒ a spec. Bug fix ⇒ a regression spec.
- Test the **behaviour** observable from the public method (events
  published, state mutations, audit-log rows). Don't test SDK
  internals — they change, your test breaks, the bug you cared about
  ships unguarded.
- Specs live next to the source (`foo.service.spec.ts` next to
  `foo.service.ts`).

## Database migrations

The schema-of-record lives in `libs/shared-database/src/lib/migrations/`.
There is NO `synchronize: true` in production — every schema change is
a reviewed migration.

### Workflow

1. Edit the relevant `@Entity()` class.
2. Generate a candidate migration:
   ```bash
   npm run migration:generate -- src/lib/migrations/<descriptive-name>
   ```
3. **Read the generated SQL** carefully. TypeORM's generator does the
   right thing most of the time but occasionally produces destructive
   diffs (DROP-then-RECREATE for a column type change). Hand-edit
   into a non-destructive form before committing.
4. Apply locally + verify the app still boots:
   ```bash
   npm run migration:run
   docker compose restart api-gateway
   ```
5. Commit the migration alongside the entity change. **Never split
   them** — a PR that ships the entity without the migration breaks
   prod boot.

### Backward-compat rule: contract / expand

Anything that could be in-flight during a deploy MUST be backward-
compatible across the deploy window. The pattern is two PRs:

1. **Expand** — add the new shape alongside the old. New column is
   `NULLABLE` with a default, or a new table, or a new index. The
   application reads from BOTH (new if present, fall back to old)
   and writes to BOTH. Ships and runs in prod.
2. **Backfill** — populate the new shape from the old in batches.
   Either a one-shot script or a Phase-8 cron. Verifies completeness
   by counting `WHERE new IS NULL`.
3. **Contract** — once the backfill is verified, drop the old
   column / table. Application reads/writes only the new shape.
   Ships as a separate PR.

Single-PR destructive migrations are allowed ONLY for:
- New tables (no existing reader/writer).
- New columns added as `NULLABLE` with no default value change.
- Index additions / drops on a non-locking column (concurrent
  CREATE INDEX where the column already exists).

### CI gate

`.github/workflows/ci.yml` runs `npm run migration:run` against a
fresh Postgres in CI. A migration that fails to apply on an empty
DB will block the PR — but it WON'T catch "this migration takes a
30-minute exclusive lock on a 50M-row table". Eyeball that yourself
before shipping anything that does:

- `ALTER TABLE ... ADD COLUMN ... NOT NULL` (rewrites every row)
- `ALTER TABLE ... ALTER COLUMN ... TYPE` (also rewrites)
- `CREATE INDEX` without `CONCURRENTLY`

The migration safety policy is intentionally short — there's no
substitute for thinking. When in doubt, ask in PR review before
running.

## Security-touching code

If your PR touches any of:

- `apps/api-gateway/src/app/admin/`
- `apps/api-gateway/src/app/auth/`
- `libs/shared-auth/`
- `libs/shared-config/src/lib/env.validation.ts` (env shape)
- `apps/*/src/main.ts` (helmet / cors / process guards)

…tag the PR title with `[security]` and request explicit review.
Don't squash-merge until the security reviewer signs off, even on a
green CI.

## Adding a dependency

`npm install` and commit `package-lock.json`. PR description must
explain WHY this dep over alternatives — bundle size, license,
maintenance status. Reject net-new deps that are < 1y old or have
< 100 GitHub stars unless the alternative is "write it ourselves
in 200 lines" (in which case, do that instead).

For the workspace structure: the root `package.json` is canonical.
`apps/admin/package-lock.json` is auto-generated noise — `.gitignore`
should keep it out.

## Release / deploy

`master` push → GitHub Actions `Deploy` workflow → builds three
GHCR images → SSH deploy to the VPS. See `infra/vps/README.md` for
the full pipeline, secrets list, and rollback recipe.
