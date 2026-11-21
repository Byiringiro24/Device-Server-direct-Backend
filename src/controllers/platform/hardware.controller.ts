import type { Request, Response } from "express";
import { prisma } from "../../database/prisma";
import { parsePagination } from "../../helpers/pagination";
import { successResponse } from "../../helpers/response";
import { AppError } from "../../middleware/errorHandler";
import * as deviceService from "../../services/device.service";

const toBigInt = (value: string | number | bigint) => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
};

const resolveSchoolIdFromBody = (req: Request) => {
  const schoolId = req.body?.school_id ?? req.query?.school_id;
  if (!schoolId) {
    throw new AppError("bad_request", "school_id is required", 400);
  }
  return toBigInt(schoolId);
};

export const listDevices = async (req: Request, res: Response) => {
  const pagination = parsePagination(req.query as Record<string, string>);
  const schoolId = req.query.school_id ? toBigInt(req.query.school_id as string) : undefined;

  const where = {
    ...(schoolId ? { school_id: schoolId } : {}),
  };

  const [items, total] = await prisma.$transaction([
    prisma.devices.findMany({
      where,
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      orderBy: { created_at: "desc" },
      include: {
        school: { select: { id: true, name: true } },
        tablet: { select: { id: true, name: true, ip: true, port: true } },
      },
    }),
    prisma.devices.count({ where }),
  ]);

  res.json(successResponse(items, { ...pagination, total }));
};

export const createDevice = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolIdFromBody(req);
  const record = await deviceService.registerDevice(schoolId, req.body);
  res.status(201).json(successResponse(record));
};

export const updateDevice = async (req: Request, res: Response) => {
  const existing = await prisma.devices.findFirst({
    where: { id: toBigInt(req.params.id) },
  });
  if (!existing) throw new AppError("not_found", "Device not found", 404);

  // Pull out school_id so device.service doesn't choke on it
  const { school_id, ...restBody } = req.body as Record<string, unknown>;

  // Apply standard field updates (tablet_id, name, mode, etc.) through the service
  const record = await deviceService.updateDevice(existing.school_id, req.params.id, restBody as any);

  // If school_id is being changed, apply it directly (bypasses ownership check)
  if (school_id && toBigInt(school_id as any) !== existing.school_id) {
    const reassigned = await prisma.devices.update({
      where: { id: existing.id },
      data: { school_id: toBigInt(school_id as any), updated_at: new Date() },
    });
    return res.json(successResponse(reassigned));
  }

  res.json(successResponse(record));
};

export const deleteDevice = async (req: Request, res: Response) => {
  const existing = await prisma.devices.findFirst({
    where: { id: toBigInt(req.params.id) },
  });
  if (!existing) throw new AppError("not_found", "Device not found", 404);

  const record = await deviceService.deleteDevice(existing.school_id, req.params.id);
  res.json(successResponse(record));
};

