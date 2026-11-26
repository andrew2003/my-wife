# Build context is the repository root: docker build -f services/schedule/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/schedule...
ENV NODE_ENV=production
EXPOSE 4004
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/schedule/src/main.ts"]
