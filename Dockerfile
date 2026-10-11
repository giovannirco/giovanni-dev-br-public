FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# The runtime tree only: the build stage's node_modules carries vite and
# playwright, which have no business in a production image. Until the logger
# arrived the server had no runtime dependency at all and this stage did not
# exist — a missing node_modules would now be a crash loop, not a warning.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/giovannirco/giovanni-dev-br-public"
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV HOME=/tmp
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN addgroup -S gio && adduser -S -G gio -u 10001 gio
COPY --from=build --chown=gio:gio /app/dist ./dist
COPY --from=build --chown=gio:gio /app/data ./data
COPY --from=build --chown=gio:gio /app/server.mjs ./server.mjs
COPY --from=build --chown=gio:gio /app/src/*.mjs ./src/
COPY --from=build --chown=gio:gio /app/package.json ./package.json
COPY --from=deps --chown=gio:gio /app/node_modules ./node_modules
USER 10001
EXPOSE 8080
CMD ["node", "server.mjs"]
