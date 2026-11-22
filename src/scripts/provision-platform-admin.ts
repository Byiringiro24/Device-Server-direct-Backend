import {
  PlatformUserAccessScope,
  PlatformUserRole,
  PlatformUserStatus,
} from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../database/prisma";
import { hashPassword } from "../utils/hash";

async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set PLATFORM_ADMIN_EMAIL to a valid email address");
  }
  if (!password || password.length < 8) {
    throw new Error("Set PLATFORM_ADMIN_PASSWORD to a password of at least 8 characters");
  }

  const passwordHash = await hashPassword(password);
  const existing = await prisma.platform_users.findUnique({ where: { email } });
  const user = existing
    ? await prisma.platform_users.update({
        where: { id: existing.id },
        data: {
          name: "Platform Super Admin",
          password_hash: passwordHash,
          role: PlatformUserRole.platform_admin,
          access_scope: PlatformUserAccessScope.all,
          status: PlatformUserStatus.active,
          deleted_at: null,
        },
      })
    : await prisma.platform_users.create({
        data: {
          uuid: uuidv4(),
          name: "Platform Super Admin",
          email,
          password_hash: passwordHash,
          role: PlatformUserRole.platform_admin,
          access_scope: PlatformUserAccessScope.all,
          status: PlatformUserStatus.active,
        },
      });

  await prisma.sessions.updateMany({
    where: { platform_user_id: user.id, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  console.log(`Platform Super Admin provisioned: ${email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Admin provisioning failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
