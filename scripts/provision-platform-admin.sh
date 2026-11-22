#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

read -r -p 'Primary platform admin email: ' PLATFORM_ADMIN_EMAIL
read -r -s -p 'Primary platform admin password: ' PLATFORM_ADMIN_PASSWORD
printf '\n'
export PLATFORM_ADMIN_EMAIL PLATFORM_ADMIN_PASSWORD
cleanup() { unset PLATFORM_ADMIN_EMAIL PLATFORM_ADMIN_PASSWORD; }
trap cleanup EXIT

npm run platform-admin:provision
