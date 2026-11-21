CREATE TABLE "fk_wan_devices" (
    "id" BIGSERIAL NOT NULL,
    "device_uid" VARCHAR(100) NOT NULL,
    "device_name" VARCHAR(100) NOT NULL DEFAULT 'FK device',
    "assigned_name" VARCHAR(100) NOT NULL DEFAULT 'FK device',
    "school_id" BIGINT,
    "assigned_by_platform_user_id" BIGINT,
    "remote_address" VARCHAR(100),
    "firmware_version" VARCHAR(100),
    "device_time" VARCHAR(40),
    "device_info" JSONB,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fk_wan_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fk_wan_devices_device_uid_key" ON "fk_wan_devices"("device_uid");
CREATE INDEX "fk_wan_devices_school_id_idx" ON "fk_wan_devices"("school_id");
CREATE INDEX "fk_wan_devices_is_online_idx" ON "fk_wan_devices"("is_online");
CREATE INDEX "fk_wan_devices_last_seen_at_idx" ON "fk_wan_devices"("last_seen_at");
CREATE INDEX "fk_wan_devices_assigned_by_platform_user_id_idx" ON "fk_wan_devices"("assigned_by_platform_user_id");

ALTER TABLE "fk_wan_devices"
    ADD CONSTRAINT "fk_wan_devices_school_id_fkey"
    FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "fk_wan_devices"
    ADD CONSTRAINT "fk_wan_devices_assigned_by_platform_user_id_fkey"
    FOREIGN KEY ("assigned_by_platform_user_id") REFERENCES "platform_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
