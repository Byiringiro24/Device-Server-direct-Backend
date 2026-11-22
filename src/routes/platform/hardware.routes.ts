import { Router } from "express";
import { z } from "zod";
import * as hardwareController from "../../controllers/platform/hardware.controller";
import * as fkWanDeviceController from "../../controllers/platform/fk-wan-device.controller";
import { asyncWrapper } from "../../helpers/asyncWrapper";
import { verifyPlatformToken } from "../../middleware/auth";
import { requireRole } from "../../middleware/roleGuard";
import { validate } from "../../middleware/validate";
import { PlatformRole } from "../../constants/roles";

const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/),
});

const platformDeviceSchema = {
  body: z.object({
    school_id: z.union([z.string().regex(/^\d+$/), z.number()]),
    device_uid: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    type: z.enum(["kiosk", "web"]).optional(),
    location: z.string().max(100).optional(),
    mode: z.enum(["gate", "boarding", "classroom"]).optional(),
    license_number: z.number().int().optional(),
    device_serial: z.string().max(100).optional(),
    product_code: z.string().max(50).optional(),
    product_name: z.string().max(100).optional(),
    api_url: z.string().max(255).optional(),
    firmware_version: z.string().max(20).optional(),
  }),
};

const platformDeviceUpdateSchema = {
  params: idParamSchema,
  body: platformDeviceSchema.body
    .omit({ device_uid: true })
    .extend({ school_id: z.union([z.string().regex(/^\d+$/), z.number()]).optional() })
    .partial(),
};

export const hardwareRoutes = Router();

hardwareRoutes.use(verifyPlatformToken, requireRole(PlatformRole.PLATFORM_ADMIN));

const fkWanDeviceAssignmentSchema = {
  params: z.object({ deviceUid: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
  body: z.object({
    school_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
    assigned_name: z.string().trim().min(1).max(100),
  }),
};

// Live FK terminals are discovered from device-initiated WAN polls.
hardwareRoutes.get("/direct-devices", asyncWrapper(fkWanDeviceController.listDevices));
hardwareRoutes.get("/direct-server-credentials", asyncWrapper(fkWanDeviceController.getServerCredentialStatus));
hardwareRoutes.patch(
  "/direct-server-credentials",
  validate({ body: z.object({ token: z.string().max(2048) }) }),
  asyncWrapper(fkWanDeviceController.updateServerCredential)
);
hardwareRoutes.patch(
  "/direct-devices/:deviceUid/assignment",
  validate(fkWanDeviceAssignmentSchema),
  asyncWrapper(fkWanDeviceController.assignDevice)
);
hardwareRoutes.patch(
  "/direct-devices/:deviceUid/name",
  validate({
    params: z.object({ deviceUid: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
    body: z.object({ assigned_name: z.string().trim().min(1).max(100) }),
  }),
  asyncWrapper(fkWanDeviceController.renameDevice)
);
hardwareRoutes.patch(
  "/direct-devices/:deviceUid/capacity",
  validate({
    params: z.object({ deviceUid: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }),
    body: z.object({ device_capacity: z.number().int().positive().max(1_000_000).nullable() }),
  }),
  asyncWrapper(fkWanDeviceController.updateDeviceCapacity)
);

hardwareRoutes.get("/devices", asyncWrapper(hardwareController.listDevices));
hardwareRoutes.post("/devices", validate(platformDeviceSchema), asyncWrapper(hardwareController.createDevice));
hardwareRoutes.patch("/devices/:id", validate(platformDeviceUpdateSchema), asyncWrapper(hardwareController.updateDevice));
hardwareRoutes.delete("/devices/:id", validate({ params: idParamSchema }), asyncWrapper(hardwareController.deleteDevice));

// FK WAN terminals connect directly; no intermediary is used.
