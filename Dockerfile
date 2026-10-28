# GradeScan API — for any host that runs Docker (your own server, Google Cloud Run, Fly.io, ...).
# Build:  docker build -t gradescan-api .
# Run:    docker run -p 3000:3000 --env-file .env gradescan-api
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
