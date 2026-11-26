# Build context is the repository root: docker build -f services/__NAME__/Dockerfile .
FROM node:26-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/__NAME__...
ENV NODE_ENV=production
EXPOSE __PORT__
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/__NAME__/src/main.ts"]
