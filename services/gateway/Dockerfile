# Build context is the repository root: docker build -f services/gateway/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/gateway...
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/gateway/src/main.ts"]
