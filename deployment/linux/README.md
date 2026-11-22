# EcaAfrica direct FK WAN deployment

## Communication path

FK terminals run in WAN mode and initiate TCP connections to the FK Device-Server on the public server address. The Device-Server records device IDs from those polls and holds queued commands. EcaAfrica's backend connects to that Device-Server over localhost to list devices, queue commands, and read attendance. No tablet bridge, tablet IP, VPN, or WireGuard interface participates in this path.

```text
FK terminal (WAN) ──TCP──> public server:8005 (FK Device-Server)
EcaAfrica backend ──HTTP localhost──> 127.0.0.1:8005
Browser ──HTTPS──> EcaAfrica API ──> FK Device-Server ──queued reply on device poll──> FK terminal
```

## Required server setup

- Run the FK Device-Server as a persistent service bound to `0.0.0.0:8005`.
- Permit inbound TCP `8005` through both the host firewall and provider firewall.
- Set FK terminals to WAN mode with the server's public IP and port `8005`.
- Keep the management API reachable only from localhost or a trusted private network. Configure `FK_DEVICE_SERVER_URL=http://127.0.0.1:8005` in the EcaAfrica backend environment. Set `FK_DEVICE_SERVER_TOKEN` only if the Device-Server requires it.
- Configure the database, app secrets, storage, mail, Redis, and domain values in the existing backend `.env`. Never commit that file.
- No tablet service or WireGuard package, key, port, or configuration is needed for FK terminals.

## Testing/staging deployment

Run on the Linux server as root after confirming the Device-Server health check succeeds:

```bash
DEPLOY_DIR="$(mktemp -d /tmp/eca-deploy.XXXXXX)"
git clone --depth 1 --branch main https://github.com/Byiringiro24/Device-Server-direct-Backend.git "$DEPLOY_DIR"
bash "$DEPLOY_DIR/deployment/linux/deploy-testing.sh"
```

The script deploys the configured backend and frontend repositories under `/var/www/testing/backend` and `/var/www/testing/frontend`, preserves the existing `.env` files, backs up the current app and local PostgreSQL database, builds before switching app directories, then checks both backend health endpoints and Nginx. It expects the existing FK Device-Server at `127.0.0.1:8005`; it does not install, stop, or reconfigure that service.

## Checks

```bash
systemctl is-active fk-direct
curl -fsS http://127.0.0.1:8005/health
ss -ltnp | grep ':8005'
curl -fsS http://127.0.0.1:5501/api/v1/health
curl -fsS http://127.0.0.1:5600/api/v1/health
```

Use the Super Admin **Direct WAN Devices** page to confirm automatic discovery, rename terminals, and assign each one to a school. A terminal appears online only after it has polled the Device-Server within the configured online window.
