import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prisma } from "../database/prisma";
import { env } from "../configs/env";
import { AppError } from "../middleware/errorHandler";

const serverBase = () => (process.env.FK_DEVICE_SERVER_URL || "http://127.0.0.1:8005").replace(/\/$/, "");
const tokenSettingKey = "FK_DEVICE_SERVER_TOKEN_ENC";
const requestTimeoutMs = Number(process.env.FK_DEVICE_SERVER_TIMEOUT_MS || 8000);

function tokenEncryptionKey() {
  return createHash("sha256").update(`ecareafrica:fk-device-server-token:v1:${env.PLATFORM_JWT_SECRET}`).digest();
}

function encryptServerToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptServerToken(value: string) {
  const [version, ivText, tagText, ciphertextText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new AppError("internal_error", "Stored FK Device-Server credential cannot be read", 500);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("internal_error", "Stored FK Device-Server credential cannot be decrypted; re-enter it in Super Admin", 500);
  }
}

async function findStoredServerToken() {
  return prisma.system_settings.findFirst({ where: { school_id: null, key_name: tokenSettingKey } });
}

async function resolveServerToken() {
  const setting = await findStoredServerToken();
  if (setting?.value) return decryptServerToken(setting.value);
  return process.env.FK_DEVICE_SERVER_TOKEN?.trim() || undefined;
}

export async function getServerCredentialStatus() {
  const setting = await findStoredServerToken();
  if (setting?.value) return { configured: true, source: "superadmin" as const };
  if (process.env.FK_DEVICE_SERVER_TOKEN?.trim()) return { configured: true, source: "environment" as const };
  return { configured: false, source: "none" as const };
}

export async function setServerToken(tokenInput: string, updatedBy: string) {
  const token = tokenInput.trim();
  if (token.length > 2048) throw new AppError("bad_request", "FK Device-Server token is too long", 400);
  if (!/^\d+$/.test(updatedBy)) throw new AppError("unauthorized", "Invalid platform user context", 401);
  const existing = await findStoredServerToken();
  if (!token) {
    if (existing) await prisma.system_settings.delete({ where: { id: existing.id } });
    return getServerCredentialStatus();
  }
  const encrypted = encryptServerToken(token);
  if (existing) {
    await prisma.system_settings.update({
      where: { id: existing.id },
      data: { value: encrypted, updated_by: BigInt(updatedBy), updated_at: new Date() },
    });
  } else {
    await prisma.system_settings.create({
      data: {
        school_id: null,
        key_name: tokenSettingKey,
        value: encrypted,
        type: "string",
        updated_by: BigInt(updatedBy),
      },
    });
  }
  return getServerCredentialStatus();
}

type WanDevice = {
  deviceId: string;
  name?: string;
  deviceTime?: string;
  info?: Record<string, unknown> | null;
  remoteAddress?: string;
  lastSeen?: string;
  online?: boolean;
};

type DeviceServerSummary = {
  userCount?: number;
  biometricTemplateCount?: number;
  capacity?: number | null;
  capacitySource?: string | null;
};

function capacityFromInfo(info: Record<string, unknown> | undefined) {
  const candidate = info?.user_capacity ?? info?.max_users ?? info?.max_user_count ?? info?.user_limit;
  const capacity = Number(candidate);
  return Number.isInteger(capacity) && capacity > 0 ? capacity : null;
}

async function deviceServerSummary(deviceUid: string): Promise<DeviceServerSummary | null> {
  try {
    return await serverRequest<DeviceServerSummary>(`/api/devices/${encodeURIComponent(deviceUid)}/summary`);
  } catch {
    // Older Device-Server builds do not have this optional inventory endpoint.
    return null;
  }
}

async function serverRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const serverToken = await resolveServerToken();
  if (serverToken) headers.set("Authorization", `Bearer ${serverToken}`);
  try {
    const response = await fetch(`${serverBase()}${path}`, {
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
    const summary = await deviceServerSummary(id);
    const reportedCapacity = summary?.capacity ?? capacityFromInfo(info);
    const existing = await prisma.fk_wan_devices.findUnique({ where: { device_uid: id }, select: { device_capacity: true, capacity_source: true } });
    const capacity = reportedCapacity ?? existing?.device_capacity ?? null;
    const capacitySource = reportedCapacity !== null ? "device" : existing?.capacity_source ?? "unavailable";
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
        device_users_count: Math.max(0, Number(summary?.userCount ?? 0)),
        biometric_templates_count: Math.max(0, Number(summary?.biometricTemplateCount ?? 0)),
        device_capacity: capacity,
        capacity_source: capacitySource,
        last_seen_at: safeDate(device.lastSeen),
      },
      update: {
        device_name: deviceName,
        remote_address: String(device.remoteAddress || "").slice(0, 100) || null,
        firmware_version: firmware,
        device_time: String(device.deviceTime || "").slice(0, 40) || null,
        device_info: info as any,
        is_online: Boolean(device.online),
        ...(summary ? {
          device_users_count: Math.max(0, Number(summary.userCount ?? 0)),
          biometric_templates_count: Math.max(0, Number(summary.biometricTemplateCount ?? 0)),
        } : {}),
        ...(reportedCapacity !== null ? { device_capacity: reportedCapacity, capacity_source: "device" } : {}),
        last_seen_at: safeDate(device.lastSeen),
      },
    });
  }

  const records = await prisma.fk_wan_devices.findMany({
    orderBy: [{ is_online: "desc" }, { last_seen_at: "desc" }, { device_name: "asc" }],
    include: { school: { select: { id: true, name: true } } },
  });
  for (const device of records) {
    if (device.school_id === null) continue;
    await prisma.devices.updateMany({
      where: { device_uid: device.device_uid },
      data: {
        is_connected: device.is_online,
        last_seen_at: device.last_seen_at,
        last_connection_at: device.is_online ? device.last_seen_at : undefined,
        last_sync_status: device.is_online ? "online" : "offline",
        last_status_message: device.is_online ? "FK terminal connected directly by WAN" : "FK terminal has not polled recently",
        device_users_count: device.device_users_count,
      },
    });
  }
  return records;
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
  const externalUrl = `${serverBase()}/fk`;
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

export async function renameDiscoveredDevice(deviceUid: string, assignedName: string, assignedBy: string) {
  if (!deviceIdOk(deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  const name = assignedName.trim();
  if (!name || name.length > 100) throw new AppError("bad_request", "Device name must be 1 to 100 characters", 400);
  if (!/^\d+$/.test(assignedBy)) throw new AppError("unauthorized", "Invalid platform user context", 401);

  const current = await prisma.fk_wan_devices.findUnique({ where: { device_uid: deviceUid } });
  if (!current) throw new AppError("not_found", "Device has not been discovered by the WAN server yet", 404);

  const registry = await prisma.fk_wan_devices.update({
    where: { device_uid: deviceUid },
    data: {
      assigned_name: name,
      assigned_by_platform_user_id: BigInt(assignedBy),
      updated_at: new Date(),
    },
    include: { school: { select: { id: true, name: true } } },
  });

  // Keep the school's device-facing label in sync when this terminal has
  // already been assigned. Unassigned discoveries remain only in the registry.
  if (current.school_id !== null) {
    await prisma.devices.updateMany({ where: { device_uid: deviceUid }, data: { name, updated_at: new Date() } });
  }
  return registry;
}

export async function setDeviceCapacity(deviceUid: string, capacityInput: number | null) {
  if (!deviceIdOk(deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  if (capacityInput !== null && (!Number.isInteger(capacityInput) || capacityInput < 1 || capacityInput > 1_000_000)) {
    throw new AppError("bad_request", "Device capacity must be a positive whole number", 400);
  }
  const current = await prisma.fk_wan_devices.findUnique({ where: { device_uid: deviceUid }, select: { device_info: true } });
  if (!current) throw new AppError("not_found", "Device has not been discovered by the WAN server yet", 404);
  const info = current.device_info && typeof current.device_info === "object" ? current.device_info as Record<string, unknown> : undefined;
  const reported = capacityFromInfo(info);
  return prisma.fk_wan_devices.update({
    where: { device_uid: deviceUid },
    data: {
      device_capacity: capacityInput ?? reported,
      capacity_source: capacityInput !== null ? "manual" : reported !== null ? "device" : "unavailable",
      updated_at: new Date(),
    },
    include: { school: { select: { id: true, name: true } } },
  });
}

export async function queueFullUserPull(deviceUid: string) {
  if (!deviceIdOk(deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  return serverRequest<{ commandIds?: string[]; status?: string; message?: string }>(
    `/api/devices/${encodeURIComponent(deviceUid)}/users`, { method: "POST" }
  );
}

export async function getDeviceUsers(deviceUid: string) {
  if (!deviceIdOk(deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  return serverRequest<Array<{
    userId: string;
    name?: string;
    biometricMethods?: string[];
    lastPulledAt?: string;
  }>>(`/api/devices/${encodeURIComponent(deviceUid)}/users`);
}

export async function queueFullAttendancePull(deviceUid: string) {
  if (!deviceIdOk(deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  return serverRequest<{ commandId?: string; status?: string; message?: string }>(
    `/api/devices/${encodeURIComponent(deviceUid)}/attendance/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );
}

function biometricBackupKey() {
  return createHash("sha256").update(`ecareafrica:fk-biometric-backup:v1:${env.PLATFORM_JWT_SECRET}`).digest();
}

function encryptedBackup(plaintext: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", biometricBackupKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }));
}

function safeFolderName(value: string) {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "school";
}

export async function saveDeviceBiometricBackup(deviceUid: string) {
  if (!deviceIdOk(deviceUid)) throw new AppError("bad_request", "Invalid FK device ID", 400);
  const device = await prisma.fk_wan_devices.findUnique({
    where: { device_uid: deviceUid }, include: { school: { select: { id: true, name: true } } },
  });
  if (!device?.school_id || !device.school) throw new AppError("conflict", "Device is not assigned to a school", 409);
  const snapshot = await serverRequest<{
    users?: Array<Record<string, unknown>>;
    biometrics?: Array<Record<string, unknown>>;
  }>(`/api/devices/${encodeURIComponent(deviceUid)}/backup`);
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];
  const biometrics = (Array.isArray(snapshot.biometrics) ? snapshot.biometrics : []).filter((item) => {
    const encoded = String(item.templateBase64 ?? "");
    return item.deviceId === deviceUid && encoded.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded);
  });
  if (!biometrics.length) return { saved: false, users: users.length, biometrics: 0, reason: "No biometric templates are currently stored by the FK Device-Server" };

  const savedAt = new Date();
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    deviceUid,
    deviceName: device.assigned_name,
    schoolId: device.school_id.toString(),
    schoolName: device.school.name,
    savedAt: savedAt.toISOString(),
    users,
    biometrics,
  }));
  const contentHash = createHash("sha256").update(payload).digest("hex");
  const root = resolve(process.env.FK_BIOMETRIC_BACKUP_DIR || (process.env.NODE_ENV === "production"
    ? "/var/lib/ecareafrica/device-biometric-backups"
    : join(process.cwd(), "data", "device-biometric-backups")));
  const directory = join(root, `school-${device.school_id}-${safeFolderName(device.school.name)}`, safeFolderName(deviceUid));
  const dataPath = join(directory, "latest.json.enc");
  const hashPath = join(directory, "latest.sha256");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const oldHash = await readFile(hashPath, "utf8").catch(() => "");
  if (oldHash.trim() !== contentHash) {
    const tempPath = `${dataPath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, encryptedBackup(payload), { mode: 0o600 });
    await rename(tempPath, dataPath);
    await writeFile(hashPath, `${contentHash}\n`, { mode: 0o600 });
  }
  await prisma.fk_wan_devices.update({ where: { device_uid: deviceUid }, data: {
    biometric_templates_count: biometrics.length,
    device_users_count: users.length,
    last_biometric_backup_at: savedAt,
  } });
  return { saved: oldHash.trim() !== contentHash, users: users.length, biometrics: biometrics.length, directory, savedAt: savedAt.toISOString() };
}

export async function getAttendanceFromDeviceServer(options: { limit?: number; offset?: number; deviceUid?: string; since?: Date | null } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 50000, 100000));
  let offset = Math.max(0, Math.floor(options.offset ?? 0));
  const all: Array<{ deviceId: string; receivedAt?: string; userName?: string | null; payload?: Record<string, unknown> }> = [];
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (options.deviceUid) query.set("deviceId", options.deviceUid);
    if (options.since) query.set("since", options.since.toISOString());
    const batch = await serverRequest<Array<{ deviceId: string; receivedAt?: string; userName?: string | null; payload?: Record<string, unknown> }>>(
      `/api/attendance?${query.toString()}`
    );
    if (!Array.isArray(batch)) throw new AppError("bad_gateway", "FK WAN Device-Server returned invalid attendance data", 502);
    all.push(...batch);
    offset += batch.length;
    if (batch.length < limit) break;
  }
  return all;
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

export async function setDeviceUser(deviceUid: string, userId: string, name: string, sourceDeviceId?: string) {
  // Use the Device-Server's user-aware endpoint: it supplies the known FK
  // metadata fields (including user_vid) in the terminal's expected framing.
  const queued = await serverRequest<{ commandId: string; status: string; biometricMethods?: string[] }>("/api/users/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: deviceUid, userId: String(userId), name, privilege: 0, ...(sourceDeviceId ? { sourceDeviceId } : {}) }),
  });
  if (!queued.commandId) throw new AppError("bad_gateway", "FK WAN server did not return a user command ID", 502);
  const result = await waitForCommand(queued.commandId, "SET_USER_INFO");
  return { ...result, biometricMethods: queued.biometricMethods ?? [] };
}

export async function deleteDeviceUser(deviceUid: string, userId: string) {
  return queueDeviceCommand(deviceUid, "DELETE_USER", { user_id: String(userId) });
}
