# Build context is the repository root: docker build -f services/monitor/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/monitor...
ENV NODE_ENV=production
EXPOSE 4005
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/monitor/src/main.ts"]
