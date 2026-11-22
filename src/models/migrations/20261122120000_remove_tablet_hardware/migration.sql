-- Remove legacy tablet hardware; FK WAN devices are handled by fk_wan_devices.
DROP TABLE IF EXISTS "tablets" CASCADE;
ALTER TABLE "devices"
  DROP COLUMN IF EXISTS "tablet_id",
  DROP COLUMN IF EXISTS "tablet_ip",
  DROP COLUMN IF EXISTS "tablet_port";

ALTER TABLE "devices" ALTER COLUMN "type" DROP DEFAULT;
ALTER TYPE "DeviceType" RENAME TO "DeviceType_old";
CREATE TYPE "DeviceType" AS ENUM ('kiosk', 'web');
ALTER TABLE "devices"
  ALTER COLUMN "type" TYPE "DeviceType"
  USING (CASE WHEN "type"::text = 'tablet' THEN 'kiosk' ELSE "type"::text END)::"DeviceType";
ALTER TABLE "devices" ALTER COLUMN "type" SET DEFAULT 'kiosk'::"DeviceType";
DROP TYPE "DeviceType_old";
DROP TYPE IF EXISTS "TabletStatus";