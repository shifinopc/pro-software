import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const msgs = await p.serviceRequestMessage.findMany({ where: { requestId: 'cms0ot2vc0002pg4shdksrox6' }, orderBy: { at: 'asc' } });
console.log(msgs.map(m => `${m.authorType}${m.internal?'(internal)':''}: ${m.body}`).join('\n'));
await p.$disconnect();
