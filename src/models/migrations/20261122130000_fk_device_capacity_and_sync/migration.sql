ALTER TABLE "fk_wan_devices"
  ADD COLUMN "device_users_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "biometric_templates_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "device_capacity" INTEGER,
  ADD COLUMN "capacity_source" VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN "last_logs_pull_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_attendance_received_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_users_pull_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_biometric_backup_at" TIMESTAMPTZ(3);
