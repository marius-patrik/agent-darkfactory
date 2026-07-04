FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV DARK_FACTORY_WORKSPACE_ROOT=/app/data-agentos/managed-repository
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY data-agentos/managed-repository ./data-agentos/managed-repository
EXPOSE 3000
CMD ["node", "dist/cli.js", "serve"]
