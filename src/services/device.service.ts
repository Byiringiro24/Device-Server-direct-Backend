import { type DeviceMode, type DeviceType, type Prisma, type devices, type AttendanceStatus } from "@prisma/client";
import type { PaginationParams } from "../helpers/pagination";
import { prisma } from "../database/prisma";
import { AppError } from "../middleware/errorHandler";
import { hashPassword } from "../utils/hash";
import * as fkWanDeviceService from "./fk-wan-device.service";
import { resolveNextDeviceUserId } from "./student.service";
import { sendAttendanceNotification } from "./attendance/notification.service";
import { fireAndLog } from "../utils/async";
import {
  isAttendanceScheduled,
  resolveDeviceAttendance,
  type DeviceAttendanceSession as ResolvableDeviceAttendanceSession
} from "./attendance/device-attendance-rules.service";
import { recordBoardingAttendanceScan } from "./boarding/boarding-attendance.service";

type DeviceRegisterInput = {
  device_uid: string;
  name: string;
  type?: DeviceType;
  location?: string;
  mode?: DeviceMode;
  pin?: string;
  firmware_version?: string;
  api_url?: string;
  license_number?: number;
  device_serial?: string;
  product_code?: string;
  product_name?: string;
};

type DeviceUpdateInput = {
  name?: string;
  type?: DeviceType;
  location?: string | null;
  mode?: DeviceMode;
  pin?: string;
  is_active?: boolean;
  firmware_version?: string | null;
  api_url?: string | null;
  last_sync_status?: string | null;
  last_sync_error?: string | null;
  last_status_message?: string | null;
  license_number?: number | null;
  device_serial?: string | null;
  product_code?: string | null;
  product_name?: string | null;
};

type DeviceFilters = {
  mode?: DeviceMode;
  type?: DeviceType;
  is_active?: boolean;
};

export type DevicePushTargetInput = {
  mode?: "selected" | "class" | "all";
  student_ids?: Array<string | number>;
  section_id?: string | number | bigint | null;
  class_id?: string | number | bigint | null;
  student_type?: string;
  gender?: "male" | "female" | null;  // filter by gender when pushing (Boys / Girls)
};

type DeviceLogInput = {
  student_id?: string | number | bigint | null;
  event_type: string;
  scan_method?: string;
  scanned_at?: string | Date;
};

type AttendanceWindowInput = {
  label: string;
  start_time: string;
  end_time: string;
  grace_minutes?: number | string | null;
  graceMinutes?: number | string | null;
};

type DeviceSessionInput = {
  name: string;
  windows: AttendanceWindowInput[];
  send_sms?: boolean;
  auto_approve?: boolean;
  notification_template_id?: string | null;
};

type DeviceAttendanceRule = {
  label?: string | null;
  start: string;
  end: string;
  grace_minutes?: number | string | null;
  graceMinutes?: number | string | null;
};

type DeviceAttendanceSession = {
  session_id?: string;
  name: string;
  rules: DeviceAttendanceRule[];
};

type DeviceAttendanceConfigInput = {
  sessions: DeviceAttendanceSession[];
};

type DeviceAttendanceEventInput = {
  student_id?: string | number | bigint | null;
  session_name?: string;
  scanned_at?: string | Date;
  scan_method?: string;
  notes?: string;
};

type MarkAbsentInput = {
  date?: string;
};

const toBigInt = (value: string | number | bigint) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
};

export const buildDevicePushTarget = (input: DevicePushTargetInput) => ({
  mode: input.mode ?? "selected",
  student_ids: (input.student_ids ?? []).map((id) => String(id)),
  section_id: input.section_id ? String(input.section_id) : undefined,
  class_id: input.class_id ? String(input.class_id) : undefined,
  student_type: input.student_type ? String(input.student_type) : undefined,
  gender: input.gender ?? undefined,
});


export const isDeviceSyncInProgress = (status?: string | null) => {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return false;
  return ["syncing", "partial", "pending", "in_progress", "processing"].includes(normalized);
};

const normalizeAttendanceSessions = (value: unknown): DeviceAttendanceSession[] => {
  const rawValue =
    typeof value === "object" && value !== null && Array.isArray((value as any).sessions)
      ? (value as any).sessions
      : value;

  if (!Array.isArray(rawValue)) return [];

  return rawValue
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const rawRules = Array.isArray(entry.rules) ? entry.rules : [];
      const rules = rawRules
        .filter((rule): rule is Record<string, unknown> => typeof rule === "object" && rule !== null)
        .map((rule) => ({
          label: typeof rule.label === "string" ? rule.label : undefined,
          start: typeof rule.start === "string" ? rule.start : "00:00",
          end: typeof rule.end === "string" ? rule.end : "23:59"
        }))
        .filter((rule) => Boolean(rule.start) && Boolean(rule.end));

      return {
        session_id: typeof (entry as any).session_id === "string" || typeof (entry as any).session_id === "number" || typeof (entry as any).session_id === "bigint"
          ? String((entry as any).session_id)
          : typeof (entry as any).id === "string" || typeof (entry as any).id === "number" || typeof (entry as any).id === "bigint"
            ? String((entry as any).id)
            : undefined,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "Session",
        rules
      };
    })
    .filter((session) => session.rules.length > 0);
};

const resolveAttendanceSession = (
  sessions: DeviceAttendanceSession[],
  requestedName?: string
) => {
  if (requestedName) {
    const named = sessions.find((session) => session.name === requestedName);
    if (named) return named;
  }

  return sessions[0];
};

export const resolveAttendanceStatusForTime = (
  scannedAt: string | Date,
  rules: Array<{ label?: string | null; start: string; end: string; grace_minutes?: number | string | null; graceMinutes?: number | string | null }>
) => {
  const date = scannedAt instanceof Date ? scannedAt : new Date(scannedAt);
  if (!Number.isFinite(date.getTime())) return "absent";

  const minutes = date.getHours() * 60 + date.getMinutes();
  const normalizedRules = rules.map((rule) => ({
    ...rule,
    startMinutes: parseTimeToMinutes(rule.start),
    endMinutes: parseTimeToMinutes(rule.end),
    graceMinutes: Number(rule.grace_minutes ?? rule.graceMinutes ?? 0)
  }));

  for (const rule of normalizedRules) {
    const inWindow = isWithinRange(minutes, rule.startMinutes, rule.endMinutes);
    const graceConfigured = rule.graceMinutes > 0;
    const inGrace = graceConfigured && minutes > rule.endMinutes && minutes <= rule.endMinutes + rule.graceMinutes;
    const afterGrace = minutes > rule.endMinutes + rule.graceMinutes;

    if (inWindow) {
      if (/late/i.test(rule.label ?? "")) return "late";
      return "present";
    }

    if (inGrace) return "grace";

    if (minutes > rule.endMinutes && !graceConfigured) return "late";
    if (afterGrace) return "late";
  }

  return "absent";
};

const parseTimeToMinutes = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
};

const isWithinRange = (minutes: number, start: number, end: number) => {
  if (start <= end) return minutes >= start && minutes <= end;
  return minutes >= start || minutes <= end;
};

/** Format status from the direct WAN registry only; never probe a local network address. */
const formatDeviceWithStatus = async (record: devices) => {
  const { pin_hash: _pinHash, ...rest } = record;
  const direct = await prisma.fk_wan_devices.findUnique({
    where: { device_uid: record.device_uid },
    select: { is_online: true, last_seen_at: true, assigned_name: true, device_name: true, device_capacity: true, capacity_source: true, device_users_count: true }
  });
  const lastSeenAt = direct?.last_seen_at ?? null;
  const isOnline = Boolean(direct?.is_online);
  return {
    ...rest,
    name: direct?.assigned_name || record.name || direct?.device_name || record.name,
    id: record.id.toString(),
    school_id: record.school_id.toString(),
    status: isOnline ? "online" : "offline",
    is_online: isOnline,
    is_connected: isOnline,
    last_seen_at: lastSeenAt?.toISOString() ?? null,
    last_sync_at: record.last_sync_at?.toISOString() ?? null,
    device_capacity: direct?.device_capacity ?? null,
    capacity_source: direct?.capacity_source ?? "unavailable",
    device_users_count: direct?.device_users_count ?? record.device_users_count ?? 0,
  };
};

const resolveOrderBy = (sort?: string, order?: "asc" | "desc") => {
  const allowed = new Set(["created_at", "updated_at", "name", "last_seen_at"]);
  if (sort && allowed.has(sort)) {
    return { [sort]: order ?? "desc" } as Prisma.devicesOrderByWithRelationInput;
  }
  return { created_at: "desc" } as Prisma.devicesOrderByWithRelationInput;
};

export const registerDevice = async (
  schoolId: string | number | bigint,
  input: DeviceRegisterInput
) => {
  const existing = await prisma.devices.findUnique({
    where: { device_uid: input.device_uid }
  });

  if (existing) {
    throw new AppError("conflict", "Device UID already registered", 409);
  }

  const pin_hash = input.pin ? await hashPassword(input.pin) : undefined;

  const created = await prisma.devices.create({
    data: {
      school_id: toBigInt(schoolId),
      device_uid: input.device_uid,
      name: input.name,
      type: input.type,
      location: input.location,
      mode: input.mode,
      pin_hash,
      firmware_version: input.firmware_version,
      api_url: input.api_url,
      license_number: input.license_number,
      device_serial: input.device_serial,
      product_code: input.product_code,
      product_name: input.product_name
    }
  });

  return formatDeviceWithStatus(created);
};

export const findAllDevices = async (
  schoolId: string | number | bigint,
  pagination: PaginationParams,
  filters: DeviceFilters = {}
) => {
  const { page, limit, sort, order, q } = pagination;
  const where: Prisma.devicesWhereInput = {
    school_id: toBigInt(schoolId)
  };

  if (filters.mode) where.mode = filters.mode;
  if (filters.type) where.type = filters.type;
  if (filters.is_active !== undefined) where.is_active = filters.is_active;

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { device_uid: { contains: q, mode: "insensitive" } },
      { location: { contains: q, mode: "insensitive" } }
    ];
  }

  const [items, total] = await prisma.$transaction([
    prisma.devices.findMany({
      where,
      orderBy: resolveOrderBy(sort, order),
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.devices.count({ where })
  ]);

  // Connectivity is read from the direct WAN registry, never probed per-device.
  const formattedDevices = await Promise.all(
    items.map(device => formatDeviceWithStatus(device))
  );

  return {
    data: formattedDevices,
    meta: { page, limit, total }
  };
};

export const findDeviceById = async (schoolId: string | number | bigint, id: string) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const record = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    },
  });

  if (!record) {
    throw new AppError("not_found", "Device not found", 404);
  }

  return formatDeviceWithStatus(record);
};

export const updateDevice = async (
  schoolId: string | number | bigint,
  id: string,
  input: DeviceUpdateInput
) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const existing = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!existing) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const pin_hash = input.pin ? await hashPassword(input.pin) : undefined;

  const updated = await prisma.devices.update({
    where: { id: existing.id },
    data: {
      name: input.name,
      type: input.type,
      location: input.location,
      mode: input.mode,
      is_active: input.is_active,
      firmware_version: input.firmware_version,
      api_url: input.api_url,
      license_number: input.license_number,
      device_serial: input.device_serial,
      product_code: input.product_code,
      product_name: input.product_name,
      last_sync_status: input.last_sync_status,
      last_sync_error: input.last_sync_error,
      last_status_message: input.last_status_message,
      ...(pin_hash ? { pin_hash } : {})
    }
  });

  return formatDeviceWithStatus(updated);
};

export const deactivateDevice = async (schoolId: string | number | bigint, id: string) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const existing = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!existing) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const updated = await prisma.devices.update({
    where: { id: existing.id },
    data: { is_active: false }
  });

  return formatDeviceWithStatus(updated);
};

export const deleteDevice = async (schoolId: string | number | bigint, id: string) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const existing = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!existing) {
    throw new AppError("not_found", "Device not found", 404);
  }

  await prisma.devices.delete({ where: { id: existing.id } });

  return formatDeviceWithStatus(existing);
};

export const pushStudentsToDevice = async (
  schoolId: string | number | bigint,
  id: string,
  input: DevicePushTargetInput
) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    },
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const directDevice = await prisma.fk_wan_devices.findUnique({ where: { device_uid: device.device_uid } });
  if (!directDevice) {
    throw new AppError("bad_request", "This action requires a device discovered through direct FK WAN", 400);
  }
  if (directDevice && directDevice.school_id !== toBigInt(schoolId)) {
    throw new AppError("forbidden", "Direct FK device is not assigned to this school", 403);
  }

  const target = buildDevicePushTarget(input);
  const where: Prisma.studentsWhereInput = {
    school_id: toBigInt(schoolId),
    deleted_at: null,
    status: "active"
  };

  if (target.mode === "selected") {
    if (!target.student_ids.length) {
      throw new AppError("bad_request", "Select at least one student", 400);
    }
    where.id = { in: target.student_ids.map((studentId) => toBigInt(studentId)) };
  } else if (target.mode === "class") {
    if (target.class_id) {
      where.student_section_enrollments = {
        some: {
          school_id: toBigInt(schoolId),
          status: "active",
          section: { class_id: toBigInt(target.class_id) }
        }
      };
    } else if (target.section_id) {
      where.student_section_enrollments = {
        some: {
          school_id: toBigInt(schoolId),
          status: "active",
          section_id: toBigInt(target.section_id)
        }
      };
    } else {
      throw new AppError("bad_request", "Select a class or section to push", 400);
    }
  }

  if (target.student_type) {
    where.student_type = target.student_type as any;
  }

  // Gender filter — allows pushing only Boys or only Girls to a device
  if (target.gender) {
    where.gender = target.gender as any;
  }

  const students = await prisma.students.findMany({
    where,
    select: {
      id: true,
      uuid: true,
      first_name: true,
      last_name: true,
      student_id_number: true,
      device_user_id: true,
      status: true
    },
    orderBy: { first_name: "asc" }
  });

  if (!students.length) {
    throw new AppError("not_found", "No active students matched the selected target", 404);
  }

  // Ensure every student has a device_user_id before pushing.
  // Students created before auto-assignment was introduced may have null device_user_id.
  // We assign missing IDs now inside a transaction so they are persisted immediately.
  const studentsNeedingId = students.filter((s) => !s.device_user_id);
  if (studentsNeedingId.length > 0) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.students.findMany({
        where: { school_id: toBigInt(schoolId), device_user_id: { not: null }, deleted_at: null },
        select: { device_user_id: true },
      });
      const usedIds = new Set(existing.map((s) => s.device_user_id).filter(Boolean) as string[]);

      for (const s of studentsNeedingId) {
        let next = resolveNextDeviceUserId([...usedIds]);
        while (usedIds.has(next)) { next = String(Number(next) + 1); }
        await tx.students.update({ where: { id: s.id }, data: { device_user_id: next } });
        (s as any).device_user_id = next;
        usedIds.add(next);
      }
    });
  }

  // Now all students have a device_user_id — this is the authoritative list used for the push loop
  const studentsWithDeviceUserIds = students;

  if (directDevice) {
    await prisma.devices.update({
      where: { id: device.id },
      data: { last_sync_at: new Date(), last_sync_status: "syncing", last_sync_error: null, last_status_message: `Pushing ${students.length} student(s) over FK WAN...` },
    });
    const biometricSourceByUser = new Map<string, string>();
    const sourceDevices = await prisma.fk_wan_devices.findMany({
      where: { school_id: toBigInt(schoolId) },
      select: { device_uid: true },
    });
    const cachedUsers = await Promise.all(sourceDevices.map(async source => {
      try { return { deviceUid: source.device_uid, users: await fkWanDeviceService.getDeviceUsers(source.device_uid) }; }
      catch { return { deviceUid: source.device_uid, users: [] }; }
    }));
    for (const source of cachedUsers) {
      for (const user of source.users) {
        if (user.biometricMethods?.length && !biometricSourceByUser.has(user.userId)) {
          biometricSourceByUser.set(user.userId, source.deviceUid);
        }
      }
    }
    const pushed: Array<{ id: string; user_id: string; name: string; biometric_methods: string[] }> = [];
    const failed: Array<{ id: string; user_id: string; name: string; error: string }> = [];
    for (const student of studentsWithDeviceUserIds) {
      const userId = student.device_user_id;
      const name = `${student.first_name} ${student.last_name}`.trim();
      if (!userId) {
        failed.push({ id: student.id.toString(), user_id: "", name, error: "Student has no device_user_id assigned" });
        continue;
      }
      try {
        const sourceDeviceUid = biometricSourceByUser.get(userId);
        const result = await fkWanDeviceService.setDeviceUser(device.device_uid, userId, name, sourceDeviceUid);
        pushed.push({ id: student.id.toString(), user_id: userId, name, biometric_methods: result.biometricMethods });
        await prisma.students.update({ where: { id: student.id }, data: { device_sync_status: "synced", last_device_sync: new Date() } });
      } catch (error) {
        failed.push({ id: student.id.toString(), user_id: userId, name, error: error instanceof Error ? error.message : "FK WAN command failed" });
        await prisma.students.update({ where: { id: student.id }, data: { device_sync_status: "failed" } });
      }
    }
    await prisma.devices.update({
      where: { id: device.id },
      data: { last_sync_at: new Date(), last_sync_status: failed.length ? "partial" : "synced", last_sync_error: failed.length ? `${failed.length} student(s) failed to push` : null, last_status_message: `Pushed ${pushed.length}/${students.length} student(s) over FK WAN` },
    });
    return { device_id: device.id.toString(), device_uid: device.device_uid, target, api_url: process.env.FK_DEVICE_SERVER_URL || "http://127.0.0.1:8005", selected_count: studentsWithDeviceUserIds.length, pushed_count: pushed.length, failed_count: failed.length, students: pushed, errors: failed };
  }

  throw new AppError("internal_error", "Direct FK WAN user push did not complete", 500);
};

/**
 * Remove students from a biometric device (deletes fingerprints from FK623).
 * Supports same filter modes as push: selected / class / all.
 * After removal, clears device_sync_status and device_user_id on the student record.
 */
export const removeStudentsFromDevice = async (
  schoolId: string | number | bigint,
  id: string,
  input: DevicePushTargetInput
) => {
  if (!/^\d+$/.test(id)) throw new AppError("bad_request", "Invalid device id", 400);

  const device = await prisma.devices.findFirst({
    where: { id: toBigInt(id), school_id: toBigInt(schoolId) },
  });
  if (!device) throw new AppError("not_found", "Device not found", 404);

  const directDevice = await prisma.fk_wan_devices.findUnique({ where: { device_uid: device.device_uid } });
  if (!directDevice) {
    throw new AppError("bad_request", "This action requires a device discovered through direct FK WAN", 400);
  }
  if (directDevice && directDevice.school_id !== toBigInt(schoolId)) {
    throw new AppError("forbidden", "Direct FK device is not assigned to this school", 403);
  }
  const target = buildDevicePushTarget(input);
  const where: Prisma.studentsWhereInput = {
    school_id: toBigInt(schoolId),
    deleted_at: null,
    status: "active",
    // Keep the saved device_user_id as the stable identity used to re-enroll
    // this student later. Older bridge-managed students may not have a current
    // device_sync_status even though their biometric ID is already assigned.
    device_user_id: { not: null },
  };

  if (target.mode === "selected") {
    if (!target.student_ids.length) throw new AppError("bad_request", "Select at least one student", 400);
    where.id = { in: target.student_ids.map(sid => toBigInt(sid)) };
  } else if (target.mode === "class") {
    if (target.class_id) {
      where.student_section_enrollments = { some: { school_id: toBigInt(schoolId), status: "active", section: { class_id: toBigInt(target.class_id) } } };
    } else if (target.section_id) {
      where.student_section_enrollments = { some: { school_id: toBigInt(schoolId), status: "active", section_id: toBigInt(target.section_id) } };
    } else {
      throw new AppError("bad_request", "Select a class or section to remove", 400);
    }
  }
  // mode=all → no additional filter, removes all synced students

  const students = await prisma.students.findMany({
    where,
    select: { id: true, first_name: true, last_name: true, student_id_number: true, device_user_id: true },
    orderBy: { first_name: "asc" }
  });

  if (!students.length) throw new AppError("not_found", "No students with a saved device ID matched the selected target", 404);

  await prisma.devices.update({
    where: { id: device.id },
    data: {
      last_sync_at: new Date(),
      last_sync_status: "syncing",
      last_sync_error: null,
      last_status_message: `Removing ${students.length} student(s) from device...`
    }
  });

  if (directDevice) {
    if (!directDevice.is_online) throw new AppError("conflict", "The device must be online before removing users", 409);
    const existingUsers = await fkWanDeviceService.getDeviceUsers(device.device_uid);
    const requestedIds = students.map(student => String(student.device_user_id)).filter(Boolean);
    const presentIds = requestedIds.filter(userId => existingUsers.some(user => String(user.userId) === userId));
    if (!presentIds.length) throw new AppError("not_found", "None of the selected student IDs appear in the latest pulled device users", 404);

    // Secure an encrypted server copy of the selected users' existing
    // biometric templates before sending any destructive terminal command.
    await fkWanDeviceService.saveDeviceBiometricBackup(device.device_uid, presentIds);

    const removed: Array<{ id: string; user_id: string; name: string }> = [];
    const failed: Array<{ id: string; user_id: string; name: string; error: string }> = students
      .filter(student => !presentIds.includes(String(student.device_user_id)))
      .map(student => ({ id: student.id.toString(), user_id: String(student.device_user_id), name: `${student.first_name} ${student.last_name}`.trim(), error: "This ID was not present in the latest pulled device list" }));
    for (const student of students) {
      const userId = student.device_user_id;
      if (!userId || !presentIds.includes(userId)) continue;
      const name = `${student.first_name} ${student.last_name}`.trim();
      try {
        await fkWanDeviceService.deleteDeviceUser(device.device_uid, userId);
        removed.push({ id: student.id.toString(), user_id: userId, name });
        // Do not clear device_user_id or student_id_number. The same ID remains
        // available for a future push and biometric restore from the backup.
        await prisma.students.update({ where: { id: student.id }, data: { device_sync_status: null, last_device_sync: new Date() } });
      } catch (error) {
        failed.push({ id: student.id.toString(), user_id: userId, name, error: error instanceof Error ? error.message : "FK WAN command failed" });
      }
    }
    await prisma.devices.update({ where: { id: device.id }, data: { last_sync_at: new Date(), last_sync_status: failed.length ? "partial" : "synced", last_status_message: `Verified removal of ${removed.length}/${presentIds.length} selected user(s)` } });
    return { device_id: device.id.toString(), target, selected_count: students.length, matched_count: presentIds.length, removed_count: removed.length, failed_count: failed.length, students: removed, errors: failed, studentIdsPreserved: true, biometricBackupCreated: true };
  }

  throw new AppError("internal_error", "Direct FK WAN user removal did not complete", 500);
};

export const getDeviceStatus = async (schoolId: string | number | bigint, id: string) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    },
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const wanRecord = await prisma.fk_wan_devices.findUnique({ where: { device_uid: device.device_uid } });
  if (wanRecord?.school_id === toBigInt(schoolId)) {
    let physicalUsers: Array<{ userId: string }> | null = null;
    try {
      physicalUsers = await fkWanDeviceService.getDeviceUsers(device.device_uid);
    } catch {
      // Preserve the last reported terminal count if its cached user list is unavailable.
    }
    const physicalIds = physicalUsers ? [...new Set(physicalUsers.map(user => String(user.userId)).filter(Boolean))] : [];
    const studentMatches = physicalIds.length ? await prisma.students.findMany({
      where: { school_id: toBigInt(schoolId), device_user_id: { in: physicalIds }, deleted_at: null, status: "active" },
      select: { id: true, device_user_id: true, student_type: true },
    }) : [];
    const byDeviceUserId = new Map<string, typeof studentMatches>();
    for (const student of studentMatches) {
      const key = String(student.device_user_id ?? "");
      byDeviceUserId.set(key, [...(byDeviceUserId.get(key) ?? []), student]);
    }
    const matchedStudents = [...byDeviceUserId.values()].filter(matches => matches.length === 1).map(matches => matches[0]);
    const boardingStudents = matchedStudents.filter(student => String(student.student_type).toLowerCase() === "boarding");
    const actualUserCount = physicalUsers?.length ?? wanRecord.device_users_count;
    const updated = await prisma.devices.update({
      where: { id: device.id },
      data: {
        is_connected: wanRecord.is_online,
        device_users_count: actualUserCount,
        ...(wanRecord.last_seen_at ? { last_seen_at: wanRecord.last_seen_at, last_connection_at: wanRecord.last_seen_at } : {}),
        last_sync_status: wanRecord.is_online ? "online" : "offline",
        last_status_message: wanRecord.is_online ? "Device is online" : "Device is offline",
      },
    });
    if (physicalUsers) {
      await prisma.fk_wan_devices.update({ where: { device_uid: device.device_uid }, data: { device_users_count: actualUserCount } });
    }
    return {
      ...await formatDeviceWithStatus(updated),
      status: wanRecord.is_online ? "online" : "offline",
      is_online: wanRecord.is_online,
      is_connected: wanRecord.is_online,
      connection_tier: wanRecord.is_online ? "full" : "offline",
      fk623_connected: wanRecord.is_online,
      last_seen_at: wanRecord.last_seen_at?.toISOString() ?? null,
      device_status: { connected: wanRecord.is_online, serialNumber: wanRecord.device_uid, productName: wanRecord.device_name, firmware: wanRecord.firmware_version },
      device_capacity: wanRecord.device_capacity,
      capacity_source: wanRecord.capacity_source,
      device_users_count: actualUserCount,
      assigned_students: matchedStudents.length,
      boarding_students: boardingStudents.length,
      day_students: matchedStudents.length - boardingStudents.length,
      assigned_student_ids: matchedStudents.map(student => student.id.toString()),
      last_status_message: wanRecord.is_online ? "Device is online" : "Device is offline",
    };
  }

  throw new AppError("not_found", "Device is not registered as a direct FK WAN terminal for this school", 404);
};

/**
 * Get device connection statuses for all devices
 * Used by dynamic device logs feature for device health monitoring
 * @param schoolId - School ID
 * @returns Array of device status objects
 */
export const getAllDeviceStatuses = async (schoolId: string | number | bigint) => {
  const records = await fkWanDeviceService.syncDiscoveredDevices();
  return records
    .filter(record => record.school_id === toBigInt(schoolId))
    .map(record => ({
      deviceId: record.device_uid,
      name: record.assigned_name,
      serialNumber: record.device_uid,
      isConnected: record.is_online,
      lastConnectionAt: record.last_seen_at?.toISOString() ?? undefined,
      connectionError: record.is_online ? undefined : "Device has not connected recently",
    }));
};

/**
 * Get live status from the FK Device-Server registry. Terminals are discovered
 * by their WAN polls; this endpoint never probes private-LAN IPs.
 */
export const getLiveDeviceStatuses = async (
  schoolId: string | number | bigint
): Promise<Array<{
  id: string;
  name: string;
  connection_tier: "full" | "offline";
  is_online: boolean;
  is_connected: boolean;
  fk623_connected: boolean;
  users: number;
  logs: number;
  last_status_message: string | null;
  capacity: number | null;
  capacity_source: string;
}>> => {
  const records = await fkWanDeviceService.syncDiscoveredDevices();
  const assigned = records.filter(record => record.school_id === toBigInt(schoolId));
  return Promise.all(assigned.map(async record => {
    const appDevice = await prisma.devices.findUnique({ where: { device_uid: record.device_uid }, select: { id: true } });
    return {
      id: appDevice?.id.toString() ?? record.device_uid,
      device_uid: record.device_uid,
      name: record.assigned_name,
      connection_tier: record.is_online ? "full" as const : "offline" as const,
      is_online: record.is_online,
      is_connected: record.is_online,
      fk623_connected: record.is_online,
      users: record.device_users_count,
      logs: 0,
      last_status_message: record.is_online ? "Device is online" : "Device is offline",
      capacity: record.device_capacity,
      capacity_source: record.capacity_source,
      last_seen_at: record.last_seen_at?.toISOString() ?? null,
    };
  }));
};

async function findAssignedDirectDevice(schoolId: string | number | bigint, id: string) {
  if (!/^\d+$/.test(id)) throw new AppError("bad_request", "Invalid device id", 400);
  const device = await prisma.devices.findFirst({ where: { id: toBigInt(id), school_id: toBigInt(schoolId) } });
  if (!device) throw new AppError("not_found", "Device not found", 404);
  const direct = await prisma.fk_wan_devices.findUnique({ where: { device_uid: device.device_uid } });
  if (!direct || direct.school_id !== toBigInt(schoolId)) {
    throw new AppError("forbidden", "Device is not assigned as a direct FK WAN device for this school", 403);
  }
  return { device, direct };
}

export const getDirectDeviceUsers = async (schoolId: string | number | bigint, id: string) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  const users = await fkWanDeviceService.getDeviceUsers(device.device_uid);
  const ids = [...new Set(users.map(user => String(user.userId)))];
  const students = ids.length ? await prisma.students.findMany({
    where: { school_id: toBigInt(schoolId), device_user_id: { in: ids }, deleted_at: null },
    select: { id: true, device_user_id: true, student_id_number: true, first_name: true, last_name: true },
  }) : [];
  const byDeviceId = new Map<string, typeof students>();
  for (const student of students) {
    const key = String(student.device_user_id);
    byDeviceId.set(key, [...(byDeviceId.get(key) ?? []), student]);
  }
  return users.map(user => {
    const matches = byDeviceId.get(String(user.userId)) ?? [];
    const matched = matches.length === 1 ? matches[0] : null;
    return {
      ...user,
      studentId: matched?.id.toString() ?? null,
      studentNumber: matched?.student_id_number ?? null,
      studentName: matched ? `${matched.first_name} ${matched.last_name}`.trim() : null,
      matchStatus: matches.length > 1 ? "ambiguous" : matched ? "matched" : "unmatched",
    };
  });
};

export const deleteDirectDeviceUsers = async (
  schoolId: string | number | bigint,
  id: string,
  input: { userIds?: string[]; all?: boolean },
) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  const registry = await prisma.fk_wan_devices.findUnique({ where: { device_uid: device.device_uid } });
  if (!registry?.is_online) throw new AppError("conflict", "The device must be online before removing users", 409);
  const liveUsers = await fkWanDeviceService.getDeviceUsers(device.device_uid);
  const requested = input.all ? liveUsers.map(user => String(user.userId)) : [...new Set((input.userIds ?? []).map(value => String(value).trim()).filter(Boolean))];
  if (!requested.length) throw new AppError("bad_request", "Select at least one current device user", 400);
  const presentIds = requested.filter(userId => liveUsers.some(user => String(user.userId) === userId));
  if (presentIds.length !== requested.length) throw new AppError("conflict", "One or more selected IDs are no longer in the latest device user list. Pull users and review the list again.", 409);

  const backup = await fkWanDeviceService.saveDeviceBiometricBackup(device.device_uid, presentIds);
  if (!backup.available) throw new AppError("conflict", "A device user backup was not created; the device was not changed", 409);
  const removed: string[] = [];
  const errors: Array<{ userId: string; error: string }> = [];
  for (const userId of presentIds) {
    try {
      const result = await fkWanDeviceService.deleteDeviceUser(device.device_uid, userId);
      if (!result.verifiedRemoved) throw new Error("The device removal could not be verified");
      removed.push(userId);
    } catch (error) {
      errors.push({ userId, error: error instanceof Error ? error.message : "Device rejected or did not verify removal" });
    }
  }
  const linked = await prisma.students.findMany({
    where: { school_id: toBigInt(schoolId), device_user_id: { in: removed }, deleted_at: null },
    select: { id: true },
  });
  if (linked.length) await prisma.students.updateMany({ where: { id: { in: linked.map(student => student.id) } }, data: { device_sync_status: null, last_device_sync: new Date() } });
  return { requested_count: requested.length, removed_count: removed.length, failed_count: errors.length, removed_user_ids: removed, errors, biometric_backup_created: true, student_device_ids_preserved: true };
};

export const getDirectDeviceUserMatchCandidates = async (schoolId: string | number | bigint, id: string) => {
  await findAssignedDirectDevice(schoolId, id);
  return prisma.students.findMany({
    where: { school_id: toBigInt(schoolId), device_user_id: null, deleted_at: null, status: "active" },
    select: { id: true, student_id_number: true, first_name: true, last_name: true },
    orderBy: [{ first_name: "asc" }, { last_name: "asc" }],
  }).then(rows => rows.map(student => ({ ...student, id: student.id.toString() })));
};

export const matchDirectDeviceUserToStudent = async (schoolId: string | number | bigint, id: string, input: { userId: string; studentId: string }) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  const userId = String(input.userId ?? "").trim();
  if (!userId || !/^\d+$/.test(input.studentId)) throw new AppError("bad_request", "Select a device user and a student", 400);
  const deviceUsers = await fkWanDeviceService.getDeviceUsers(device.device_uid);
  if (!deviceUsers.some(user => String(user.userId) === userId)) {
    throw new AppError("conflict", "That user ID is not in the latest pulled device list. Pull users, wait for the device, and try again.", 409);
  }
  return prisma.$transaction(async tx => {
    const student = await tx.students.findFirst({
      where: { id: toBigInt(input.studentId), school_id: toBigInt(schoolId), deleted_at: null, status: "active" },
      select: { id: true, device_user_id: true },
    });
    if (!student) throw new AppError("not_found", "Student was not found in this school", 404);
    if (student.device_user_id && student.device_user_id !== userId) {
      throw new AppError("conflict", "This student already has a device ID. It was left unchanged; resolve the existing match first.", 409);
    }
    const existing = await tx.students.findFirst({
      where: { school_id: toBigInt(schoolId), device_user_id: userId, id: { not: student.id } },
      select: { id: true },
    });
    if (existing) throw new AppError("conflict", "That device ID is already linked to another student", 409);
    await tx.students.update({ where: { id: student.id }, data: { device_user_id: userId } });
    return { studentId: student.id.toString(), deviceUserId: userId, studentNumberChanged: false };
  });
};

export const refreshDirectDeviceUsers = async (schoolId: string | number | bigint, id: string) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  const queued = await fkWanDeviceService.queueFullUserPull(device.device_uid);
  await prisma.fk_wan_devices.update({ where: { device_uid: device.device_uid }, data: { last_users_pull_at: new Date() } });
  return { device_uid: device.device_uid, ...queued };
};

export const refreshDirectDeviceLogs = async (schoolId: string | number | bigint, id: string) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  const queued = await fkWanDeviceService.queueFullAttendancePull(device.device_uid);
  await prisma.fk_wan_devices.update({ where: { device_uid: device.device_uid }, data: { last_logs_pull_at: new Date() } });
  return { device_uid: device.device_uid, ...queued };
};

export const syncDirectDeviceTime = async (schoolId: string | number | bigint, id: string) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  return fkWanDeviceService.syncDeviceTime(device.device_uid);
};

export const checkDirectDeviceCommandStatus = async (schoolId: string | number | bigint, id: string) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  return fkWanDeviceService.checkDeviceStatus(device.device_uid);
};

export const clearDirectDeviceLogs = async (schoolId: string | number | bigint, id: string) => {
  const { device } = await findAssignedDirectDevice(schoolId, id);
  const result = await fkWanDeviceService.clearDeviceLogs(device.device_uid);
  return { ...result, serverAttendancePreserved: true };
};

export const getDeviceAttendanceConfig = async (schoolId: string | number | bigint, id: string) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  return {
    device_id: device.id.toString(),
    sessions: normalizeAttendanceSessions(device.attendance_config)
  };
};

export const saveDeviceAttendanceConfig = async (
  schoolId: string | number | bigint,
  id: string,
  input: DeviceAttendanceConfigInput
) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const sessions = normalizeAttendanceSessions(input.sessions);
  const updated = await prisma.devices.update({
    where: { id: device.id },
    data: {
      attendance_config: { sessions },
      last_sync_status: "configured",
      last_status_message: `Saved ${sessions.length} session(s)`
    }
  });

  return {
    device_id: updated.id.toString(),
    sessions,
    attendance_config: { sessions }
  };
};

export const recordDeviceAttendanceEvent = async (
  schoolId: string | number | bigint,
  id: string,
  input: DeviceAttendanceEventInput
) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    },
    include: {
      device_sessions: {
        where: { deleted_at: null },
        include: { attendance_windows: { orderBy: { sort_order: "asc" } } },
        orderBy: { created_at: "asc" }
      }
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const student = input.student_id
    ? await prisma.students.findFirst({
        where: {
          id: toBigInt(input.student_id),
          school_id: toBigInt(schoolId),
          status: "active"
        },
        select: {
          id: true,
          student_id_number: true,
          device_user_id: true,
          first_name: true,
          last_name: true,
          student_section_enrollments: {
            where: {
              status: "active"
            },
            take: 1,
            orderBy: {
              enrolled_at: "desc"
            },
            select: {
              section: {
                select: {
                  name: true,
                  class: {
                    select: {
                      name: true
                    }
                  }
                }
              }
            }
          }
        }
      })
    : null;

  if (input.student_id && !student) {
    throw new AppError("not_found", "Student not found or not active", 404);
  }

  const scannedAt = input.scanned_at ? new Date(input.scanned_at) : new Date();
  if (!Number.isFinite(scannedAt.getTime())) {
    throw new AppError("bad_request", "Invalid scan timestamp", 400);
  }

  // Attendance Sessions is the source of truth. Keep the legacy JSON config as
  // a fallback for devices configured before the session table was introduced.
  const configuredSessions: ResolvableDeviceAttendanceSession[] = device.device_sessions.length
    ? device.device_sessions.map((session) => ({
        id: session.id.toString(),
        name: session.name,
        send_sms: session.send_sms,
        auto_approve: session.auto_approve,
        notification_template_id: session.notification_template_id?.toString(),
        is_active: session.is_active,
        windows: session.attendance_windows
      }))
    : normalizeAttendanceSessions(device.attendance_config).map((session) => ({
        name: session.name,
        windows: session.rules.map((rule) => ({ label: rule.label, start: rule.start, end: rule.end }))
      }));
  const attendance = resolveDeviceAttendance(configuredSessions, scannedAt, input.session_name);
  const studentEnrollment = student?.student_section_enrollments?.[0];
  const studentName = student ? `${student.first_name} ${student.last_name}`.trim() : "Unknown";
  const studentIdValue = student?.student_id_number ?? student?.id.toString() ?? null;
  const studentDeviceId = student?.device_user_id ?? student?.id.toString() ?? null;
  const deviceLogId = String(
    input.student_id
      ? `${device.id.toString()}-${student?.id.toString() ?? "unknown"}-${scannedAt.getTime()}`
      : `${device.id.toString()}-${scannedAt.getTime()}`
  );

  const existingLog = await prisma.attendance_logs.findFirst({
    where: {
      school_id: toBigInt(schoolId),
      device_id: id,
      log_id: deviceLogId
    }
  });

  if (existingLog) {
    throw new AppError("conflict", "Student already scanned for this device event", 409);
  }

  const statusLabel = attendance.statusLabel;
  const attendanceStatus = attendance.status;
  const selectedSessionName = attendance.sessionName;

  const created = await prisma.attendance_logs.create({
    data: {
      school_id: toBigInt(schoolId),
      log_id: deviceLogId,
      user_id: student?.id.toString() ?? null,
      student_id: studentIdValue,
      student_device_id: studentDeviceId,
      student_name: studentName,
      class_name: studentEnrollment?.section.class.name ?? null,
      section: studentEnrollment?.section.name ?? null,
      device_id: id,
      authentication_method: String((input.scan_method ?? "fingerprint").toLowerCase()),
      direction: "entry",
      timestamp: scannedAt,
      status: attendanceStatus,
      attendance_period: selectedSessionName || statusLabel,
      raw_data: {
        student_id: studentIdValue,
        student_device_id: studentDeviceId,
        student_name: studentName,
        class_name: studentEnrollment?.section.class.name ?? null,
        section: studentEnrollment?.section.name ?? null,
        device_id: id,
        scan_method: input.scan_method ?? "fingerprint",
        session_name: selectedSessionName,
        status_label: statusLabel,
        attendance_status: attendanceStatus,
        scanned_at: scannedAt.toISOString(),
        notes: input.notes ?? null
      } as Prisma.InputJsonValue,
      sync_state: "synced",
      is_flagged: false,
      flag_reason: null,
      synced_at: new Date()
    }
  });

  await prisma.devices.update({
    where: { id: device.id },
    data: {
      last_seen_at: new Date(),
      last_sync_status: "synced",
      last_status_message: `${attendanceStatus} recorded for ${selectedSessionName ?? "default"}`
    }
  });

  // ── Dining hall: auto-record in dining_attendance ─────────────────────────
  // When a device has location_scope=dining_hall and is linked to a dormitory,
  // record the scan as a dining attendance entry in the appropriate session.
  if (isAttendanceScheduled(attendanceStatus) && device.location_scope === "dining_hall" && device.dormitory_id && student?.id) {
    try {
      const { DiningMealType, DiningAttendanceStatus } = await import("@prisma/client");
      // Determine meal type from session name or time of day
      const sessionLabel = (input.session_name ?? selectedSessionName ?? "").toLowerCase();
      let mealType: typeof DiningMealType[keyof typeof DiningMealType] = DiningMealType.lunch;
      if (/breakfast|morning/i.test(sessionLabel)) mealType = DiningMealType.breakfast;
      else if (/dinner|supper|evening/i.test(sessionLabel)) mealType = DiningMealType.dinner;
      else if (/lunch|midday|noon/i.test(sessionLabel)) mealType = DiningMealType.lunch;
      else {
        // Infer from time of day
        const hour = scannedAt.getHours();
        if (hour < 10) mealType = DiningMealType.breakfast;
        else if (hour < 15) mealType = DiningMealType.lunch;
        else mealType = DiningMealType.dinner;
      }

      const sessionDate = new Date(scannedAt.getFullYear(), scannedAt.getMonth(), scannedAt.getDate());

      // Find or create dining session for this dorm + meal + date
      let diningSession = await prisma.dining_sessions.findFirst({
        where: {
          school_id: toBigInt(schoolId),
          dormitory_id: device.dormitory_id,
          meal_type: mealType,
          session_date: sessionDate,
        },
      });
      if (!diningSession) {
        diningSession = await prisma.dining_sessions.create({
          data: {
            school_id: toBigInt(schoolId),
            dormitory_id: device.dormitory_id,
            meal_type: mealType,
            session_date: sessionDate,
            opened_at: scannedAt,
          },
        });
      }

      // Upsert attendance — biometric scan = present
      // dining_attendance uses marked_at (not scanned_at)
      await prisma.dining_attendance.upsert({
        where: { session_id_student_id: { session_id: diningSession.id, student_id: student.id } },
        create: {
          school_id: toBigInt(schoolId),
          session_id: diningSession.id,
          student_id: student.id,
          status: DiningAttendanceStatus.present,
          marked_at: scannedAt,
        },
        update: {
          status: DiningAttendanceStatus.present,
          marked_at: scannedAt,
        },
      });
    } catch { /* non-fatal — don't break the main attendance log */ }
  }

  // ── Dormitory boarding attendance: auto-record scan ───────────────────────
  if (
    isAttendanceScheduled(attendanceStatus) &&
    (device.location_scope === "dormitory" || device.mode === "boarding") &&
    device.dormitory_id &&
    student?.id
  ) {
    try {
      await recordBoardingAttendanceScan(schoolId, student.id, device.dormitory_id, scannedAt);
    } catch { /* non-fatal */ }
  }

  if (student?.id && attendance.session?.send_sms === true && isAttendanceScheduled(attendanceStatus)) {
    const sourceType =
      device.mode === "boarding"
        ? "dormitory_device"
        : device.mode === "classroom"
          ? "classroom_device"
          : "gate_device";
    const evening = /evening|night/i.test(selectedSessionName ?? "");
    const notificationKind =
      sourceType === "classroom_device"
        ? attendanceStatus === "absent"
          ? "class_absent"
          : attendanceStatus === "late"
            ? "class_late"
            : "class_entry"
        : sourceType === "dormitory_device"
          ? evening
            ? attendanceStatus === "absent"
              ? "dormitory_evening_absent"
              : attendanceStatus === "late"
                ? "device_late"
                : "dormitory_evening_present"
            : attendanceStatus === "absent"
              ? "dormitory_morning_absent"
              : attendanceStatus === "late"
                ? "device_late"
                : "dormitory_morning_present"
          : attendanceStatus === "absent"
            ? "device_absent"
            : attendanceStatus === "late"
              ? "device_late"
              : "school_entry";

    fireAndLog(
      sendAttendanceNotification({
        schoolId,
        studentId: student.id,
        kind: notificationKind,
        occurredAt: created.timestamp,
        templateId: attendance.session.notification_template_id,
        sourceType,
        scopeKey: id,
        context: {
          attendance_status: attendanceStatus,
          status: attendanceStatus,
          session_name: selectedSessionName ?? ""
        }
      }),
      "device.markAttendanceEvent.notify"
    );
  }

  return {
    id: created.id.toString(),
    device_id: id,
    student_id: created.student_id ?? null,
    attendance_status: created.status,
    status_label: statusLabel,
    session_name: selectedSessionName,
    scanned_at: created.timestamp.toISOString(),
    scan_method: created.authentication_method
  };
};

export const listDeviceLogs = async (
  schoolId: string | number | bigint,
  id: string,
  pagination: PaginationParams,
  filters?: { session_name?: string; attendance_status?: string }
) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  if (filters?.attendance_status) {
    const validStatuses = ["present", "late", "absent", "not_scheduled"];
    if (!validStatuses.includes(filters.attendance_status)) {
      throw new AppError(
        "bad_request",
        `Invalid attendance_status. Valid values: ${validStatuses.join(", ")}`,
        400
      );
    }
  }

  const directRegistry = await prisma.fk_wan_devices.findUnique({ where: { device_uid: device.device_uid }, select: { device_uid: true, school_id: true } });
  if (directRegistry?.school_id === toBigInt(schoolId)) {
    const where: Prisma.attendance_logsWhereInput = {
      school_id: toBigInt(schoolId),
      device_id: { in: [device.id.toString(), directRegistry.device_uid] },
    };
    if (filters?.session_name) where.attendance_period = filters.session_name;
    if (filters?.attendance_status) where.status = { equals: filters.attendance_status, mode: "insensitive" };
    const [items, total] = await prisma.$transaction([
      prisma.attendance_logs.findMany({ where, orderBy: { timestamp: "desc" }, skip: (pagination.page - 1) * pagination.limit, take: pagination.limit }),
      prisma.attendance_logs.count({ where }),
    ]);
    return {
      data: items.map(item => {
        const [first_name, ...lastParts] = String(item.student_name ?? "").split(/\s+/).filter(Boolean);
        return {
          id: item.id.toString(), device_id: device.id.toString(),
          student_id: item.user_id, event_type: item.direction === "exit" ? "Exit" : "Attendance",
          scan_method: item.authentication_method, scanned_at: item.timestamp.toISOString(),
          session_name: item.attendance_period, status_label: item.status, attendance_status: item.status,
          is_flagged: item.is_flagged, synced_at: item.synced_at?.toISOString() ?? null,
          first_name: first_name ?? null, last_name: lastParts.join(" ") || null,
          student_id_number: item.student_id,
        };
      }),
      meta: { page: pagination.page, limit: pagination.limit, total },
    };
  }

  const { page, limit } = pagination;
  const where: Prisma.gate_logsWhereInput = {
    school_id: toBigInt(schoolId),
    device_id: id
  };

  // Apply filters
  if (filters?.session_name) {
    where.session_name = filters.session_name;
  }

  if (filters?.attendance_status) {
    if (filters.attendance_status === "not_scheduled") {
      where.status_label = "Not scheduled";
    } else {
      where.attendance_status = filters.attendance_status as AttendanceStatus;
    }
  }

  const [items, total] = await prisma.$transaction([
    prisma.gate_logs.findMany({
      where,
      include: {
        student: {
          select: {
            first_name: true,
            last_name: true,
            student_id_number: true
          }
        }
      },
      orderBy: { scanned_at: "desc" },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.gate_logs.count({ where })
  ]);

  return {
    data: items.map((item) => ({
      id: item.id.toString(),
      device_id: item.device_id,
      student_id: item.student_id?.toString() ?? null,
      event_type: item.event_type,
      scan_method: item.scan_method,
      scanned_at: item.scanned_at?.toISOString() ?? null,
      session_name: item.session_name,
      status_label: item.status_label,
      attendance_status: item.attendance_status,
      is_flagged: item.is_flagged,
      synced_at: item.synced_at?.toISOString() ?? null,
      first_name: item.student?.first_name ?? null,
      last_name: item.student?.last_name ?? null,
      student_id_number: item.student?.student_id_number ?? null
    })),
    meta: { page, limit, total }
  };
};

const resolveDeviceSessionSms = async (
  schoolId: string | number | bigint,
  deviceId: string | number | bigint,
  scannedAt: Date
) => {
  const sessions = await prisma.device_sessions.findMany({
    where: {
      school_id: toBigInt(schoolId),
      device_id: toBigInt(deviceId),
      deleted_at: null
    },
    select: {
      id: true,
      send_sms: true,
      notification_template_id: true,
      attendance_windows: { orderBy: { sort_order: "asc" } }
    },
    orderBy: { created_at: "asc" }
  });
  const approvalRows = await prisma.$queryRaw<Array<{ id: bigint; auto_approve: boolean }>>`
    SELECT id, auto_approve FROM device_sessions
    WHERE school_id = ${toBigInt(schoolId)}
      AND device_id = ${toBigInt(deviceId)}
      AND deleted_at IS NULL
  `;
  const approvalMap = new Map(approvalRows.map((row) => [row.id.toString(), row.auto_approve]));

  const minutes = scannedAt.getHours() * 60 + scannedAt.getMinutes();
  const matchedSession = sessions.find((session) =>
    session.attendance_windows.some((window) =>
      isWithinRange(
        minutes,
        parseTimeToMinutes(window.start_time),
        parseTimeToMinutes(window.end_time)
      )
    )
  );
  const session = matchedSession ?? sessions[0];

  return {
    sendSms: session?.send_sms ?? true,
    autoApprove: session ? approvalMap.get(session.id.toString()) ?? true : true,
    templateId: session?.notification_template_id?.toString()
  };
};

export const createDeviceLog = async (
  schoolId: string | number | bigint,
  id: string,
  input: DeviceLogInput
) => {
  if (!/^\d+$/.test(id)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(id),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const scannedAt = input.scanned_at ? new Date(input.scanned_at) : new Date();
  const sessionSms = await resolveDeviceSessionSms(schoolId, device.id, scannedAt);

  const created = await prisma.gate_logs.create({
    data: {
      school_id: toBigInt(schoolId),
      device_id: id,
      student_id: input.student_id ? toBigInt(input.student_id) : null,
      event_type: input.event_type as any,
      scan_method: (input.scan_method as any) ?? "fingerprint",
      scanned_at: scannedAt,
      is_flagged: !sessionSms.autoApprove,
      flag_reason: sessionSms.autoApprove ? null : "Pending attendance approval",
      synced_at: new Date()
    }
  });

  if (
    created.student_id &&
    sessionSms.sendSms &&
    (created.event_type === "entry" || created.event_type === "exit")
  ) {
    fireAndLog(
      sendAttendanceNotification({
        schoolId,
        studentId: created.student_id,
        kind: created.event_type === "exit" ? "school_exit" : "school_entry",
        occurredAt: created.scanned_at,
        templateId: sessionSms.templateId,
        sourceType: "gate_device",
        scopeKey: id
      }),
      "device.logGateEvent.notify"
    );
  }

  await prisma.devices.update({
    where: { id: device.id },
    data: {
      last_seen_at: new Date(),
      last_sync_status: "synced",
      last_status_message: `Logged ${input.event_type} event`
    }
  });

  return {
    id: created.id.toString(),
    event_type: created.event_type,
    scan_method: created.scan_method,
    scanned_at: created.scanned_at?.toISOString() ?? null,
    device_id: created.device_id,
    student_id: created.student_id?.toString() ?? null,
    is_flagged: created.is_flagged,
    synced_at: created.synced_at?.toISOString() ?? null
  };
};

// ===== Device Session CRUD Operations =====

const validateTimeFormat = (time: string): boolean => {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
};

const normalizeTime = (time: string): string => {
  const [hours, minutes] = time.split(":");
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
};

const resolveSessionNotificationTemplateId = async (
  schoolId: string | number | bigint,
  notificationTemplateId: string | null | undefined
): Promise<bigint | null> => {
  if (notificationTemplateId === undefined || notificationTemplateId === null) {
    return null;
  }

  if (!/^\d+$/.test(notificationTemplateId)) {
    throw new AppError("bad_request", "Invalid notification template id", 400);
  }

  const template = await prisma.notification_templates.findFirst({
    where: {
      id: toBigInt(notificationTemplateId),
      school_id: toBigInt(schoolId),
      is_active: true
    }
  });

  if (!template) {
    throw new AppError("not_found", "Notification template not found", 404);
  }

  return template.id;
};

export const createDeviceSession = async (
  schoolId: string | number | bigint,
  deviceId: string,
  input: DeviceSessionInput
) => {
  if (!/^\d+$/.test(deviceId)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(deviceId),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  // Validate input
  if (!input.name || input.name.trim() === "") {
    throw new AppError("bad_request", "Session name is required", 400);
  }

  if (!input.windows || input.windows.length === 0) {
    throw new AppError("bad_request", "At least one attendance window is required", 400);
  }

  // Validate windows
  for (const window of input.windows) {
    if (!window.label || !window.start_time || !window.end_time) {
      throw new AppError("bad_request", "Each window must have label, start_time, and end_time", 400);
    }

    if (!validateTimeFormat(window.start_time) || !validateTimeFormat(window.end_time)) {
      throw new AppError("bad_request", `Invalid time format. Use HH:mm (24-hour format)`, 400);
    }

    const startMinutes = parseTimeToMinutes(window.start_time);
    const endMinutes = parseTimeToMinutes(window.end_time);

    if (startMinutes > endMinutes) {
      throw new AppError("bad_request", `Window "${window.label}": start_time must be earlier than or equal to end_time`, 400);
    }
  }

  // Check for duplicate session name (case-insensitive)
  const existingSession = await prisma.device_sessions.findFirst({
    where: {
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      name: {
        equals: input.name.trim(),
        mode: "insensitive"
      },
      deleted_at: null
    }
  });

  if (existingSession) {
    throw new AppError("conflict", "Session name already exists for this device", 409);
  }

  const notificationTemplateId = await resolveSessionNotificationTemplateId(schoolId, input.notification_template_id);

  // Create session with windows in a transaction
  const session = await prisma.device_sessions.create({
    data: {
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      name: input.name.trim(),
      send_sms: input.send_sms ?? true,
      notification_template_id: notificationTemplateId,
      attendance_windows: {
        create: input.windows.map((window, index) => ({
          label: window.label,
          start_time: normalizeTime(window.start_time),
          end_time: normalizeTime(window.end_time),
          grace_minutes: Number(window.grace_minutes ?? window.graceMinutes ?? 0),
          sort_order: index
        } as any))
      }
    },
    include: {
      attendance_windows: {
        orderBy: { sort_order: "asc" }
      },
      notification_template: {
        select: { name: true, trigger_type: true }
      }
    }
  });

  await prisma.$executeRaw`
    UPDATE device_sessions SET auto_approve = ${input.auto_approve ?? true}
    WHERE id = ${session.id}
  `;

  return {
    id: session.id.toString(),
    device_id: deviceId,
    name: session.name,
    send_sms: session.send_sms,
    auto_approve: input.auto_approve ?? true,
    notification_template_id: session.notification_template_id?.toString() ?? null,
    notification_template: session.notification_template,
    windows: session.attendance_windows.map((w) => ({
      id: w.id.toString(),
      label: w.label,
      start_time: w.start_time,
      end_time: w.end_time,
      grace_minutes: Number((w as any).grace_minutes ?? (w as any).graceMinutes ?? 0)
    })),
    created_at: session.created_at.toISOString(),
    updated_at: session.updated_at.toISOString()
  };
};

export const getDeviceSessions = async (
  schoolId: string | number | bigint,
  deviceId: string
) => {
  if (!/^\d+$/.test(deviceId)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(deviceId),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const sessions = await prisma.device_sessions.findMany({
    where: {
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      deleted_at: null
    },
    select: {
      id: true,
      name: true,
      send_sms: true,
      notification_template_id: true,
      created_at: true,
      updated_at: true,
      attendance_windows: {
        orderBy: { sort_order: "asc" }
      },
      notification_template: {
        select: { name: true, trigger_type: true }
      }
    },
    orderBy: { created_at: "asc" }
  });
  const approvalRows = await prisma.$queryRaw<Array<{ id: bigint; auto_approve: boolean }>>`
    SELECT id, auto_approve FROM device_sessions
    WHERE school_id = ${toBigInt(schoolId)}
      AND device_id = ${toBigInt(deviceId)}
      AND deleted_at IS NULL
  `;
  const approvalMap = new Map(approvalRows.map((row) => [row.id.toString(), row.auto_approve]));

  let activationMap = new Map<string, { is_active: boolean; activated_at: Date | null }>();
  try {
    const activationRows = await prisma.$queryRaw<Array<{ id: bigint; is_active: boolean; activated_at: Date | null }>>`
      SELECT id, is_active, activated_at FROM device_sessions
      WHERE school_id = ${toBigInt(schoolId)}
        AND device_id = ${toBigInt(deviceId)}
        AND deleted_at IS NULL
    `;
    activationMap = new Map(
      activationRows.map((row) => [
        row.id.toString(),
        { is_active: row.is_active, activated_at: row.activated_at }
      ])
    );
  } catch (err) {
    // is_active/activated_at columns may not exist yet on some environments —
    // treat all sessions as inactive rather than failing the whole endpoint.
  }

  return {
    device_id: deviceId,
    sessions: sessions.map((session) => {
      const activation = activationMap.get(session.id.toString());
      return {
        id: session.id.toString(),
        name: session.name,
        send_sms: session.send_sms,
        auto_approve: approvalMap.get(session.id.toString()) ?? true,
        is_active: activation?.is_active ?? false,
        activated_at: activation?.activated_at?.toISOString() ?? null,
        notification_template_id: session.notification_template_id?.toString() ?? null,
        notification_template: session.notification_template,
        windows: session.attendance_windows.map((w) => ({
          id: w.id.toString(),
          label: w.label,
          start_time: w.start_time,
          end_time: w.end_time,
          grace_minutes: Number((w as any).grace_minutes ?? (w as any).graceMinutes ?? 0)
        })),
        created_at: session.created_at.toISOString(),
        updated_at: session.updated_at.toISOString()
      };
    })
  };
};

export const updateDeviceSession = async (
  schoolId: string | number | bigint,
  deviceId: string,
  sessionId: string,
  input: DeviceSessionInput
) => {
  if (!/^\d+$/.test(deviceId)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  if (!/^\d+$/.test(sessionId)) {
    throw new AppError("bad_request", "Invalid session id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(deviceId),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  // Validate input
  if (!input.name || input.name.trim() === "") {
    throw new AppError("bad_request", "Session name is required", 400);
  }

  if (!input.windows || input.windows.length === 0) {
    throw new AppError("bad_request", "At least one attendance window is required", 400);
  }

  // Validate windows
  for (const window of input.windows) {
    if (!window.label || !window.start_time || !window.end_time) {
      throw new AppError("bad_request", "Each window must have label, start_time, and end_time", 400);
    }

    if (!validateTimeFormat(window.start_time) || !validateTimeFormat(window.end_time)) {
      throw new AppError("bad_request", `Invalid time format. Use HH:mm (24-hour format)`, 400);
    }

    const startMinutes = parseTimeToMinutes(window.start_time);
    const endMinutes = parseTimeToMinutes(window.end_time);

    if (startMinutes > endMinutes) {
      throw new AppError("bad_request", `Window "${window.label}": start_time must be earlier than or equal to end_time`, 400);
    }
  }

  // Check if session exists
  const existingSession = await prisma.device_sessions.findFirst({
    where: {
      id: toBigInt(sessionId),
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      deleted_at: null
    }
  });

  if (!existingSession) {
    throw new AppError("not_found", "Session not found", 404);
  }
  const [existingApproval] = await prisma.$queryRaw<Array<{ auto_approve: boolean }>>`
    SELECT auto_approve FROM device_sessions WHERE id = ${toBigInt(sessionId)}
  `;
  const autoApprove = input.auto_approve ?? existingApproval?.auto_approve ?? true;

  // Check for duplicate session name (excluding current session)
  const duplicateName = await prisma.device_sessions.findFirst({
    where: {
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      name: {
        equals: input.name.trim(),
        mode: "insensitive"
      },
      id: {
        not: toBigInt(sessionId)
      },
      deleted_at: null
    }
  });

  if (duplicateName) {
    throw new AppError("conflict", "Session name already exists for this device", 409);
  }

  const notificationTemplateId = await resolveSessionNotificationTemplateId(schoolId, input.notification_template_id);

  // Update session and windows in a transaction
  const updatedSession = await prisma.$transaction(async (tx) => {
    // Delete existing windows
    await tx.attendance_windows.deleteMany({
      where: {
        session_id: toBigInt(sessionId)
      }
    });

    // Update session and create new windows
    const session = await tx.device_sessions.update({
      where: { id: toBigInt(sessionId) },
      data: {
        name: input.name.trim(),
        send_sms: input.send_sms ?? existingSession.send_sms,
        notification_template_id:
          input.notification_template_id === undefined ? existingSession.notification_template_id : notificationTemplateId,
        attendance_windows: {
          create: input.windows.map((window, index) => ({
            label: window.label,
            start_time: normalizeTime(window.start_time),
            end_time: normalizeTime(window.end_time),
            grace_minutes: Number(window.grace_minutes ?? window.graceMinutes ?? 0),
            sort_order: index
          } as any))
        }
      },
      include: {
        attendance_windows: {
          orderBy: { sort_order: "asc" }
        },
        notification_template: {
          select: { name: true, trigger_type: true }
        }
      }
    });

    await tx.$executeRaw`
      UPDATE device_sessions SET auto_approve = ${autoApprove}
      WHERE id = ${toBigInt(sessionId)}
    `;

    return session;
  });

  return {
    id: updatedSession.id.toString(),
    device_id: deviceId,
    name: updatedSession.name,
    send_sms: updatedSession.send_sms,
    auto_approve: autoApprove,
    notification_template_id: updatedSession.notification_template_id?.toString() ?? null,
    notification_template: updatedSession.notification_template,
    windows: updatedSession.attendance_windows.map((w) => ({
      id: w.id.toString(),
      label: w.label,
      start_time: w.start_time,
      end_time: w.end_time,
      grace_minutes: Number((w as any).grace_minutes ?? (w as any).graceMinutes ?? 0)
    })),
    created_at: updatedSession.created_at.toISOString(),
    updated_at: updatedSession.updated_at.toISOString()
  };
};

export const deleteDeviceSession = async (
  schoolId: string | number | bigint,
  deviceId: string,
  sessionId: string
) => {
  if (!/^\d+$/.test(deviceId)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  if (!/^\d+$/.test(sessionId)) {
    throw new AppError("bad_request", "Invalid session id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(deviceId),
      school_id: toBigInt(schoolId)
    }
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const session = await prisma.device_sessions.findFirst({
    where: {
      id: toBigInt(sessionId),
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      deleted_at: null
    }
  });

  if (!session) {
    throw new AppError("not_found", "Session not found", 404);
  }

  // Soft delete the session (sets deleted_at timestamp)
  await prisma.device_sessions.update({
    where: { id: toBigInt(sessionId) },
    data: {
      deleted_at: new Date()
    }
  });

  return {
    device_id: deviceId,
    session_id: sessionId,
    message: "Session deleted successfully"
  };
};

/**
 * Activate a session for a device.
 *
 * Session selection is primarily time-driven: the device resolves the matching
 * attendance window automatically for the current time. Manual activation remains
 * available as a lightweight override, but it should not silently deactivate the
 * other saved sessions because multiple attendance windows may legitimately be
 * valid at the same time.
 */
export const activateDeviceSession = async (
  schoolId: string | number | bigint,
  deviceId: string,
  sessionId: string
) => {
  if (!/^\d+$/.test(deviceId)) throw new AppError("bad_request", "Invalid device id", 400);
  if (!/^\d+$/.test(sessionId)) throw new AppError("bad_request", "Invalid session id", 400);

  const device = await prisma.devices.findFirst({
    where: { id: toBigInt(deviceId), school_id: toBigInt(schoolId) }
  });
  if (!device) throw new AppError("not_found", "Device not found", 404);

  const session = await prisma.device_sessions.findFirst({
    where: {
      id: toBigInt(sessionId),
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      deleted_at: null
    },
    include: { attendance_windows: { orderBy: { sort_order: "asc" } } }
  });
  if (!session) throw new AppError("not_found", "Session not found", 404);

  const updated = await prisma.device_sessions.update({
    where: { id: toBigInt(sessionId) },
    data: { is_active: true, activated_at: new Date(), updated_at: new Date() },
    include: { attendance_windows: { orderBy: { sort_order: "asc" } } }
  });

  return {
    id: updated.id.toString(),
    device_id: deviceId,
    name: updated.name,
    is_active: true,
    activated_at: updated.activated_at?.toISOString() ?? null,
    windows: updated.attendance_windows.map(w => ({
      id: w.id.toString(),
      label: w.label,
      start_time: w.start_time,
      end_time: w.end_time
    })),
    message: `Session "${updated.name}" is marked as active. The device still resolves attendance using the matching time window automatically, so this acts as a manual override rather than forcing all other sessions to stop.`
  };
};

/**
 * Deactivate a session (stop tagging scans to it).
 */
export const deactivateDeviceSession = async (
  schoolId: string | number | bigint,
  deviceId: string,
  sessionId: string
) => {
  if (!/^\d+$/.test(deviceId)) throw new AppError("bad_request", "Invalid device id", 400);
  if (!/^\d+$/.test(sessionId)) throw new AppError("bad_request", "Invalid session id", 400);

  const session = await prisma.device_sessions.findFirst({
    where: {
      id: toBigInt(sessionId),
      device_id: toBigInt(deviceId),
      school_id: toBigInt(schoolId),
      deleted_at: null
    }
  });
  if (!session) throw new AppError("not_found", "Session not found", 404);

  await prisma.device_sessions.update({
    where: { id: toBigInt(sessionId) },
    data: { is_active: false, updated_at: new Date() }
  });

  return {
    id: sessionId,
    device_id: deviceId,
    is_active: false,
    message: `Session "${session.name}" deactivated — scans will no longer be tagged to it`
  };
};

export const markStudentsAbsent = async (
  schoolId: string | number | bigint,
  deviceId: string,
  sessionId: string,
  input: MarkAbsentInput
) => {
  if (!/^\d+$/.test(deviceId)) {
    throw new AppError("bad_request", "Invalid device id", 400);
  }

  const device = await prisma.devices.findFirst({
    where: {
      id: toBigInt(deviceId),
      school_id: toBigInt(schoolId)
    },
  });

  if (!device) {
    throw new AppError("not_found", "Device not found", 404);
  }

  const directStatus = await prisma.fk_wan_devices.findFirst({
    where: { device_uid: device.device_uid, school_id: toBigInt(schoolId) },
    select: { is_online: true },
  });
  const deviceIsOnline = Boolean(directStatus?.is_online);

  const sessions = normalizeAttendanceSessions(device.attendance_config);
  const session = sessions.find((s: any) => {
    const candidateId = s.session_id ?? s.id;
    return candidateId === sessionId || s.name === sessionId;
  });

  if (!session) {
    throw new AppError("not_found", "Session not found", 404);
  }

  // Parse date
  const dateStr = input.date || new Date().toISOString().split("T")[0]; // YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new AppError("bad_request", "Invalid date format. Use YYYY-MM-DD", 400);
  }

  const targetDate = new Date(dateStr);
  if (isNaN(targetDate.getTime())) {
    throw new AppError("bad_request", "Invalid date value", 400);
  }

  // Get all actively enrolled students at the school
  const allStudents = await prisma.students.findMany({
    where: {
      school_id: toBigInt(schoolId),
      status: "active",
      deleted_at: null
    },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      student_id_number: true
    }
  });

  // Get existing logs for this device, session, and date
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const existingLogs = await prisma.gate_logs.findMany({
    where: {
      school_id: toBigInt(schoolId),
      device_id: deviceId,
      session_name: session.name,
      scanned_at: {
        gte: startOfDay,
        lte: endOfDay
      }
    },
    select: {
      student_id: true
    }
  });

  if (!deviceIsOnline && existingLogs.length === 0) {
    return {
      device_id: deviceId,
      session_id: sessionId,
      session_name: session.name,
      date: dateStr,
      absent_count: 0,
      student_ids: [],
      status: 'no_data_fetched',
      message: 'No attendance data was fetched because the device is offline or unreachable.'
    };
  }

  const scannedStudentIds = new Set(
    existingLogs.map((log) => log.student_id?.toString()).filter(Boolean)
  );

  // Find students who haven't scanned
  const absentStudents = allStudents.filter(
    (student) => !scannedStudentIds.has(student.id.toString())
  );

  // Create absent records
  const absentRecords = await Promise.all(
    absentStudents.map((student) =>
      prisma.gate_logs.create({
        data: {
          school_id: toBigInt(schoolId),
          device_id: deviceId,
          student_id: student.id,
          event_type: "entry",
          scan_method: "manual",
          scanned_at: targetDate,
          session_name: session.name,
          status_label: null,
          attendance_status: "absent",
          synced_at: new Date()
        }
      })
    )
  );

  return {
    device_id: deviceId,
    session_id: sessionId,
    session_name: session.name,
    date: dateStr,
    absent_count: absentRecords.length,
    student_ids: absentStudents.map((s) => s.id.toString()),
    status: 'success'
  };
};
