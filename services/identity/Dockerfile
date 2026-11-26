# Build context is the repository root: docker build -f services/identity/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/identity...
ENV NODE_ENV=production
EXPOSE 4001
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/identity/src/main.ts"]
