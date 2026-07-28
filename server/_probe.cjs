const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const r = await p.errorReport.findMany({ orderBy: { createdAt: 'desc' }, take: 5 });
  r.forEach(x => console.log([x.kind.padEnd(9), x.app.padEnd(7), (x.path||'').slice(0,28).padEnd(28), 'actor=' + (x.actorName || 'anon'), (x.message||'').slice(0,34)].join(' | ')));
})().finally(() => p.$disconnect());
