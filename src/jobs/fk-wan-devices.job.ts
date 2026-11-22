import { createHash } from "crypto";
import { prisma } from "../database/prisma";
import * as fkWanDeviceService from "../services/fk-wan-device.service";
import { normalizeLegacyAttendanceConfig, resolveDeviceAttendance, type DeviceAttendanceSession } from "../services/attendance/device-attendance-rules.service";
import { sendAttendanceNotification, type AttendanceNotificationKind } from "../services/attendance/notification.service";
import { logger } from "../utils/logger";

const INTERVAL_MS = Math.max(5_000, Number(process.env.FK_DEVICE_SYNC_INTERVAL_MS || 5_000));
const SYNC_TIMEZONE = process.env.FK_SYNC_TIMEZONE || process.env.TZ || "Africa/Kampala";
const BIOMETRIC_BACKUP_AFTER_MS = 4 * 60 * 60 * 1000;
const BACKUP_RETRY_MS = 6 * 60 * 60 * 1000;
let running = false;
const backupAttemptAt = new Map<string, number>();

function localParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SYNC_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function localDayKey(date: Date) {
  const parts = localParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localWeekKey(date: Date) {
  const parts = localParts(date);
  const localDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const daysSinceMonday = (localDay.getUTCDay() + 6) % 7;
  localDay.setUTCDate(localDay.getUTCDate() - daysSinceMonday);
  return localDay.toISOString().slice(0, 10);
}

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

function notificationFor(mode: string, sessionName: string | null, status: string): AttendanceNotificationKind {
  const late = status === "late";
  if (mode === "classroom") return late ? "class_late" : "class_entry";
  if (mode === "boarding") {
    const evening = /evening|night/i.test(sessionName ?? "");
    return late ? "device_late" : evening ? "dormitory_evening_present" : "dormitory_morning_present";
  }
  return late ? "device_late" : "school_entry";
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
    const assigned = devices.filter(device => device.school_id !== null);
    const now = new Date();
    const today = localDayKey(now);
    const week = localWeekKey(now);

    for (const device of assigned) {
      if (!device.is_online) continue;
      try {
        if (!device.last_logs_pull_at || localDayKey(device.last_logs_pull_at) !== today) {
          const queued = await fkWanDeviceService.queueFullAttendancePull(device.device_uid);
          if (queued.commandId) {
            await prisma.fk_wan_devices.update({ where: { id: device.id }, data: { last_logs_pull_at: now } });
            logger.info({ deviceUid: device.device_uid, commandId: queued.commandId, day: today }, "FK WAN daily full log pull queued");
          }
        }
        if (!device.last_users_pull_at || localWeekKey(device.last_users_pull_at) !== week) {
          const queued = await fkWanDeviceService.queueFullUserPull(device.device_uid);
          if (queued.commandIds?.length || queued.status) {
            await prisma.fk_wan_devices.update({ where: { id: device.id }, data: { last_users_pull_at: now } });
            logger.info({ deviceUid: device.device_uid, commandIds: queued.commandIds, week }, "FK WAN weekly user and biometric pull queued");
          }
        }
      } catch (error) {
        logger.warn({ err: error, deviceUid: device.device_uid }, "FK WAN scheduled pull could not be queued; it will retry");
      }
    }

    for (const device of assigned) {
      if (!device.last_users_pull_at || now.getTime() - device.last_users_pull_at.getTime() < BIOMETRIC_BACKUP_AFTER_MS) continue;
      if (device.last_biometric_backup_at && device.last_biometric_backup_at >= device.last_users_pull_at) continue;
      if ((backupAttemptAt.get(device.device_uid) ?? 0) + BACKUP_RETRY_MS > now.getTime()) continue;
      backupAttemptAt.set(device.device_uid, now.getTime());
      try {
        const backup = await fkWanDeviceService.saveDeviceBiometricBackup(device.device_uid);
        if (backup.saved) logger.info({ deviceUid: device.device_uid, users: backup.users, biometrics: backup.biometrics, directory: backup.directory }, "Encrypted FK WAN biometric backup saved");
      } catch (error) {
        logger.warn({ err: error, deviceUid: device.device_uid }, "FK WAN biometric backup failed; it will retry later");
      }
    }

    const assignedByUid = new Map(assigned.map(device => [device.device_uid, device]));
    if (!assignedByUid.size) return;

    const assignedSchoolIds = [...new Set(assigned.flatMap(device => device.school_id === null ? [] : [device.school_id]))];
    const appDevices = await prisma.devices.findMany({
      where: { device_uid: { in: [...assignedByUid.keys()] }, school_id: { in: assignedSchoolIds } },
      include: { device_sessions: { where: { deleted_at: null }, include: { attendance_windows: { orderBy: { sort_order: "asc" } } }, orderBy: { created_at: "asc" } } },
    });
    const appDeviceByUid = new Map(appDevices.map(device => [device.device_uid, device]));

    const logs = [];
    for (const device of assigned) {
      const cursor = device.last_attendance_received_at;
      // Re-read a short overlap; stable event hashes make this safe and guard
      // against same-millisecond records on page boundaries.
      const since = cursor ? new Date(cursor.getTime() - 60_000) : null;
      logs.push(...await fkWanDeviceService.getAttendanceFromDeviceServer({ deviceUid: device.device_uid, since, limit: 100_000 }));
    }
    if (!Array.isArray(logs) || !logs.length) return;
    const maxReceivedByUid = new Map<string, Date>();
    for (const log of logs) {
      const uid = String(log?.deviceId || "");
      if (!assignedByUid.has(uid)) continue;
      const receivedAt = eventDate(log.receivedAt);
      if (receivedAt && receivedAt > (maxReceivedByUid.get(uid) ?? new Date(0))) maxReceivedByUid.set(uid, receivedAt);
    }
    const validLogs = logs.flatMap(log => {
      const deviceUid = String(log?.deviceId || "");
      const device = assignedByUid.get(deviceUid);
      const payload = log?.payload;
      const appDevice = appDeviceByUid.get(deviceUid);
      if (!device || !appDevice || !payload || typeof payload !== "object") return [];
      const raw = payload as Record<string, unknown>;
      const timestamp = eventDate(raw.io_time ?? raw.timestamp, log.receivedAt);
      const userId = asString(raw.user_id ?? raw.userId);
      if (!timestamp) return [];
      return [{ log, deviceUid, device, appDevice, raw, timestamp, userId }];
    });
    const schoolIds = [...new Set(validLogs.map(item => item.device.school_id!.toString()))].map(BigInt);
    const userIds = [...new Set(validLogs.map(item => item.userId).filter((id): id is string => Boolean(id)))];
    const students = schoolIds.length && userIds.length ? await prisma.students.findMany({
      where: { school_id: { in: schoolIds }, device_user_id: { in: userIds }, deleted_at: null },
      select: {
        id: true, school_id: true, device_user_id: true, student_id_number: true, first_name: true, last_name: true,
        student_section_enrollments: { where: { status: "active" }, take: 1, orderBy: { enrolled_at: "desc" }, select: { section: { select: { name: true, class: { select: { name: true } } } } } },
      }
    }) : [];
    const studentByKey = new Map(students.map(student => [`${student.school_id}:${student.device_user_id}`, student]));
    const rows = [];
    const notificationRows: Array<{ row: any; student: (typeof students)[number]; kind: AttendanceNotificationKind; templateId?: bigint }> = [];
    for (const { log, deviceUid, device, appDevice, raw, timestamp, userId } of validLogs) {
      // The receive timestamp changes when the same device log is re-fetched.
      // Hash only the device's stable event fields so daily history pulls stay idempotent.
      const sourceIdentity = JSON.stringify([deviceUid, raw.user_id ?? raw.userId, raw.io_time ?? raw.timestamp, raw.verify_mode, raw.io_mode, raw.work_code ?? 0]);
      const logId = createHash("sha256").update(sourceIdentity).digest("hex");
      const student = userId ? studentByKey.get(`${device.school_id}:${userId}`) : null;
      const configuredSessions: DeviceAttendanceSession[] = appDevice.device_sessions.length
        ? appDevice.device_sessions.map(session => ({
            id: session.id.toString(), name: session.name, send_sms: session.send_sms,
            auto_approve: session.auto_approve, notification_template_id: session.notification_template_id?.toString(),
            is_active: session.is_active, windows: session.attendance_windows,
          }))
        : normalizeLegacyAttendanceConfig(appDevice.attendance_config);
      const resolved = resolveDeviceAttendance(configuredSessions, timestamp);
      const enrollment = student?.student_section_enrollments?.[0];
      const localDeviceId = appDevice.id.toString();
      rows.push({
        school_id: device.school_id!,
        log_id: logId,
        user_id: student?.id.toString() ?? userId,
        student_id: student?.student_id_number ?? student?.id.toString() ?? null,
        student_device_id: userId,
        student_name: student ? `${student.first_name} ${student.last_name}`.trim() : null,
        class_name: enrollment?.section.class.name ?? null,
        section: enrollment?.section.name ?? null,
        // School API selectors use this local ID. Keep the vendor UID in raw_data.
        device_id: localDeviceId,
        authentication_method: methodLabel(raw.verify_mode),
        direction: directionLabel(raw.io_mode),
        timestamp,
        status: resolved.status,
        attendance_period: resolved.sessionName ?? resolved.statusLabel,
        raw_data: { ...raw, device_uid: deviceUid, local_device_id: localDeviceId, received_at: log.receivedAt ?? null, attendance_session: resolved.sessionName },
        sync_state: "synced",
        synced_at: new Date(),
      });
      if (student && resolved.session?.send_sms === true && ["present", "late", "grace"].includes(resolved.status) && raw.source !== "historical") {
        const mode = String(appDevice.mode ?? "");
        notificationRows.push({ row: rows[rows.length - 1], student, kind: notificationFor(mode, resolved.sessionName, resolved.status), templateId: resolved.session.notification_template_id ? BigInt(resolved.session.notification_template_id) : undefined });
      }
    }
    const uniqueRows = [...new Map(rows.map(row => [`${row.device_id}:${row.log_id}`, row])).values()];
    const existingByKey = new Map<string, { id: bigint }>();
    for (let offset = 0; offset < uniqueRows.length; offset += 400) {
      const chunk = uniqueRows.slice(offset, offset + 400);
      const existing = await prisma.attendance_logs.findMany({
        where: { OR: chunk.flatMap(row => [
          { device_id: row.device_id, log_id: row.log_id },
          { device_id: String((row.raw_data as any)?.device_uid ?? ""), log_id: row.log_id },
        ]) },
        select: { id: true, device_id: true, log_id: true },
      });
      for (const item of existing) if (item.log_id) existingByKey.set(`${String(item.device_id)}:${item.log_id}`, { id: item.id });
    }
    const freshRows = [];
    let refreshed = 0;
    for (const row of uniqueRows) {
      const legacyUid = String((row.raw_data as any)?.device_uid ?? "");
      const existing = existingByKey.get(`${row.device_id}:${row.log_id}`) ?? existingByKey.get(`${legacyUid}:${row.log_id}`);
      if (!existing) {
        freshRows.push(row);
        continue;
      }
      // Upgrade older gateway-keyed records in place and refresh their matched
      // student/session classification. This preserves one scan row and never
      // re-sends SMS for history that was already stored.
      await prisma.attendance_logs.update({
        where: { id: existing.id },
        data: {
          user_id: row.user_id, student_id: row.student_id, student_device_id: row.student_device_id,
          student_name: row.student_name, class_name: row.class_name, section: row.section,
          device_id: row.device_id, authentication_method: row.authentication_method,
          direction: row.direction, timestamp: row.timestamp, status: row.status,
          attendance_period: row.attendance_period, raw_data: row.raw_data,
          sync_state: row.sync_state, synced_at: row.synced_at,
        },
      });
      refreshed += 1;
    }
    const saved = freshRows.length ? await prisma.attendance_logs.createMany({ data: freshRows, skipDuplicates: true }) : { count: 0 };
    const freshLogIds = new Set(freshRows.map(row => `${row.device_id}:${row.log_id}`));
    for (const item of notificationRows) {
      if (!freshLogIds.has(`${item.row.device_id}:${item.row.log_id}`)) continue;
      void sendAttendanceNotification({
        schoolId: item.row.school_id, studentId: item.student.id,
        kind: item.kind, occurredAt: item.row.timestamp, templateId: item.templateId,
        context: { attendance_status: String(item.row.status), status: String(item.row.status), session_name: String(item.row.attendance_period ?? "") },
      }).catch(error => logger.warn({ err: error, studentId: item.student.id.toString() }, "FK attendance session SMS failed"));
    }
    for (const [deviceUid, receivedAt] of maxReceivedByUid) {
      await prisma.fk_wan_devices.update({ where: { device_uid: deviceUid }, data: { last_attendance_received_at: receivedAt } });
    }
    logger.info({ fetched: logs.length, accepted: rows.length, inserted: saved.count, refreshed }, "FK WAN attendance sync completed");
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
  logger.info({ intervalMs: INTERVAL_MS, timezone: SYNC_TIMEZONE }, "FK WAN device discovery, attendance, and scheduled backups started");
  return () => clearInterval(timer);
}
