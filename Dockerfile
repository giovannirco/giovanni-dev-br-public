FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# The runtime tree only: the build stage's node_modules carries vite and
# playwright, which have no business in a production image. Until the logger
# arrived the server had no runtime dependency at all and this stage did not
# exist — a missing node_modules would now be a crash loop, not a warning.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/giovannirco/giovanni-dev-br"
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
