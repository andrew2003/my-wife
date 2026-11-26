# Build context is the repository root: docker build -f services/ingest/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/ingest...
ENV NODE_ENV=production
EXPOSE 4003
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/ingest/src/main.ts"]
