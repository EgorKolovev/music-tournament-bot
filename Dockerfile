# Бот работает на Node.js 24 без сборки (type stripping); в образ ставятся только рантайм-зависимости.
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

USER node

ENV TMP_DIR=/tmp/audio \
    NODE_ENV=production

CMD ["node", "src/telegram/main.ts"]
