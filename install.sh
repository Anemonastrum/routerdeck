#!/bin/sh
set -eu

IMAGE="anemonastrum/routerdeck:${ROUTERDECK_TAG:-latest}"
INSTALL_DIR="${ROUTERDECK_DIR:-$HOME/routerdeck}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/compose.yaml"
PORT="${ROUTERDECK_PORT:-8080}"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif command -v docker >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
else
  printf '%s\n' 'Docker is required and must be running: https://docs.docker.com/engine/install/' >&2
  exit 1
fi

if ! $DOCKER compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker Compose plugin is required: https://docs.docker.com/compose/install/' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
umask 077

if [ ! -f "$ENV_FILE" ]; then
  ADMIN_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  APP_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  cat > "$ENV_FILE" <<EOF
ADMIN_PASSWORD=$ADMIN_PASSWORD
APP_SECRET=$APP_SECRET
ROUTERDECK_PORT=$PORT
EOF
  CREATED_PASSWORD=1
else
  CREATED_PASSWORD=0
fi

cat > "$COMPOSE_FILE" <<EOF
services:
  routerdeck:
    image: $IMAGE
    container_name: routerdeck
    restart: unless-stopped
    environment:
      PORT: 8080
      ADMIN_PASSWORD: \${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      APP_SECRET: \${APP_SECRET:?Set APP_SECRET in .env}
      DB_PATH: /data/routerdeck.db
      COOKIE_SECURE: \${COOKIE_SECURE:-false}
    ports:
      - "\${ROUTERDECK_PORT:-8080}:8080"
    volumes:
      - routerdeck-data:/data

volumes:
  routerdeck-data:
EOF

$DOCKER compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
$DOCKER compose --project-directory "$INSTALL_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

printf '\nRouterDeck started: http://localhost:%s\n' "$(sed -n 's/^ROUTERDECK_PORT=//p' "$ENV_FILE")"
printf 'Install directory: %s\n' "$INSTALL_DIR"
if [ "$CREATED_PASSWORD" -eq 1 ]; then
  printf 'Admin password: %s\n' "$ADMIN_PASSWORD"
  printf 'Credentials saved in %s\n' "$ENV_FILE"
else
  printf 'Existing credentials kept in %s\n' "$ENV_FILE"
fi
