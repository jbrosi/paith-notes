FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
# src/ is bind-mounted at runtime; tsx --watch handles reloading
EXPOSE 3000
CMD ["yarn", "dev"]

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:22-alpine AS prod
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
