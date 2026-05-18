# --- Stage 1: OS Base ---
# Створюємо єдиний фундамент із системними залежностями для збірки та рантайму
FROM node:20-bookworm-slim AS os-base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    openssl \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# --- Stage 2: Dependencies ---
FROM os-base AS base
COPY package.json package-lock.json ./
# `--legacy-peer-deps` is required by the keyv / reflect-metadata peer-dep
# tangle in this monorepo. npm@10's strict ci would refuse the install
# otherwise. Same flag is enforced in CI.
RUN npm ci --legacy-peer-deps

# --- Stage 3: Builder ---
FROM base AS builder
COPY . .
ARG APP_NAME
# Використовуємо кешовані залежності та збираємо конкретний додаток Nx
RUN npx nx build ${APP_NAME} --configuration=production

# --- Stage 4: Runner ---
# Наслідуємо os-base, щоб зберегти openssl та сертифікати у фінальному образі
FROM os-base AS runner
WORKDIR /app
ARG APP_NAME
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# Копіюємо ВМІСТ папки додатку прямо в папку /dist, роблячи структуру "пласкою" (flattened)
COPY --from=builder /app/dist/apps/${APP_NAME} ./dist

# Створюємо непривілейованого користувача для безпеки (Principle of Least Privilege)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs
USER nestjs

# Єдиний правильний CMD, який вказує на пласку структуру
CMD ["node", "dist/main.js"]
