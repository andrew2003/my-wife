# Build context is the repository root: docker build -f services/rules/Dockerfile .
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @my-wife/rules...
ENV NODE_ENV=production
EXPOSE 4006
CMD ["node", "--max-old-space-size=192", "--import", "tsx", "services/rules/src/main.ts"]
