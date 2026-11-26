# Build context is the repository root: docker build -f services/sync/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/sync...
ENV NODE_ENV=production
EXPOSE 4009
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/sync/src/main.ts"]
