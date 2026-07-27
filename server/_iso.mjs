import { PrismaClient } from '@prisma/client';
import { hashPassword } from './src/auth.js';
const prisma = new PrismaClient();
const API='http://localhost:4100';
const REQ='cms0ot2vc0002pg4shdksrox6';
const STAFF='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXMwb3QycDcwMDAwcGc0czJqY3hjdmE3IiwidHlwZSI6InN0YWZmIiwicm9sZSI6InN1cGVyX2FkbWluIiwidHYiOjAsImlhdCI6MTc4NTAwMzE4MywiZXhwIjoxNzg1MDQ2MzgzfQ.0F1KXovSRBg2CbUs2d_tjSnBvX9143-zVJBUJ0aXQjo';
// portal user of a DIFFERENT company
const other = await prisma.company.findFirst({ where: { NOT: { name: { contains: 'IONOB' } } } });
await prisma.user.deleteMany({ where: { email: 'qa-other@stimes.local' } });
await prisma.user.create({ data: { name: 'QA Other', email:'qa-other@stimes.local', roleId:'client_admin', status:'active', type:'portal', companyId: other.id, passwordHash: await hashPassword('QaOt!23456') } });
const ot=(await (await fetch(API+'/api/auth/portal-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'qa-other@stimes.local',password:'QaOt!23456'})})).json()).token;
const tk=(await (await fetch(API+'/api/stream-ticket',{method:'POST',headers:{Authorization:'Bearer '+ot}})).json()).ticket;
const res = await fetch(API+'/api/stream?ticket='+tk);
const reader=res.body.getReader(); const dec=new TextDecoder(); const got=[];
(async()=>{while(true){const {done,value}=await reader.read(); if(done)break; const s=dec.decode(value); for(const c of s.split('\n\n')) if(c.includes('event:')) got.push(c.replace(/\n/g,' ').slice(0,120));}})();
await new Promise(r=>setTimeout(r,400));
console.log('other-tenant portal listening (company:', other.name + ')');
await fetch(API+'/api/service-requests/'+REQ+'/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+STAFF},body:JSON.stringify({body:'Message for IONOB only'})});
await new Promise(r=>setTimeout(r,900));
console.log('events received by other tenant:', got);
console.log('CROSS-TENANT LEAK?', got.some(g=>/IONOB only|message/.test(g)));
// also confirm a spent ticket cannot be replayed
const rep = await fetch(API+'/api/stream?ticket='+tk);
console.log('ticket replay status (expect 401):', rep.status);
await prisma.user.deleteMany({ where: { email: 'qa-other@stimes.local' } });
await prisma.$disconnect();
process.exit(0);
