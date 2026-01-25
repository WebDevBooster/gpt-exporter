// JSZip ES Module Wrapper
// This wrapper makes the UMD bundle work as an ES module by executing it
// in a way that captures the JSZip export

// We need to load JSZip differently for manifest v3
// The simplest solution is to create JSZip-compatible ZIP generation inline

/**
 * Minimal ZIP file creator (no external dependencies)
 * Creates uncompressed ZIP files suitable for text content
 */
class SimpleZip {
    constructor() {
        this.files = [];
    }

    file(filename, content) {
        this.files.push({ filename, content });
        return this;
    }

    async generateAsync(options = {}) {
        const type = options.type || 'blob';

        // Build ZIP file structure
        const zipData = this._buildZip();

        if (type === 'base64') {
            return this._arrayBufferToBase64(zipData);
        } else if (type === 'blob') {
            return new Blob([zipData], { type: 'application/zip' });
        } else if (type === 'arraybuffer') {
            return zipData;
        }

        return zipData;
    }

    _buildZip() {
        const encoder = new TextEncoder();
        const localFileHeaders = [];
        const centralDirectoryHeaders = [];
        let offset = 0;

        // Process each file
        for (const file of this.files) {
            const filenameBytes = encoder.encode(file.filename);
            const contentBytes = encoder.encode(file.content);
            const crc = this._crc32(contentBytes);

            // Check if filename contains non-ASCII characters (needs UTF-8 flag)
            const hasUnicode = file.filename !== file.filename.replace(/[^\x00-\x7F]/g, '');
            // Bit 11 (0x800) indicates UTF-8 encoded filename
            const generalPurposeFlag = hasUnicode ? 0x800 : 0;

            // Local file header
            const localHeader = this._buildLocalFileHeader(
                filenameBytes,
                contentBytes.length,
                crc,
                generalPurposeFlag
            );

            localFileHeaders.push({
                header: localHeader,
                filename: filenameBytes,
                content: contentBytes,
                offset: offset
            });

            // Central directory header
            const centralHeader = this._buildCentralDirectoryHeader(
                filenameBytes,
                contentBytes.length,
                crc,
                offset,
                generalPurposeFlag
            );
            centralDirectoryHeaders.push({
                header: centralHeader,
                filename: filenameBytes
            });

            offset += localHeader.length + filenameBytes.length + contentBytes.length;
        }

        // Calculate sizes
        const centralDirOffset = offset;
        let centralDirSize = 0;
        for (const cd of centralDirectoryHeaders) {
            centralDirSize += cd.header.length + cd.filename.length;
        }

        // End of central directory
        const endOfCentralDir = this._buildEndOfCentralDirectory(
            this.files.length,
            centralDirSize,
            centralDirOffset
        );

        // Combine all parts
        const totalSize = offset + centralDirSize + endOfCentralDir.length;
        const result = new Uint8Array(totalSize);
        let pos = 0;

        // Write local file headers and data
        for (const lf of localFileHeaders) {
            result.set(lf.header, pos);
            pos += lf.header.length;
            result.set(lf.filename, pos);
            pos += lf.filename.length;
            result.set(lf.content, pos);
            pos += lf.content.length;
        }

        // Write central directory
        for (const cd of centralDirectoryHeaders) {
            result.set(cd.header, pos);
            pos += cd.header.length;
            result.set(cd.filename, pos);
            pos += cd.filename.length;
        }

        // Write end of central directory
        result.set(endOfCentralDir, pos);

        return result.buffer;
    }

    _buildLocalFileHeader(filenameBytes, uncompressedSize, crc, generalPurposeFlag = 0) {
        const header = new Uint8Array(30);
        const view = new DataView(header.buffer);

        view.setUint32(0, 0x04034b50, true);  // Local file header signature
        view.setUint16(4, 20, true);          // Version needed to extract
        view.setUint16(6, generalPurposeFlag, true);  // General purpose bit flag (0x800 = UTF-8)
        view.setUint16(8, 0, true);           // Compression method (0 = stored)
        view.setUint16(10, 0, true);          // Last mod file time
        view.setUint16(12, 0, true);          // Last mod file date
        view.setUint32(14, crc, true);        // CRC-32
        view.setUint32(18, uncompressedSize, true);  // Compressed size
        view.setUint32(22, uncompressedSize, true);  // Uncompressed size
        view.setUint16(26, filenameBytes.length, true);  // Filename length
        view.setUint16(28, 0, true);          // Extra field length

        return header;
    }

    _buildCentralDirectoryHeader(filenameBytes, uncompressedSize, crc, localHeaderOffset, generalPurposeFlag = 0) {
        const header = new Uint8Array(46);
        const view = new DataView(header.buffer);

        view.setUint32(0, 0x02014b50, true);  // Central directory header signature
        view.setUint16(4, 20, true);          // Version made by
        view.setUint16(6, 20, true);          // Version needed to extract
        view.setUint16(8, generalPurposeFlag, true);  // General purpose bit flag (0x800 = UTF-8)
        view.setUint16(10, 0, true);          // Compression method
        view.setUint16(12, 0, true);          // Last mod file time
        view.setUint16(14, 0, true);          // Last mod file date
        view.setUint32(16, crc, true);        // CRC-32
        view.setUint32(20, uncompressedSize, true);  // Compressed size
        view.setUint32(24, uncompressedSize, true);  // Uncompressed size
        view.setUint16(28, filenameBytes.length, true);  // Filename length
        view.setUint16(30, 0, true);          // Extra field length
        view.setUint16(32, 0, true);          // File comment length
        view.setUint16(34, 0, true);          // Disk number start
        view.setUint16(36, 0, true);          // Internal file attributes
        view.setUint32(38, 0, true);          // External file attributes
        view.setUint32(42, localHeaderOffset, true);  // Relative offset of local header

        return header;
    }

    _buildEndOfCentralDirectory(fileCount, centralDirSize, centralDirOffset) {
        const header = new Uint8Array(22);
        const view = new DataView(header.buffer);

        view.setUint32(0, 0x06054b50, true);  // End of central directory signature
        view.setUint16(4, 0, true);           // Number of this disk
        view.setUint16(6, 0, true);           // Disk where central directory starts
        view.setUint16(8, fileCount, true);   // Number of central directory records on this disk
        view.setUint16(10, fileCount, true);  // Total number of central directory records
        view.setUint32(12, centralDirSize, true);  // Size of central directory
        view.setUint32(16, centralDirOffset, true);  // Offset of central directory
        view.setUint16(20, 0, true);          // Comment length

        return header;
    }

    _crc32(bytes) {
        // CRC-32 lookup table
        const table = SimpleZip._getCRC32Table();
        let crc = 0xFFFFFFFF;

        for (let i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
        }

        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    static _getCRC32Table() {
        if (SimpleZip._crc32Table) return SimpleZip._crc32Table;

        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c;
        }

        SimpleZip._crc32Table = table;
        return table;
    }

    _arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 32768;

        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            binary += String.fromCharCode.apply(null, chunk);
        }

        return btoa(binary);
    }
}

// Export a JSZip-compatible interface
async function loadJSZip() {
    return SimpleZip;
}

export { loadJSZip, SimpleZip };
export default loadJSZip;
