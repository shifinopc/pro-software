import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  const r = await p.appSetting.findUnique({ where: { key: "org" } });
  console.log(JSON.stringify(r?.value, null, 1));
  await p.$disconnect();
})();
