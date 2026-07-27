const API='http://localhost:4100';
const STAFF='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXMwb3QycDcwMDAwcGc0czJqY3hjdmE3IiwidHlwZSI6InN0YWZmIiwicm9sZSI6InN1cGVyX2FkbWluIiwidHYiOjAsImlhdCI6MTc4NTAwMzE4MywiZXhwIjoxNzg1MDQ2MzgzfQ.0F1KXovSRBg2CbUs2d_tjSnBvX9143-zVJBUJ0aXQjo';
const REQ='cms0ot2vc0002pg4shdksrox6';
await fetch(API+'/api/service-requests/'+REQ+'/typing',{method:'POST',headers:{Authorization:'Bearer '+STAFF}});
console.log('typing ping sent at', new Date().toISOString().slice(11,19));
