import AdmZip from 'adm-zip';
import * as path from 'node:path';

export interface ZipValidationResult {
  valid: boolean;
  error?: string;
}

const MAX_ZIP_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Validates an uploaded ZIP buffer before writing or extracting it:
 * 1. Verifies ZIP magic header (PK\x03\x04 or PK\x05\x06).
 * 2. Caps total entry count to prevent inode exhaustion.
 * 3. Caps total uncompressed size to prevent zip-bomb decompression attacks.
 * 4. Rejects any entry with path traversal (`..`), absolute paths, or Windows drive prefixes (Zip-Slip protection).
 */
export function validateZipBuffer(buffer: Buffer): ZipValidationResult {
  if (!buffer || buffer.length < 4) {
    return { valid: false, error: 'Invalid archive: file is empty or too small to be a ZIP archive.' };
  }

  const isZipMagic =
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06));

  if (!isZipMagic) {
    return { valid: false, error: 'Invalid archive: file does not have a valid ZIP header.' };
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err: any) {
    return { valid: false, error: `Invalid or corrupted ZIP archive: ${err?.message || 'parse error'}` };
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    return { valid: false, error: 'Invalid archive: ZIP contains no files.' };
  }
  if (entries.length > MAX_ZIP_ENTRIES) {
    return {
      valid: false,
      error: `Invalid archive: ZIP contains ${entries.length} entries, exceeding the maximum of ${MAX_ZIP_ENTRIES}.`,
    };
  }

  let totalUncompressed = 0;
  const dummyRoot = path.resolve('/tmp/zip-validation-root');

  for (const entry of entries) {
    const rawName = entry.entryName || '';
    const normalized = rawName.replace(/\\/g, '/');

    if (
      normalized.startsWith('/') ||
      normalized.includes('\0') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      return {
        valid: false,
        error: `Unsafe ZIP entry path rejected (Zip-Slip protection): "${rawName}"`,
      };
    }

    const resolvedTarget = path.resolve(dummyRoot, normalized);
    if (resolvedTarget !== dummyRoot && !resolvedTarget.startsWith(dummyRoot + path.sep)) {
      return {
        valid: false,
        error: `Unsafe ZIP entry path escapes root (Zip-Slip protection): "${rawName}"`,
      };
    }

    const entrySize = Number(entry.header?.size ?? 0);
    if (entrySize < 0) {
      return { valid: false, error: 'Invalid ZIP entry size.' };
    }
    totalUncompressed += entrySize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      return {
        valid: false,
        error: `Archive uncompressed size exceeds the 500 MB limit (Zip-Bomb protection).`,
      };
    }
  }

  return { valid: true };
}
