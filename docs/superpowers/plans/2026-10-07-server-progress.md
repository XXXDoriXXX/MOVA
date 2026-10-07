# Progress: server production
User approved the audited design; domain mova.dehimik.org; no users or backups required.
Task 1 complete: all lint/build/type checks and 312 tests passed locally; email provider failure now returns an error without leaking links.
Task 2 complete: five Docker images built; 29 migrations applied to an empty isolated database, repeat is a no-op; all six persistent services healthy locally.
Task 3 in progress: GitHub-hosted builds + restricted SSH deployment, public Cloudflare route awaiting account access.
Ruling: Work on deploy/server in the existing clean checkout. Only deployment-blocking fixes, no broad refactor.
Review: independent agent caught shared-IP throttling and temporary branch deletion breaking master deploy; both fixed.
Ruling: no self-hosted GitHub runner on shared production server/public repository.
