import type { Request, Response } from "express";
import { AppError } from "../../middleware/errorHandler";
import * as fkWanDeviceService from "../../services/fk-wan-device.service";
import { successResponse } from "../../helpers/response";

export async function listDevices(_req: Request, res: Response) {
  const devices = await fkWanDeviceService.listDiscoveredDevices();
  res.json(successResponse(devices));
}

export async function getServerCredentialStatus(_req: Request, res: Response) {
  res.json(successResponse(await fkWanDeviceService.getServerCredentialStatus()));
}

export async function updateServerCredential(req: Request, res: Response) {
  const updatedBy = req.user?.id;
  if (updatedBy === undefined || updatedBy === null) {
    throw new AppError("unauthorized", "Missing platform user context", 401);
  }
  const result = await fkWanDeviceService.setServerToken(String(req.body.token ?? ""), String(updatedBy));
  res.json(successResponse(result));
}

export async function assignDevice(req: Request, res: Response) {
  const assignedBy = req.user?.id;
  if (assignedBy === undefined || assignedBy === null) {
    throw new AppError("unauthorized", "Missing platform user context", 401);
  }
  const result = await fkWanDeviceService.assignDeviceToSchool({
    deviceUid: req.params.deviceUid,
    schoolId: String(req.body.school_id ?? ""),
    assignedName: String(req.body.assigned_name ?? ""),
    assignedBy: String(assignedBy),
  });
  res.json(successResponse(result));
}

export async function renameDevice(req: Request, res: Response) {
  const assignedBy = req.user?.id;
  if (assignedBy === undefined || assignedBy === null) {
    throw new AppError("unauthorized", "Missing platform user context", 401);
  }
  const result = await fkWanDeviceService.renameDiscoveredDevice(
    req.params.deviceUid,
    String(req.body.assigned_name ?? ""),
    String(assignedBy),
  );
  res.json(successResponse(result));
}

export async function updateDeviceCapacity(req: Request, res: Response) {
  const result = await fkWanDeviceService.setDeviceCapacity(
    req.params.deviceUid,
    req.body.device_capacity === null ? null : Number(req.body.device_capacity),
  );
  res.json(successResponse(result));
}
