# Build context is the repository root: docker build -f services/notify/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/notify...
ENV NODE_ENV=production
EXPOSE 4008
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/notify/src/main.ts"]
