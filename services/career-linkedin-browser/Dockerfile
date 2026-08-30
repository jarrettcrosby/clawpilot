FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DISPLAY=:99 \
    VNC_PORT=5900 \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /service

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      chromium \
      fonts-liberation \
      tini \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chown -R node:node /service

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=12s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/service/docker-entrypoint.sh"]
