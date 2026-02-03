import { sanitizeFilename, generateFilename } from '../export/markdown.js';

const title = 'Branch · Diacritics and Accents';
const id = '6981255a-0c54-8393-9176-98d226ea8c0c';

const sanitized = sanitizeFilename(title);
const filename = generateFilename(title, id);
const expected = 'Branch_·_Diacritics_and_Accents_6981255a';

process.stdout.write('sanitizeFilename result: ' + JSON.stringify(sanitized) + '\n');
process.stdout.write('generateFilename result: ' + JSON.stringify(filename) + '\n');
process.stdout.write('Expected: ' + JSON.stringify(expected) + '\n');
process.stdout.write('Match: ' + (filename === expected) + '\n');
