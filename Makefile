# ============================================================================
# Mova Backend — Common operations shortcuts
# ============================================================================
#
# Run `make help` to see what's available.
#
# These wrap docker compose + nx + npm so you don't have to remember the long
# forms. Everything works on macOS, Linux, and Windows (WSL2 / Git Bash).
# ============================================================================

.PHONY: help bootstrap up down restart logs ps build rebuild \
        migrate migrate-revert migrate-show \
        sh-api sh-agent sh-realtime sh-redis sh-pg \
        lint test e2e clean nuke

# Use ` ` (backtick) syntax-friendly defaults
COMPOSE := docker compose

help: ## Show this help (default target)
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── First-time setup ──────────────────────────────────────────────────────
bootstrap: ## First-time setup: copy .env.example → .env if missing, then `up`
	@test -f .env || (cp .env.example .env && \
	  echo "Created .env from .env.example — fill REQUIRED keys then re-run \`make up\`" && \
	  exit 1)
	@$(MAKE) up

# ── Lifecycle ─────────────────────────────────────────────────────────────
up: ## Start all services in the background (dev mode with hot reload)
	$(COMPOSE) up -d --build

up-prod: ## Start prod-shaped stack (no dev override, no hot reload)
	$(COMPOSE) -f docker-compose.yml up -d --build

down: ## Stop and remove containers (keeps volumes)
	$(COMPOSE) down

nuke: ## Stop everything AND wipe volumes + caches (full reset)
	$(COMPOSE) down -v
	rm -rf dist .nx tmp

restart: ## Restart a service. Usage: make restart svc=api-gateway
	$(COMPOSE) restart $(svc)

ps: ## Show running containers
	$(COMPOSE) ps

logs: ## Tail logs of all services
	$(COMPOSE) logs -f --tail=100

logs-api: ## Tail api-gateway logs only
	$(COMPOSE) logs -f --tail=100 api-gateway

logs-agent: ## Tail agent-worker logs only
	$(COMPOSE) logs -f --tail=100 agent-worker

logs-realtime: ## Tail realtime-service logs only
	$(COMPOSE) logs -f --tail=100 realtime-service

# ── Build ─────────────────────────────────────────────────────────────────
build: ## Rebuild images (without starting)
	$(COMPOSE) build

rebuild: ## Force-rebuild from scratch (no cache)
	$(COMPOSE) build --no-cache

# ── Migrations ────────────────────────────────────────────────────────────
migrate: ## Run pending TypeORM migrations
	$(COMPOSE) run --rm migrations

migrate-revert: ## Revert the most recent migration
	$(COMPOSE) run --rm --entrypoint "" migrations \
	  npx typeorm-ts-node-commonjs migration:revert \
	  -d libs/shared-database/src/data-source.ts

migrate-show: ## Show migration status (executed + pending)
	$(COMPOSE) run --rm --entrypoint "" migrations \
	  npx typeorm-ts-node-commonjs migration:show \
	  -d libs/shared-database/src/data-source.ts

# ── Shells (handy for debugging) ──────────────────────────────────────────
sh-api: ## Open a shell inside api-gateway
	$(COMPOSE) exec api-gateway sh

sh-agent: ## Open a shell inside agent-worker
	$(COMPOSE) exec agent-worker sh

sh-realtime: ## Open a shell inside realtime-service
	$(COMPOSE) exec realtime-service sh

sh-redis: ## Open redis-cli (auth via $REDIS_PASSWORD inside container)
	$(COMPOSE) exec redis sh -c 'redis-cli -a "$$REDIS_PASSWORD" --no-auth-warning'

sh-pg: ## Open psql against the dev DB
	$(COMPOSE) exec postgres psql -U postgres -d mova_dev

# ── Quality checks (on host, faster than via container) ───────────────────
lint: ## Lint all projects
	npx nx run-many -t lint

test: ## Run unit tests for all projects
	npx nx run-many -t test --passWithNoTests

build-nx: ## Build all apps (host-side, no Docker)
	npx nx run-many -t build

clean: ## Clean Nx cache + build outputs (host-side)
	rm -rf dist .nx tmp coverage
