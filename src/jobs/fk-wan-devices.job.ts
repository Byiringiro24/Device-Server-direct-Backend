import { createHash } from "crypto";
import { prisma } from "../database/prisma";
import * as fkWanDeviceService from "../services/fk-wan-device.service";
import { logger } from "../utils/logger";

const INTERVAL_MS = Math.max(5_000, Number(process.env.FK_DEVICE_SYNC_INTERVAL_MS || 15_000));
let running = false;

function asString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value).slice(0, 255);
}

function eventDate(value: unknown, receivedAt?: string): Date | null {
  const raw = value ?? receivedAt;
  if (!raw) return null;
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date;
}

function methodLabel(value: unknown): string {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("face") || raw === "20") return "face";
  if (raw.includes("card") || raw.includes("rfid") || raw === "3") return "nfc";
  if (raw.includes("pin") || raw.includes("password") || raw === "2") return "manual";
  return "fingerprint";
}

function directionLabel(value: unknown): string {
  const raw = String(value ?? "").toLowerCase();
  return raw.includes("out") || ["2", "4", "6", "8"].includes(raw) ? "exit" : "entry";
}

async function sweep() {
  if (running) return;
  running = true;
  try {
    const devices = await fkWanDeviceService.syncDiscoveredDevices();
    const assigned = new Map(devices
      .filter(device => device.school_id !== null)
      .map(device => [device.device_uid, device]));
    if (!assigned.size) return;

    const logs = await fkWanDeviceService.getAttendanceFromDeviceServer(100_000);
    if (!Array.isArray(logs) || !logs.length) return;
    const validLogs = logs.flatMap(log => {
      const deviceUid = String(log?.deviceId || "");
      const device = assigned.get(deviceUid);
      const payload = log?.payload;
      if (!device || !payload || typeof payload !== "object") return [];
      const raw = payload as Record<string, unknown>;
      const timestamp = eventDate(raw.io_time ?? raw.timestamp, log.receivedAt);
      const userId = asString(raw.user_id ?? raw.userId);
      if (!timestamp) return [];
      return [{ log, deviceUid, device, raw, timestamp, userId }];
    });
    const schoolIds = [...new Set(validLogs.map(item => item.device.school_id!.toString()))].map(BigInt);
    const userIds = [...new Set(validLogs.map(item => item.userId).filter((id): id is string => Boolean(id)))];
    const students = schoolIds.length && userIds.length ? await prisma.students.findMany({
      where: { school_id: { in: schoolIds }, device_user_id: { in: userIds }, deleted_at: null },
      select: { id: true, school_id: true, device_user_id: true, student_id_number: true, first_name: true, last_name: true }
    }) : [];
    const studentByKey = new Map(students.map(student => [`${student.school_id}:${student.device_user_id}`, student]));
    const rows = [];
    for (const { log, deviceUid, device, raw, timestamp, userId } of validLogs) {
      const sourceIdentity = JSON.stringify([deviceUid, log.receivedAt, raw.user_id, raw.io_time, raw.verify_mode, raw.io_mode, raw.work_code]);
      const logId = createHash("sha256").update(sourceIdentity).digest("hex");
      const student = userId ? studentByKey.get(`${device.school_id}:${userId}`) : null;
      rows.push({
        school_id: device.school_id!,
        log_id: logId,
        user_id: userId,
        student_id: student?.student_id_number ?? student?.id.toString() ?? null,
        student_device_id: userId,
        student_name: student ? `${student.first_name} ${student.last_name}`.trim() : null,
        device_id: deviceUid,
        authentication_method: methodLabel(raw.verify_mode),
        direction: directionLabel(raw.io_mode),
        timestamp,
        status: "synced",
        raw_data: { ...raw, device_uid: deviceUid, received_at: log.receivedAt ?? null },
        sync_state: "synced",
        synced_at: new Date(),
      });
    }
    if (rows.length) {
      const saved = await prisma.attendance_logs.createMany({ data: rows, skipDuplicates: true });
      logger.info({ fetched: logs.length, accepted: rows.length, inserted: saved.count }, "FK WAN attendance sync completed");
    }
  } catch (error) {
    logger.warn({ err: error }, "FK WAN discovery/attendance sync failed");
  } finally {
    running = false;
  }
}

export function startFkWanDevicesJob() {
  void sweep();
  const timer = setInterval(() => void sweep(), INTERVAL_MS);
  timer.unref();
  logger.info({ intervalMs: INTERVAL_MS }, "FK WAN device discovery and attendance sync started");
  return () => clearInterval(timer);
}
