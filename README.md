
# 🎙️ MOVA: Voice Assistant Microservices

This repository contains the backend infrastructure for the **MOVA** service, designed to help hearing-impaired people communicate over the phone. Built on an **Nx** monorepo, **NestJS** framework, and **Docker** containerization, the architecture is focused on high scalability, microservice communication (via Redis), and LiveKit WebRTC integration.

## 🏗️ Architecture Overview

* **API Gateway:** The entry point for client requests. It handles the REST API and manages the lifecycle of LiveKit rooms.
* **Agent Worker:** A background service that connects to LiveKit sessions, processes audio streams, and interacts with the AI.
* **Redis:** The Message Broker used for synchronizing states between microservices (Inter-Process Communication).

## 🚀 Local Development Environment

We utilize an **Environment Agnostic** approach. Instead of installing dependencies and running processes on the host machine, the entire development environment is spun up inside Docker with Hot Reload support.

### Starting the System

To bootstrap the project in development mode, simply run:

```bash
docker compose up

```

**Under the hood:**
Docker automatically merges `docker-compose.yml` and `docker-compose.override.yml`. Instead of building the full production image, the system stops at the `base` stage and mounts your local directory into the container using **Bind Mounts**. Nx watches for file changes and instantly restarts the Node.js processes.

## 🧹 Troubleshooting & Cache Strategy

Because we use cross-platform development (Windows Host -> Linux Container), Nx can sometimes suffer from **Cache Poisoning** or path separator conflicts.

If the services fail to start or get stuck (`Waiting for ... in another nx process`), perform a **Hard Reset**:

1. Stop the containers and destroy all anonymous volumes:
```bash
docker compose down -v

```


2. **Crucial step:** Manually delete the local cache and build folders on your host machine to prevent cross-OS contamination:
* Delete the `dist` folder.
* Delete the hidden `.nx` folder.


3. Restart the system: `docker compose up`. The containers will now generate a clean, isolated Linux cache from scratch.

## 🚢 Production Deployment

The production build utilizes a **Multi-stage Dockerfile**. This approach ensures the smallest possible final image size (low memory footprint), strips out dev dependencies, and guarantees the presence of critical system libraries (like `libssl3` and `ca-certificates` for LiveKit's native FFI modules).

To build and run the clean production environment (ignoring the local development override):

```bash
docker compose -f docker-compose.yml up -d --build

```
