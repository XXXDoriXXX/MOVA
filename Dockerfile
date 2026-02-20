# --- Stage 1: Base ---
FROM node:20-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: Builder ---
FROM base AS builder
WORKDIR /app
# Виправлено синтаксичну помилку: COPY має бути в один рядок
COPY . .

ARG APP_NAME
RUN npx nx build ${APP_NAME} --configuration=production

# --- Stage 3: Runner ---
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ARG APP_NAME
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Копіюємо ВМІСТ папки додатку прямо в папку /dist, роблячи структуру "пласкою" (flattened)
COPY --from=builder /app/dist/apps/${APP_NAME} ./dist

# Створюємо непривілейованого користувача для безпеки (Best Practice)
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nestjs
USER nestjs

# Єдиний правильний CMD, який вказує на пласку структуру
CMD ["node", "dist/main.js"]
