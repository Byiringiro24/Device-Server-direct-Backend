# Direct FK WAN Device Management

## Overview

FK terminals connect directly to the FK Device-Server in WAN mode. The backend discovers terminals from their inbound polls, stores their device IDs, and manages school assignment, display names, commands, and attendance data. No tablet or VPN relay is part of this flow.

## API Summary

- `GET /api/v1/devices` — list devices available to the current school
- `POST /api/v1/devices` — register a direct device record when needed
- `PATCH /api/v1/devices/:id` — update device metadata
- `GET /api/v1/devices/live-status` — read online state from the direct Device-Server
- `POST /api/v1/devices/:id/push-students` — push selected, class-based, or all students to a device
- `GET /api/v1/devices/:id/status` — read the latest heartbeat/status
- `GET /api/v1/devices/:id/logs` — list attendance logs stored for the device
- `POST /api/v1/devices/:id/logs` — persist a device attendance log

## Notes

- The FK Device-Server listener port is configured independently from the EcaAfrica API port. The current deployment uses TCP `8005` for the device listener.
- Device status comes from the direct WAN heartbeat and is refreshed automatically.
- Super Admin assigns discovered devices to schools and can give each device a recognizable name.
