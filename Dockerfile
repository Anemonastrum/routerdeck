# syntax=docker/dockerfile:1

# Build native Node modules (notably better-sqlite3) in a dedicated stage.
# This works on both amd64 and arm64 and does not depend on a prebuilt binary
# being available/reachable during npm install.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       python3-venv \
       make \
       g++ \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# node-gyp needs Python when better-sqlite3 has to compile from source.
ENV npm_config_python=/usr/bin/python3

# better-sqlite3 13.x uses N-API and ships Linux prebuilds. Keep build tools in
# this stage so npm can still compile a fallback on an unsupported architecture.
RUN npm install --omit=dev \
    && npm cache clean --force \
    && python3 -m venv /opt/pyruijie \
    && /opt/pyruijie/bin/pip install --no-cache-dir --upgrade pyruijie synology-api \
    && /opt/pyruijie/bin/python -c "from importlib.metadata import version; from pyruijie import RuijieClient; from synology_api.core_sys_info import SysInfo; print('Python integrations OK; pyruijie='+version('pyruijie')+'; native_switch_ports='+str(hasattr(RuijieClient, 'get_switch_ports'))+'; native_clients='+str(hasattr(RuijieClient, 'get_clients'))+'; native_gateway_ports='+str(hasattr(RuijieClient, 'get_gateway_ports')))"

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# ping is used by RouterDeck's uptime monitor. Keep only runtime packages here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       iputils-ping \
       python3 \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /opt/pyruijie /opt/pyruijie
COPY package*.json ./
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
