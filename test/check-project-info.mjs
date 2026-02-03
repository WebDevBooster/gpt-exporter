import { readFileSync } from 'fs';

const buf = readFileSync('./test-exports-and-logs/1-conversation_for_mock_API.json');
let str;
if (buf[0] === 0xFF && buf[1] === 0xFE) {
    str = buf.toString('utf16le').substring(1);
} else {
    str = buf.toString('utf8');
}
const data = JSON.parse(str);
console.log('Keys:', Object.keys(data[0]));
console.log('_projectId:', data[0]._projectId);
console.log('_projectName:', data[0]._projectName);
console.log('gizmo_id:', data[0].gizmo_id);

// Check branching conversation
const buf2 = readFileSync('./test-exports-and-logs/4-branching-conversations_for_mock_API.json');
let str2;
if (buf2[0] === 0xFF && buf2[1] === 0xFE) {
    str2 = buf2.toString('utf16le').substring(1);
} else {
    str2 = buf2.toString('utf8');
}
const data2 = JSON.parse(str2);
const conv = data2.find(c => c.conversation_id === '698065a8-9160-8392-a810-0ae50700979b');
console.log('\nDiacritics and Accents conversation:');
console.log('Keys:', Object.keys(conv));
console.log('_projectId:', conv._projectId);
console.log('_projectName:', conv._projectName);
console.log('gizmo_id:', conv.gizmo_id);
