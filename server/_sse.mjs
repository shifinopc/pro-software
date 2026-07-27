const STAFF='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXMwb3QycDcwMDAwcGc0czJqY3hjdmE3IiwidHlwZSI6InN0YWZmIiwicm9sZSI6InN1cGVyX2FkbWluIiwidHYiOjAsImlhdCI6MTc4NTAwMzE4MywiZXhwIjoxNzg1MDQ2MzgzfQ.0F1KXovSRBg2CbUs2d_tjSnBvX9143-zVJBUJ0aXQjo';
const PORTAL='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXMwb3QydjAwMDAxcGc0c21pcjJ0b25sIiwidHlwZSI6InBvcnRhbCIsImNvbXBhbnlJZCI6ImNsMTc4NDExNzE1MDEzMiIsInR2IjowLCJpYXQiOjE3ODUwMDMxODMsImV4cCI6MTc4NTA0NjM4M30.YlbnjPmLETcac4XUB1oxrIC56mdiJEj_-O6huJORTNU';
const REQ='cms0ot2vc0002pg4shdksrox6';
const API='http://localhost:4100';
const ticket = async (tok) => (await (await fetch(API+'/api/stream-ticket',{method:'POST',headers:{Authorization:'Bearer '+tok}})).json()).ticket;

// Open a PORTAL stream and record what it receives
const pT = await ticket(PORTAL);
const res = await fetch(API+'/api/stream?ticket='+pT);
const reader = res.body.getReader(); const dec = new TextDecoder();
const got = [];
(async () => { while(true){ const {done,value}=await reader.read(); if(done)break; const s=dec.decode(value); for(const chunk of s.split('\n\n')) if(chunk.includes('event:')) got.push(chunk.replace(/\n/g,' ').slice(0,160)); } })();

const wait = ms => new Promise(r=>setTimeout(r,ms));
await wait(400);
console.log('1. staff typing ping...');
await fetch(API+'/api/service-requests/'+REQ+'/typing',{method:'POST',headers:{Authorization:'Bearer '+STAFF}});
await wait(400);
console.log('2. staff sends a PUBLIC reply...');
await fetch(API+'/api/service-requests/'+REQ+'/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+STAFF},body:JSON.stringify({body:'Hello from the PRO team'})});
await wait(400);
console.log('3. staff adds an INTERNAL note (portal must NOT receive)...');
await fetch(API+'/api/service-requests/'+REQ+'/messages',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+STAFF},body:JSON.stringify({body:'SECRET internal note',internal:true})});
await wait(700);
console.log('\n--- portal stream received ---');
got.forEach(g=>console.log('  '+g));
console.log('\nleaked internal note?', got.some(g=>/SECRET/.test(g)));
process.exit(0);
