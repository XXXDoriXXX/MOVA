#!/usr/bin/env node
// @ts-check

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

const REPO_ROOT = path.resolve(__dirname, '..');
process.chdir(REPO_ROOT);

function tryRun(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

function ourPublishedPorts(projectName) {
  const ports = new Set();
  const out = tryRun(
    `docker ps --filter "label=com.docker.compose.project=${projectName}" --format "{{.Ports}}"`,
  );
  if (!out) return ports;
  for (const m of out.matchAll(/:(\d+)->/g)) ports.add(Number(m[1]));
  return ports;
}

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
  section('Host toolchain');
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 19)) {
    warn(`Host Node.js is v${process.versions.node} — Nx 22 needs v20.19+ (v20 LTS matches the Docker image)`);
    hint('Install the pinned version (see .nvmrc):  nvm install   # or download Node 20 LTS from nodejs.org');
    hint('Docker builds always use node:20, but host-side nx/typeorm scripts may misbehave on older Node.');
  } else {
    ok(`Host Node.js v${process.versions.node}`);
  }

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

  section('Ports');
  const projectName = path.basename(REPO_ROOT).toLowerCase();
  const ownPorts = ourPublishedPorts(projectName);
  const ports = [
    { port: 5433, svc: 'postgres', level: 'core', hint: 'Stop your local Postgres OR remap the "5433:5432" line in docker-compose.yml.' },
    { port: 6379, svc: 'redis', level: 'core', hint: 'Stop your local Redis OR remap the "6379:6379" line in docker-compose.yml.' },
    { port: 8001, svc: 'redis-stack (RedisInsight UI)', level: 'core', hint: 'Another redis-stack/RedisInsight is running — stop it or remap "8001:8001".' },
    { port: 3000, svc: 'api-gateway', level: 'core', hint: 'Another dev server holds 3000 — close it or remap.' },
    { port: 3002, svc: 'realtime-service', level: 'core', hint: 'Another dev server holds 3002 — close it or remap.' },
    { port: 5174, svc: 'admin (dev)', level: 'core', hint: 'Another Vite/admin server holds 5174 — close it or remap.' },
    { port: 9999, svc: 'dozzle (dev logs UI)', level: 'core', hint: 'Something holds 9999 — close it or remap.' },
    { port: 3030, svc: 'grafana', level: 'obs', hint: 'Remap "127.0.0.1:3030:3000" in docker-compose.yml if you need Grafana.' },
    { port: 9090, svc: 'prometheus', level: 'obs', hint: 'Remap "127.0.0.1:9090:9090" in docker-compose.yml if you need Prometheus.' },
    { port: 9093, svc: 'alertmanager', level: 'obs', hint: 'Remap "127.0.0.1:9093:9093" in docker-compose.yml if you need Alertmanager.' },
    { port: 3100, svc: 'loki', level: 'obs', hint: 'Remap "127.0.0.1:3100:3100" in docker-compose.yml if you need Loki.' },
    { port: 3200, svc: 'tempo', level: 'obs', hint: 'Remap "127.0.0.1:3200:3200" in docker-compose.yml if you need Tempo.' },
  ];
  for (const { port, svc, level, hint: h } of ports) {
    const busy = await isPortInUse(port);
    if (!busy) {
      ok(`Port ${port} free (${svc})`);
      continue;
    }
    if (ownPorts.has(port)) {
      ok(`Port ${port} in use by mova_* (${svc} already up — will be reused)`);
      continue;
    }
    if (level === 'core') fail(`Port ${port} (${svc}) is already in use on the host`);
    else warn(`Port ${port} (${svc}) is already in use on the host`);
    hint(h);
  }

  section('Volumes');
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
