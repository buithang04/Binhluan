import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const r = await prisma.profile.updateMany({ data: { proxyId: null } });
console.log(`cleared profile.proxyId on ${r.count} profile(s)`);
await prisma.$disconnect();
