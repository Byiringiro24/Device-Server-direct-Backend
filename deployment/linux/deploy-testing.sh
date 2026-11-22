#!/usr/bin/env bash
set -Eeuo pipefail

BACKEND_DIR=/var/www/testing/backend
FRONTEND_DIR=/var/www/testing/frontend
TESTING_PORT=5501
STAGING_PORT=5600
FRONTEND_PORT=4174
TESTING_API=https://testing-api.ecareafrica.net/api/v1
PM2_TESTING_BACKEND=ecare-testing-backend
PM2_STAGING_BACKEND=ecare-staging-backend
PM2_FRONTEND=ecare-testing-frontend

for tool in git node npm pm2 python3 curl sudo pg_dump tar nginx; do
  command -v "$tool" >/dev/null || { echo "Required command is missing: $tool" >&2; exit 1; }
done
if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this deployment script as root.' >&2
  exit 1
fi
if [[ "$BACKEND_DIR" != /var/www/testing/backend || "$FRONTEND_DIR" != /var/www/testing/frontend ]]; then
  echo 'Refusing unexpected deployment paths.' >&2
  exit 1
fi
if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  echo "Required live backend environment file is missing: $BACKEND_DIR/.env" >&2
  exit 1
fi
if ! curl -fsS --max-time 5 http://127.0.0.1:8005/health >/dev/null; then
  echo 'FK WAN Device-Server is not healthy on localhost:8005; refusing application deployment.' >&2
  exit 1
fi
python3 - "$BACKEND_DIR/.env" <<'PY'
import json, pathlib, sys, urllib.request
values = {}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not line or line.lstrip().startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    values[key.strip()] = value.strip().strip('"\'')
base = values.get('FK_DEVICE_SERVER_URL', 'http://127.0.0.1:8005').rstrip('/')
headers = {}
if values.get('FK_DEVICE_SERVER_TOKEN'):
    headers['Authorization'] = 'Bearer ' + values['FK_DEVICE_SERVER_TOKEN']
request = urllib.request.Request(base + '/api/devices', headers=headers)
with urllib.request.urlopen(request, timeout=5) as response:
    devices = json.loads(response.read())
if not isinstance(devices, list):
    raise SystemExit('FK Device-Server /api/devices returned an unexpected response.')
print('FK Device-Server API is reachable; discovered device records:', len(devices))
PY

BACKEND_REPO=https://github.com/Byiringiro24/Device-Server-direct-Backend.git
FRONTEND_REPO=https://github.com/Byiringiro24/Device-Server-direct-frontend.git
BACKEND_BRANCH=main
FRONTEND_BRANCH=main

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="/var/backups/ecareafrica/testing-$STAMP"
STAGE_DIR="/var/www/testing/.deploy-$STAMP"
PREVIOUS_DIR="/var/www/testing/.previous-$STAMP"
mkdir -m 700 -p "$BACKUP_DIR" "$STAGE_DIR/backend" "$STAGE_DIR/frontend" "$PREVIOUS_DIR"
SWAPPED=0
APP_STOPPED=0

rollback() {
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo 'Deployment failed; restoring service availability.' >&2
    if [[ $APP_STOPPED -eq 1 ]]; then
      for app in "$PM2_TESTING_BACKEND" "$PM2_STAGING_BACKEND" "$PM2_FRONTEND"; do
        pm2 delete "$app" >/dev/null 2>&1 || true
      done
      if [[ $SWAPPED -eq 1 ]]; then
        echo 'Restoring the previous application directories.' >&2
        if [[ -d "$PREVIOUS_DIR/backend" ]]; then
          [[ ! -e "$BACKEND_DIR" ]] || mv "$BACKEND_DIR" "$BACKUP_DIR/backend.failed"
          mv "$PREVIOUS_DIR/backend" "$BACKEND_DIR"
        fi
        if [[ -d "$PREVIOUS_DIR/frontend" ]]; then
          [[ ! -e "$FRONTEND_DIR" ]] || mv "$FRONTEND_DIR" "$BACKUP_DIR/frontend.failed"
          mv "$PREVIOUS_DIR/frontend" "$FRONTEND_DIR"
        fi
      fi
      (cd "$BACKEND_DIR" && PORT=$TESTING_PORT NODE_APP_INSTANCE=0 pm2 start dist/server.js --name "$PM2_TESTING_BACKEND" --time) || true
      (cd "$BACKEND_DIR" && PORT=$STAGING_PORT NODE_APP_INSTANCE=1 pm2 start dist/server.js --name "$PM2_STAGING_BACKEND" --time) || true
      pm2 serve "$FRONTEND_DIR/dist" "$FRONTEND_PORT" --name "$PM2_FRONTEND" --spa --time || true
      pm2 save || true
    fi
  fi
  exit "$rc"
}
trap rollback EXIT

echo '[1/6] Backing up current application and database...'
tar -czf "$BACKUP_DIR/current-files.tar.gz" -C /var/www/testing backend frontend
chmod 600 "$BACKUP_DIR/current-files.tar.gz"
DB_NAME=$(python3 - "$BACKEND_DIR/.env" <<'PY'
import pathlib, sys
from urllib.parse import unquote, urlparse
env_file = pathlib.Path(sys.argv[1])
value = next((line.split('=', 1)[1].strip().strip('"\'') for line in env_file.read_text().splitlines()
              if line.startswith('DATABASE_URL=')), '')
parsed = urlparse(value)
if parsed.scheme not in ('postgres', 'postgresql') or parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
    raise SystemExit('Refusing DB backup: DATABASE_URL must point to local PostgreSQL.')
if parsed.port not in (None, 5432) or parsed.username not in (None, 'postgres'):
    raise SystemExit('Refusing DB backup: expected the local postgres account on port 5432.')
name = unquote(parsed.path.lstrip('/'))
if not name or '/' in name:
    raise SystemExit('Refusing DB backup: database name is missing or invalid.')
print(name)
PY
)
sudo -u postgres pg_dump -Fc "$DB_NAME" > "$BACKUP_DIR/database.dump"
chmod 600 "$BACKUP_DIR/database.dump"

echo '[2/6] Cloning the configured GitHub main branches...'
git clone --depth 1 --branch "$BACKEND_BRANCH" "$BACKEND_REPO" "$STAGE_DIR/backend"
git clone --depth 1 --branch "$FRONTEND_BRANCH" "$FRONTEND_REPO" "$STAGE_DIR/frontend"
cp -a "$BACKEND_DIR/.env" "$STAGE_DIR/backend/.env"
if [[ -f "$FRONTEND_DIR/.env" ]]; then cp -a "$FRONTEND_DIR/.env" "$STAGE_DIR/frontend/.env"; fi
chmod 600 "$STAGE_DIR/backend/.env"
if ! grep -q '^FK_DEVICE_SERVER_URL=' "$STAGE_DIR/backend/.env"; then
  printf '\nFK_DEVICE_SERVER_URL=http://127.0.0.1:8005\n' >> "$STAGE_DIR/backend/.env"
fi
[[ -f "$STAGE_DIR/backend/package.json" && -f "$STAGE_DIR/backend/src/server.ts" ]] || { echo 'Backend archive layout is invalid.' >&2; exit 1; }
[[ -f "$STAGE_DIR/frontend/package.json" && -f "$STAGE_DIR/frontend/vite.config.ts" ]] || { echo 'Frontend archive layout is invalid.' >&2; exit 1; }

echo '[3/6] Installing dependencies and building both applications...'
(cd "$STAGE_DIR/backend" && npm ci && npm run prisma:generate && npm run build)
(cd "$STAGE_DIR/frontend" && npm ci && VITE_API_BASE_URL="$TESTING_API" npm run build)

echo '[4/6] Applying database migrations after backup...'
for app in "$PM2_TESTING_BACKEND" "$PM2_STAGING_BACKEND" "$PM2_FRONTEND"; do
  pm2 stop "$app" >/dev/null 2>&1 || true
done
APP_STOPPED=1
(cd "$STAGE_DIR/backend" && npm run prisma:migrate:deploy)

echo '[5/6] Swapping directories and starting PM2...'
SWAPPED=1
mv "$BACKEND_DIR" "$PREVIOUS_DIR/backend"
mv "$FRONTEND_DIR" "$PREVIOUS_DIR/frontend"
mv "$STAGE_DIR/backend" "$BACKEND_DIR"
mv "$STAGE_DIR/frontend" "$FRONTEND_DIR"

for app in "$PM2_TESTING_BACKEND" "$PM2_STAGING_BACKEND" "$PM2_FRONTEND"; do
  pm2 delete "$app" >/dev/null 2>&1 || true
done
(cd "$BACKEND_DIR" && PORT=$TESTING_PORT NODE_APP_INSTANCE=0 pm2 start dist/server.js --name "$PM2_TESTING_BACKEND" --time)
(cd "$BACKEND_DIR" && PORT=$STAGING_PORT NODE_APP_INSTANCE=1 pm2 start dist/server.js --name "$PM2_STAGING_BACKEND" --time)
pm2 serve "$FRONTEND_DIR/dist" "$FRONTEND_PORT" --name "$PM2_FRONTEND" --spa --time
pm2 save

echo '[6/6] Checking local health endpoints and Nginx config...'
for port in "$TESTING_PORT" "$STAGING_PORT"; do
  ok=0
  for _ in {1..20}; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/v1/health" >/dev/null; then ok=1; break; fi
    sleep 2
  done
  [[ $ok -eq 1 ]] || { echo "Backend health check failed on port $port" >&2; exit 1; }
done
curl -fsS --max-time 3 "http://127.0.0.1:$FRONTEND_PORT/" >/dev/null
nginx -t
trap - EXIT
echo "Deployment completed. Backend commit: $(git -C "$BACKEND_DIR" rev-parse --short HEAD); frontend commit: $(git -C "$FRONTEND_DIR" rev-parse --short HEAD)"
echo "Backup: $BACKUP_DIR"
echo 'Only ecare-testing-backend (NODE_APP_INSTANCE=0) runs singleton jobs; staging is set to instance 1.'
