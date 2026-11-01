# Carrefour Drive MCP, HTTP mode, with a remote sign-in screen.
#
# The Playwright image ships the exact Chromium that the playwright npm package
# expects (versions must match: see package-lock.json), plus its system
# libraries. On top of it: Xvfb (a virtual screen for the sign-in window),
# x11vnc + noVNC (to see and drive that screen from a phone's browser).

ARG PLAYWRIGHT_VERSION=1.64.1

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && rm -rf dist/__tests__

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify tini \
 && rm -rf /var/lib/apt/lists/* \
 && printf '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=true&amp;resize=scale&amp;reconnect=true&amp;reconnect_delay=1000">\n' \
    > /usr/share/novnc/index.html

WORKDIR /app
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tools ./tools
COPY docker/entrypoint.sh /usr/local/bin/carrefour-entrypoint
RUN chmod +x /usr/local/bin/carrefour-entrypoint

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8787 \
    CARREFOUR_DATA_DIR=/data \
    CARREFOUR_CHROMIUM_NO_SANDBOX=1 \
    CARREFOUR_REMOTE_LOGIN=1 \
    LOG_LEVEL=info

VOLUME /data
EXPOSE 8787 6080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "carrefour-entrypoint"]
