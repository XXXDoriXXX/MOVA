#!/usr/bin/env node
// @ts-check
/**
 * Cross-platform docker-doctor. Diagnoses the most common reasons
 * `npm run docker:up` fails on a fresh checkout, with copy-pasteable
 * fixes per finding. Runs on the host (not inside containers).
 * Idempotent and side-effect-free — only inspects.
 *
 * Same surface as the original POSIX shell script, but uses only
 * Node built-ins so Windows PowerShell / cmd users don't need a
 * `sh` interpreter. Exits 0 on clean / warnings-only, 1 on errors.
 *
 * Covered failure modes:
 *   1. Docker daemon unreachable
 *   2. .npmrc missing (would cause ERESOLVE on plain `npm install`)
 *   3. .env missing or required keys empty
 *   4. SETTINGS_ENCRYPTION_KEY missing (admin Keys page disabled)
 *   5. Host port conflicts (5432 / 6379 / 3000-3002 / 5174 / 9999)
 *   6. Stale postgres / redis compose volumes from a prior killed run
 *   7. Compose containers stuck in exited state
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execSync } = require('node:child_process');

const C = process.stdout.isTTY
  ? {
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      reset: '\x1b[0m',
    }
  : { red: '', green: '', yellow: '', cyan: '', reset: '' };

let errors = 0;
let warnings = 0;

const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const fail = (m) => {
  console.log(`${C.red}✗${C.reset} ${m}`);
  errors += 1;
};
const warn = (m) => {
  console.log(`${C.yellow}!${C.reset} ${m}`);
  warnings += 1;
};
const hint = (m) => console.log(`  ${C.cyan}↳${C.reset} ${m}`);
const section = (m) => console.log(`\n${C.cyan}── ${m} ──${C.reset}`);

// `cwd` is whatever directory the user ran `npm run docker:doctor` from
// — but the script lives in `<repo>/tools/`, and we want repo-relative
// paths. Resolve via `__dirname` (the script's own location).
const REPO_ROOT = path.resolve(__dirname, '..');
process.chdir(REPO_ROOT);

/** Run a shell command, swallow any throw, return trimmed stdout or null. */
function tryRun(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a TCP port is in use on localhost (any interface) by
 * trying to bind to it and seeing if we get EADDRINUSE. We bind to
 * 0.0.0.0 because that's where docker-compose publishes ports —
 * binding only to 127.0.0.1 would miss a service listening on
 * the LAN interface.
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '0.0.0.0');
  });
}

async function main() {
  // ── 1. Docker daemon ──
  section('Docker daemon');
  const dockerVersion = tryRun('docker --version');
  if (!dockerVersion) {
    fail('docker CLI not found in PATH');
    hint('Install Docker Desktop (Windows/Mac) or docker-engine (Linux), then re-run.');
    process.exit(1);
  }
  const dockerInfo = tryRun('docker info', { stdio: ['ignore', 'pipe', 'pipe'] });
  if (dockerInfo === null) {
    fail('Docker daemon not reachable');
    hint('Start Docker Desktop (Windows/Mac) or `sudo systemctl start docker` (Linux).');
    process.exit(1);
  }
  ok(`docker daemon up (${dockerVersion.split(',')[0]})`);

  // ── 2. .npmrc (peer-dep resolution mode) ──
  section('npm config');
  if (!fs.existsSync('.npmrc')) {
    warn('.npmrc missing from repo root');
    hint('Bare `npm install` will fail with ERESOLVE on the livekit-agents peer-dep conflict.');
    hint('Restore with:  git checkout origin/master -- .npmrc');
  } else {
    const npmrc = fs.readFileSync('.npmrc', 'utf8');
    if (!/^\s*legacy-peer-deps\s*=\s*true/m.test(npmrc)) {
      warn(".npmrc exists but doesn't set legacy-peer-deps=true");
      hint('Host `npm install` may fail; Docker bootstrap will still work.');
    } else {
      ok('.npmrc OK (legacy-peer-deps=true)');
    }
  }

  // ── 3. .env ──
  section('Environment');
  if (!fs.existsSync('.env')) {
    fail('.env is missing');
    hint('cp .env.example .env     (PowerShell: Copy-Item .env.example .env)');
    hint('then fill in the keys you have.');
  } else {
    ok('.env present');
    const envText = fs.readFileSync('.env', 'utf8');
    const required = ['DATABASE_URL', 'REDIS_PASSWORD', 'JWT_SECRET', 'LIVEKIT_URL'];
    for (const key of required) {
      const re = new RegExp(`^${key}=.+$`, 'm');
      if (!re.test(envText)) {
        fail(`${key} is missing or empty in .env`);
        hint('see .env.example for the canonical value');
      }
    }
    if (!/^SETTINGS_ENCRYPTION_KEY=.{16,}$/m.test(envText)) {
      warn('SETTINGS_ENCRYPTION_KEY missing or shorter than 16 chars');
      hint("admin Keys page won't work until you set this:");
      hint('  Bash:        echo "SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env');
      hint('  PowerShell:  $k = [Convert]::ToBase64String((1..32 | %{ Get-Random -Max 256 })); Add-Content .env "SETTINGS_ENCRYPTION_KEY=$k"');
    }
  }

  // ── 4. Port conflicts ──
  section('Ports');
  const ports = [5432, 6379, 3000, 3001, 3002, 5174, 9999];
  for (const port of ports) {
    const busy = await isPortInUse(port);
    if (busy) {
      fail(`Port ${port} is already in use on the host`);
      if (port === 5432) hint('Stop your local postgres OR change the published port in docker-compose.yml.');
      else if (port === 6379) hint('Stop your local redis OR change the published port in docker-compose.yml.');
      else hint(`Another dev server is using ${port} — close it or remap.`);
    } else {
      ok(`Port ${port} is free`);
    }
  }

  // ── 5. Stale volumes ──
  section('Volumes');
  const projectName = path.basename(REPO_ROOT).toLowerCase();
  const volumeList = tryRun('docker volume ls -q');
  const ourVolumes = (volumeList ?? '')
    .split('\n')
    .filter((v) =>
      new RegExp(`^${projectName.replace(/[^a-z0-9-_]/gi, '.')}_(postgres_data|redis_data)$`).test(v),
    );
  if (ourVolumes.length > 0) {
    ok("Compose volumes exist (will reuse on next 'up')");
    ourVolumes.forEach((v) => console.log(`  ${C.cyan}↳${C.reset} ${v}`));
    hint(`If postgres won't start, nuke them:  docker volume rm ${ourVolumes.join(' ')}`);
  } else {
    ok('No leftover compose volumes (clean slate)');
  }

  // ── 6. Compose state ──
  section('Compose state');
  const exited = tryRun('docker compose ps --status exited --format {{.Service}}');
  const running = tryRun('docker compose ps --status running --format {{.Service}}');
  const exitedCount = exited ? exited.split('\n').filter(Boolean).length : 0;
  const runningCount = running ? running.split('\n').filter(Boolean).length : 0;
  if (exitedCount > 0) {
    warn(`${exitedCount} compose container(s) in exited state`);
    hint('docker compose ps                            # see which');
    hint('docker compose down && docker compose up   # restart everything');
  }
  if (runningCount > 0) {
    ok(`${runningCount} compose container(s) currently running`);
  } else {
    ok('No compose containers running (nothing to clean up)');
  }

  // ── Summary ──
  section('Summary');
  if (errors > 0) {
    console.log(
      `${C.red}${errors} error(s)${C.reset}, ${C.yellow}${warnings} warning(s)${C.reset} — fix the errors above before retrying \`npm run docker:up\`.`,
    );
    process.exit(1);
  }
  if (warnings > 0) {
    console.log(
      `${C.yellow}${warnings} warning(s)${C.reset} — \`npm run docker:up\` should work, but heed the notes above.`,
    );
    process.exit(0);
  }
  console.log(`${C.green}All checks passed.${C.reset} Run: ${C.cyan}npm run docker:up${C.reset}`);
}

main().catch((err) => {
  console.error(`${C.red}docker-doctor crashed:${C.reset}`, err);
  process.exit(2);
});
