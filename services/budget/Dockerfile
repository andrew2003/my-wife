# Build context is the repository root: docker build -f services/budget/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/budget...
ENV NODE_ENV=production
EXPOSE 4002
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/budget/src/main.ts"]
