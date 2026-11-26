# Build context is the repository root: docker build -f services/ai/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/ai...
ENV NODE_ENV=production
EXPOSE 4007
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/ai/src/main.ts"]
