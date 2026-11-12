import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { MAX_REPORT_BYTES, parseSavedReport } from './web/report-compare.mjs';

/** Open the named file once, refusing final-component symlinks and non-regular files. */
export async function readSavedReport(path, label) {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('Offline comparison needs nonblocking, no-follow file support on this platform.');
  let handle;
  try {
    // NONBLOCK avoids waiting for a FIFO writer before fstat can reject the FIFO.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | (constants.O_NOCTTY || 0));
  } catch (error) {
    const code = ['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'ENXIO', 'EINVAL', 'EMFILE', 'ENFILE'].includes(error.code) ? error.code : 'read error';
    throw new Error(`Cannot open ${label} report (${code}); use a readable regular file, not a symlink.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Use a regular file; directories, FIFOs and devices are not accepted.');
    if (stat.size > MAX_REPORT_BYTES) throw new Error('Saved report exceeds the 5 MiB limit.');
    const chunks = [];
    let total = 0;
    // Read at most limit+1, including if the file grows after fstat.
    while (total <= MAX_REPORT_BYTES) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_REPORT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_REPORT_BYTES) throw new Error('Saved report exceeds the 5 MiB limit.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch { throw new Error('Saved report must be UTF-8 JSON.'); }
    return parseSavedReport(text);
  } catch (error) {
    // Filesystem errors can contain paths; never echo their original message.
    throw new Error(`${label} report: ${error.code ? 'could not read file.' : error.message}`);
  } finally { await handle.close(); }
}
