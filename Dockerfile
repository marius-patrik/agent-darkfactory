FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY .agents/.global ./.agents/.global
COPY .github/workflows/vibe-bot-bootstrap.yml ./.github/workflows/vibe-bot-bootstrap.yml
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/.agents/.global ./.agents/.global
COPY --from=build /app/.github/workflows/vibe-bot-bootstrap.yml ./.github/workflows/vibe-bot-bootstrap.yml
EXPOSE 3000
CMD ["node", "dist/index.js"]
