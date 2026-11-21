import { prisma } from "../database/prisma";
import { AppError } from "../middleware/errorHandler";

const serverBase = (process.env.FK_DEVICE_SERVER_URL || "http://127.0.0.1:8005").replace(/\/$/, "");
const serverToken = process.env.FK_DEVICE_SERVER_TOKEN?.trim();
const requestTimeoutMs = Number(process.env.FK_DEVICE_SERVER_TIMEOUT_MS || 8000);

type WanDevice = {
  deviceId: string;
  name?: string;
  deviceTime?: string;
  info?: Record<string, unknown> | null;
  remoteAddress?: string;
  lastSeen?: string;
  online?: boolean;
};

async function serverRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (serverToken) headers.set("Authorization", `Bearer ${serverToken}`);
  try {
    const response = await fetch(`${serverBase}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    let payload: any;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
    if (!response.ok) {
      throw new AppError("service_unavailable", `FK WAN server returned HTTP ${response.status}`, 502);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("service_unavailable", "FK WAN Device-Server is unreachable", 503);
  }
}

function safeDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deviceIdOk(id: string) {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

export async function syncDiscoveredDevices() {
  const devices = await serverRequest<WanDevice[]>("/api/devices");
  if (!Array.isArray(devices)) throw new AppError("bad_gateway", "FK WAN Device-Server returned an invalid device list", 502);

  for (const device of devices) {
    const id = String(device?.deviceId || "");
    if (!deviceIdOk(id)) continue;
    const deviceName = String(device.name || "FK device").trim().slice(0, 100) || "FK device";
    const info = device.info && typeof device.info === "object" ? device.info : undefined;
    const firmware = typeof info?.firmware === "string" ? info.firmware.slice(0, 100) : null;
    await prisma.fk_wan_devices.upsert({
      where: { device_uid: id },
      create: {
        device_uid: id,
        device_name: deviceName,
        assigned_name: deviceName,
        remote_address: String(device.remoteAddress || "").slice(0, 100) || null,
        firmware_version: firmware,
        device_time: String(device.deviceTime || "").slice(0, 40) || null,
        device_info: info as any,
        is_online: Boolean(device.online),
        last_seen_at: safeDate(device.lastSeen),
      },
      update: {
        device_name: deviceName,
        remote_address: String(device.remoteAddress || "").slice(0, 100) || null,
        firmware_version: firmware,
        device_time: String(device.deviceTime || "").slice(0, 40) || null,
        device_info: info as any,
        is_online: Boolean(device.online),
        last_seen_at: safeDate(device.lastSeen),
      },
    });
  }

  return prisma.fk_wan_devices.findMany({
    orderBy: [{ is_online: "desc" }, { last_seen_at: "desc" }, { device_name: "asc" }],
    include: { school: { select: { id: true, name: true } } },
  });
}

export async function listDiscoveredDevices() {
  await syncDiscoveredDevices();
  return prisma.fk_wan_devices.findMany({
    orderBy: [{ is_online: "desc" }, { last_seen_at: "desc" }, { device_name: "asc" }],
    include: { school: { select: { id: true, name: true } } },
  });
}

export async function assignDeviceToSchool(input: {
  deviceUid: string;
  schoolId: string;
  assignedName: string;
  assignedBy: string;
}) {
  if (!deviceIdOk(input.deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  if (!/^\d+$/.test(input.schoolId)) throw new AppError("bad_request", "Select a valid school", 400);
  const name = input.assignedName.trim();
  if (!name || name.length > 100) throw new AppError("bad_request", "Device label must be 1 to 100 characters", 400);
  if (!/^\d+$/.test(input.assignedBy)) throw new AppError("unauthorized", "Invalid platform user context", 401);

  const [current, school] = await Promise.all([
    prisma.fk_wan_devices.findUnique({ where: { device_uid: input.deviceUid } }),
    prisma.schools.findFirst({ where: { id: BigInt(input.schoolId), deleted_at: null }, select: { id: true, name: true } }),
  ]);
  if (!current) throw new AppError("not_found", "Device has not been discovered by the WAN server yet", 404);
  if (!school) throw new AppError("not_found", "School not found", 404);

  const firmware = current.firmware_version?.slice(0, 20) || null;
  const externalUrl = `${serverBase}/fk`;
  const result = await prisma.$transaction(async (tx) => {
    const appDevice = await tx.devices.upsert({
      where: { device_uid: input.deviceUid },
      create: {
        school_id: school.id,
        device_uid: input.deviceUid,
        name,
        type: "kiosk",
        mode: "gate",
        is_active: true,
        is_connected: current.is_online,
        last_seen_at: current.last_seen_at,
        last_connection_at: current.last_seen_at,
        last_sync_status: current.is_online ? "online" : "offline",
        firmware_version: firmware,
        device_serial: input.deviceUid,
        api_url: externalUrl,
        tablet_id: null,
      },
      update: {
        school_id: school.id,
        name,
        is_active: true,
        is_connected: current.is_online,
        last_seen_at: current.last_seen_at,
        last_sync_status: current.is_online ? "online" : "offline",
        firmware_version: firmware,
        api_url: externalUrl,
        tablet_id: null,
        updated_at: new Date(),
      },
      select: { id: true },
    });

    const registry = await tx.fk_wan_devices.update({
      where: { device_uid: input.deviceUid },
      data: {
        school_id: school.id,
        assigned_name: name,
        assigned_by_platform_user_id: BigInt(input.assignedBy),
        updated_at: new Date(),
      },
      include: { school: { select: { id: true, name: true } } },
    });
    return { ...registry, app_device_id: appDevice.id.toString() };
  });
  return result;
}

export async function getAttendanceFromDeviceServer(limit = 5000) {
  return serverRequest<Array<{ deviceId: string; receivedAt?: string; userName?: string | null; payload?: Record<string, unknown> }>>(
    `/api/attendance?limit=${Math.max(1, Math.min(limit, 100000))}`
  );
}

export async function queueDeviceCommand(deviceUid: string, cmdCode: string, cmdParam: Record<string, unknown>) {
  const queued = await serverRequest<{ commandId: string; status: string }>("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: deviceUid,
      cmdCode,
      cmdParam,
      replyProfile: "proposed-close",
      wireFormat: "vendor-le32",
    }),
  });
  if (!queued.commandId) throw new AppError("bad_gateway", "FK WAN server did not return a command ID", 502);

  return waitForCommand(queued.commandId, cmdCode);
}

async function waitForCommand(commandId: string, cmdCode: string) {
  const deadline = Date.now() + Number(process.env.FK_DEVICE_COMMAND_TIMEOUT_MS || 90000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const commands = await serverRequest<Array<{ id: string; status: string; cmdCode?: string; resultDecoded?: unknown }>>(
      "/api/commands?limit=500"
    );
    const command = Array.isArray(commands) ? commands.find(item => item.id === commandId) : null;
    if (command && command.status !== "WAIT" && command.status !== "RUN") {
      if (command.status !== "OK") {
        throw new AppError("bad_gateway", `FK terminal rejected ${cmdCode}: ${command.status}`, 502);
      }
      return { commandId, status: command.status, resultDecoded: command.resultDecoded };
    }
  }
  throw new AppError("gateway_timeout", `Timed out waiting for FK terminal command ${commandId}`, 504);
}

export async function setDeviceUser(deviceUid: string, userId: string, name: string) {
  // Use the Device-Server's user-aware endpoint: it supplies the known FK
  // metadata fields (including user_vid) in the terminal's expected framing.
  const queued = await serverRequest<{ commandId: string; status: string }>("/api/users/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: deviceUid, userId: String(userId), name, privilege: 0 }),
  });
  if (!queued.commandId) throw new AppError("bad_gateway", "FK WAN server did not return a user command ID", 502);
  return waitForCommand(queued.commandId, "SET_USER_INFO");
}

export async function deleteDeviceUser(deviceUid: string, userId: string) {
  return queueDeviceCommand(deviceUid, "DELETE_USER", { user_id: String(userId) });
}
