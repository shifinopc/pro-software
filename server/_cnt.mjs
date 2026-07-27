// Count live SSE connections by observing whether a publish reaches anyone:
// simplest proxy — hit the stream-ticket endpoint and check server logs aren't needed.
// Instead: open our own stream, send a typing ping, and confirm the hub fans out.
const API='http://localhost:4100';
const PORTAL='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXMwb3QydjAwMDAxcGc0c21pcjJ0b25sIiwidHlwZSI6InBvcnRhbCIsImNvbXBhbnlJZCI6ImNsMTc4NDExNzE1MDEzMiIsInR2IjowLCJpYXQiOjE3ODUwMDMxODMsImV4cCI6MTc4NTA0NjM4M30.YlbnjPmLETcac4XUB1oxrIC56mdiJEj_-O6huJORTNU';
const tk=(await (await fetch(API+'/api/stream-ticket',{method:'POST',headers:{Authorization:'Bearer '+PORTAL}})).json()).ticket;
console.log('ticket issued ok:', !!tk);
