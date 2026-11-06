import { conversationToMarkdown } from './markdown.js';
import { createBackupJson } from './json.js';

export function buildExportFiles(fullConversations, formats, reportProgress = () => {}) {
    const filesToBundle = [];

    if (formats.markdown) {
        const markdownOptions = { includeAboveBranchedFrom: !!formats.includeAboveBranchedFrom };
        for (let i = 0; i < fullConversations.length; i++) {
            const md = conversationToMarkdown(fullConversations[i], markdownOptions);
            filesToBundle.push({ filename: md.filename, content: md.content, mimeType: 'text/markdown' });
            reportProgress('exporting', i + 1, fullConversations.length);
        }
    }

    if (formats.json) {
        const json = createBackupJson(fullConversations);
        filesToBundle.push({ filename: json.filename, content: json.content, mimeType: 'application/json' });
    }

    return filesToBundle;
}

const ARCHIVE_BATCH_SIZE = 100;
const zipOptions = { compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true };

// Read from IndexedDB in the offscreen document. Only one batch of raw
// conversations is held at a time and the worker receives a small receipt.
export async function buildSavedArchive({ jobId, ids, formats, report }, store, Zip) {
    const archive = new Zip();
    if (report) archive.file(report.filename, report.content);
    const exported = [];
    const names = new Set();
    const parts = Math.ceil(ids.length / ARCHIVE_BATCH_SIZE);
    for (let part = 0; part < parts; part++) {
        const conversations = [];
        for (const id of ids.slice(part * ARCHIVE_BATCH_SIZE, (part + 1) * ARCHIVE_BATCH_SIZE)) {
            const conversation = await store.get({ id: jobId }, `conversation:${id}`);
            if (!conversation) throw new Error(`Missing saved payload for ${id}`);
            conversations.push(conversation);
            exported.push({ id, update_time: conversation.update_time });
        }
        const batch = parts === 1 ? archive : new Zip();
        for (const file of buildExportFiles(conversations, formats)) {
            let filename = file.filename;
            if (parts > 1 && file.mimeType === 'application/json') {
                filename = filename.replace(/\.json$/, `_part-${part + 1}.json`);
            }
            // ZIP entry names must be distinct, including when extracting on Windows.
            let suffix = 2;
            const original = filename;
            const extension = original.lastIndexOf('.');
            while (names.has(filename.toLowerCase())) {
                filename = original.slice(0, extension) + `_${suffix++}` + original.slice(extension);
            }
            names.add(filename.toLowerCase());
            batch.file(filename, file.content, { createFolders: false });
        }
        if (batch !== archive) {
            // JSZip retains the compressed entries and reuses them when writing
            // the final archive, so raw content from earlier batches can be freed.
            const compressed = await batch.generateAsync({ ...zipOptions, type: 'uint8array' });
            await archive.loadAsync(compressed);
        }
    }
    const blob = await archive.generateAsync({ ...zipOptions, type: 'blob' });
    return { blob, exported, fileCount: names.size + Number(!!report) };
}
