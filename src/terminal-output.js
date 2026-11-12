/** Bounded terminal history with UTF-16 offsets, shared by independent readers. */
export function createTerminalOutput(initial = '', maxBytes = 1024 * 1024) {
  let text = '';
  let end = 0;
  const limit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 1024 * 1024;
  // Bytes retained in `text`; tracked incrementally so a chunk never has to
  // re-encode the whole history. A busy session produced one full 2MB
  // encode+decode per chunk before, which saturated the host event loop once
  // a few terminals were open.
  let textBytes = 0;
  const journal = {
    append(chunk) {
      end += chunk.length;
      text += chunk;
      textBytes += Buffer.byteLength(chunk, 'utf8');
      if (textBytes <= limit) return;
      // Over budget: trim once, measuring from the byte cap itself so the
      // retained tail is exactly the last `limit` bytes when a code point sits
      // on the boundary (the original semantics). The saving over the old code
      // is that this now runs on overflow only, not on every chunk.
      const bytes = Buffer.from(text, 'utf8');
      let start = Math.max(0, bytes.length - limit);
      // Never retain half a UTF-8 code point: offsets must match decoded text.
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      text = bytes.subarray(start).toString('utf8');
      textBytes = Buffer.byteLength(text, 'utf8');
    },
    read(after, maxChars) {
      const start = end - text.length;
      let from = Number.isSafeInteger(after) ? Math.min(end, Math.max(start, after)) : start;
      // A caller cannot start in the middle of a surrogate pair.
      const code = text.charCodeAt(from - start);
      if (code >= 0xdc00 && code <= 0xdfff) from++;
      // `maxChars` bounds one read so a stream consumer that is behind does not
      // hand the whole retained history to `encodeData` on every iteration;
      // `offset` stays at the last delivered character, so the next call picks
      // up exactly here.
      if (Number.isSafeInteger(maxChars) && maxChars > 0) {
        let to = Math.min(end, from + maxChars);
        const tail = text.charCodeAt(to - start);
        // Never split a surrogate pair across two reads.
        if (tail >= 0xd800 && tail <= 0xdbff) to--;
        if (to <= from) to = Math.min(end, from + 1);
        return { data: text.slice(from - start, to - start), startOffset: from, offset: to };
      }
      return { data: text.slice(from - start), startOffset: from, offset: end };
    },
    readWindow(after, maxBytes) {
      const start = end - text.length;
      const limit = Number.isSafeInteger(maxBytes) ? Math.max(1, maxBytes) : 24 * 1024;
      let from = Number.isSafeInteger(after) ? Math.min(end, Math.max(start, after)) : start;
      const wasClamped = Number.isSafeInteger(after) && after < start;
      const code = text.charCodeAt(from - start);
      if (code >= 0xdc00 && code <= 0xdfff) from++;
      let available = text.slice(from - start);
      let bytes = Buffer.from(available, "utf8");
      if (bytes.length > limit) {
        if (after === undefined) {
          bytes = bytes.subarray(bytes.length - limit);
          while (bytes.length > 0 && (bytes[0] & 0xc0) === 0x80) bytes = bytes.subarray(1);
          available = bytes.toString("utf8");
          from = end - available.length;
        } else {
          bytes = bytes.subarray(0, limit);
          while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes = bytes.subarray(0, bytes.length - 1);
          available = bytes.toString("utf8");
        }
      }
      const nextOffset = from + available.length;
      return { data: available, historyStart: start, historyEnd: end, offset: from, nextOffset, wasClamped, hasMore: nextOffset < end };
    }
  };
  journal.append(initial);
  return journal;
}
