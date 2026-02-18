import * as crypto from 'crypto';

/**
 * Compute SHA-256 hash of file content.
 * Normalizes line endings (CRLF → LF) before hashing
 * to ensure consistent hashes across platforms.
 */
export function computeHash(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex');
}
