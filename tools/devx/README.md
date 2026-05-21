# devx — local-dev shortcuts as Nx targets

A tiny pseudo-project that exposes the **docker compose** operations
you need during development as **Nx targets**. The point is two-fold:

1. Targets show up in `nx graph` + are discoverable via
   `nx show projects` and IDE Nx Console.
2. Running them through Nx gives you the TUI, parallel streaming and
   structured output — much nicer than juggling 4 terminal tabs.

## Cheatsheet

```sh
# One-shot: reset any stuck Nx lock → boot the whole stack →
# open browser logs. Use this 90% of the time.
npm run dev

# Workspace status (containers + cpu/mem)
npm run status                  # → nx run devx:status

# Stream logs from all services, color-prefixed in terminal
npm run logs                    # → nx run devx:logs
npm run logs:errors             # only lines matching error|warn|fatal|fail
npm run tail                    # all three services in parallel, Nx TUI

# Web log viewer (Dozzle) — opens http://localhost:9999
npm run logs:web                # auto-opens browser

# Single service in terminal
npm run logs:api                # → nx run api-gateway:logs
npm run logs:realtime           # → nx run realtime-service:logs
npm run logs:agent              # → nx run agent-worker:logs

# Restart
npm run restart                 # → nx run devx:restart:all (api + rt + agent)
npm run restart:agent           # one service

# Shell into a container
npm run sh:api
npm run sh:realtime
npm run sh:agent

# Project graph (visual)
npm run graph
```

## Browser log viewer — Dozzle

`npm run docker:up` boots a `dozzle` container alongside the app
stack. Open **<http://localhost:9999>** (or `npm run logs:web` —
auto-opens the browser).

- Live tail with search, regex filter and per-container split panes.
- Sees only our containers (filtered by `name=mova_*`), not unrelated
  Docker stuff on your machine.
- Read-only mount of `/var/run/docker.sock` — never writes.
- Bound to `127.0.0.1` only. Don't expose 9999 publicly.

Dozzle is dev-only — it's defined in `docker-compose.override.yml`,
so `docker compose -f docker-compose.yml up` (prod profile) doesn't
bring it up.

## TUI mode (terminal)

Nx 22 ships a Terminal UI that turns parallel commands into a pane
layout. Enable per-run:

```sh
cross-env NX_TUI=true npx nx run-many -t logs --projects=api-gateway,realtime-service,agent-worker
```

`npm run tail` already does this for you (cross-env makes it work on
Windows PowerShell too).

## Per-project targets

Each backend app (`api-gateway`, `realtime-service`, `agent-worker`)
inherits the same four targets — defined inline in their
`project.json`:

| Target    | What it does                                   |
| --------- | ---------------------------------------------- |
| `logs`    | `docker compose logs -f --tail=200 <service>`  |
| `ps`      | `docker compose ps <service>`                  |
| `restart` | `docker compose restart <service>`             |
| `sh`      | `docker compose exec <service> sh`             |

So `nx run agent-worker:logs` works without writing the docker
command yourself, and Nx Console / IDE will surface it.

## Troubleshooting

### `Waiting for api-gateway:serve:development in another nx process`

Nx daemon caches a lock file for continuous tasks (`serve`,
`watch`, …). If a previous `nx serve` was killed un-gracefully
(Ctrl-C in a terminal that didn't propagate, container restart,
laptop sleep), the lock survives and the next invocation blocks
forever waiting for the "still-running" task.

**Fix:**
```sh
npm run nx:reset
```

That clears `.nx/workspace-data/` and stops the daemon. The next
`nx ...` call boots a fresh daemon — the lock is gone.

Note: in our dev setup, `nx serve api-gateway` runs **inside** the
container (see `docker-compose.override.yml`). You should not need
to run it from the host. If you did and it got stuck, `nx reset`
on the host is the cleanup.

### Dozzle shows "no containers"

Make sure `docker compose up` finished and at least one `mova_*`
container is running (`npm run status`). The `DOZZLE_FILTER` env
var keeps the dashboard scoped to our project — if you renamed any
container, the filter regex in `docker-compose.override.yml` needs
to be updated too.

## Why a "fake" project?

The workspace-wide targets (`status`, `logs`, `tail`) need a Nx
project to attach to — they can't live at workspace root. A
zero-source tooling project is the idiomatic Nx way; see also
`@nx/devkit`'s `noopExecutor` pattern.
