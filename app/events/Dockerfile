FROM node:22-alpine AS base
WORKDIR /app

FROM base AS dev
COPY package.json yarn.lock ./
RUN yarn install
COPY . .
CMD ["npx", "tsx", "watch", "src/index.ts"]

FROM base AS build
COPY package.json yarn.lock ./
RUN yarn install
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM base AS prod
COPY package.json yarn.lock ./
RUN yarn install --production
COPY --from=build /app/dist/ dist/
CMD ["node", "dist/index.js"]
