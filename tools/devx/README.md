# devx — local-dev shortcuts as Nx targets

A tiny pseudo-project that exposes the **docker compose** operations
you need during development as **Nx targets**. The point is two-fold:

1. Targets show up in `nx graph` + are discoverable via
   `nx show projects` and IDE Nx Console.
2. Running them through Nx gives you the TUI, parallel streaming and
   structured output — much nicer than juggling 4 terminal tabs.

## Cheatsheet

```sh
# Workspace status (containers + cpu/mem)
npm run status                  # → nx run devx:status

# Stream logs from all services, color-prefixed
npm run logs                    # → nx run devx:logs
npm run logs:errors             # only lines matching error|warn|fatal|fail
npm run tail                    # all three services in parallel, Nx TUI

# Single service
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

## TUI mode

Nx 22 ships a Terminal UI that turns parallel commands into a pane
layout. Enable per-run:

```sh
NX_TUI=true npx nx run-many -t logs --projects=api-gateway,realtime-service,agent-worker
```

`npm run tail` already does this for you.

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

## Why a "fake" project?

The workspace-wide targets (`status`, `logs`, `tail`) need a Nx
project to attach to — they can't live at workspace root. A
zero-source tooling project is the idiomatic Nx way; see also
`@nx/devkit`'s `noopExecutor` pattern.
