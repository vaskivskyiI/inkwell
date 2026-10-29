# Inkwell server + web UI (works with podman build and docker build)
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund -w server -w web
COPY server server
COPY web web
RUN npm run build -w web && npm prune --omit=dev -w server

FROM docker.io/library/node:24-bookworm-slim
ENV NODE_ENV=production INKWELL_DATA_DIR=/data INKWELL_PORT=8080 INKWELL_HOST=0.0.0.0 INKWELL_WEB_DIR=/app/web/dist
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server server
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
