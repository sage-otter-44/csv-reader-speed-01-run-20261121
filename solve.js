// A faster drop-in for csv-reader 1.0.0: the same reading of a CSV text, done with span
// scans instead of one character at a time.
//
// The reference reads one character at a time and builds every field a character at a time.
// This reader finds each field's end with indexOf and takes the field as one slice, which is
// where the time goes: a plain record costs a few indexOf calls and a few slices, and only
// the odd paths (a stray CR, junk after a closing quote, a quote that never closes, a line
// break inside quotes) leave the span scan. The hot loop is kept small on purpose: the odd
// paths live in their own functions below, so the loop itself compiles fast and stays
// compiled.
//
// The reading itself is csv-reader 1.0.0's policy, restated here from the competition's
// rules so the code can be checked against it without the reference at hand:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled; "" inside
//     it is one quote, and each CRLF or lone CR inside it is read as LF; what follows its
//     closing quote, up to the next comma or line break, is appended as it stands
//     (quote_junk, when the field ends); a quote that never closes is a literal character
//     and the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never
//     trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records
//     after it (every record when header is false), each padded with "" (short_row, with
//     fields: its field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based line the
//     record starts on, row its index in rows (null for the header); a field's quote_junk
//     is recorded when the field ends, a record's short_row or long_row when the record
//     ends.
//
// How a field ended: at a comma (the record goes on), at a line break or at the end of the
// text (the record ends).
const COMMA = 0;
const BREAK = 1;
const END = 2;

// text[a..b) appended to `value` with every CR dropped; returns [value, kept] where kept
// counts the characters kept. One stray_cr error is recorded per CR dropped. Only called
// when the span is already known to hold a CR.
function appendStripped(text, value, a, b, recordLine, recordRow, errors) {
  let out = value;
  let kept = 0;
  let s = a;
  for (;;) {
    const r = text.indexOf('\r', s);
    if (r === -1 || r >= b) {
      out += text.slice(s, b);
      kept += b - s;
      return [out, kept];
    }
    errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    out += text.slice(s, r);
    kept += r - s;
    s = r + 1;
  }
}

// Reads an unquoted field from `start`, building on `value`. Returns [value, ended, next,
// kept, line] where kept counts the characters kept (a CR dropped on the way counts for
// nothing) and line is the line the character at next is on. Only used where the field is
// already known to be odd: the junk after a closing quote, and the re-read after a quote
// that never closes.
function readUnquoted(text, n, value, start, line, recordLine, recordRow, errors) {
  let comma = text.indexOf(',', start);
  if (comma === -1) comma = n;
  let lf = text.indexOf('\n', start);
  if (lf === -1) lf = n;
  let end;
  let next;
  let ended;
  if (comma < lf) {
    end = comma;
    next = comma + 1;
    ended = COMMA;
  } else if (lf < n) {
    end = text.charCodeAt(lf - 1) === 13 ? lf - 1 : lf;
    next = lf + 1;
    ended = BREAK;
  } else {
    end = n;
    next = n;
    ended = END;
  }
  if (ended === BREAK) line += 1;
  const span = text.slice(start, end);
  if (span.indexOf('\r') === -1) return [value + span, ended, next, end - start, line];
  const stripped = appendStripped(text, value, start, end, recordLine, recordRow, errors);
  return [stripped[0], ended, next, stripped[1], line];
}

// Reads a field that opens with a quote at `start`. Returns [value, ended, next, line].
function readQuoted(text, n, start, line, recordLine, recordRow, errors) {
  const open = start;
  const openLine = line;
  let value = '';
  let segStart = start + 1;
  let pos = start + 1;
  for (;;) {
    const q = text.indexOf('"', pos);
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      const reread = readUnquoted(text, n, '"', open + 1, openLine, recordLine, recordRow, errors);
      return [reread[0], reread[1], reread[2], reread[4]];
    }
    const seg = text.slice(segStart, q);
    if (seg.indexOf('\r') !== -1 || seg.indexOf('\n') !== -1) {
      // Each CRLF or lone CR inside quotes is read as one LF, one line each.
      const parts = seg.split(/\r\n|\r|\n/);
      line += parts.length - 1;
      value += parts.join('\n');
    } else {
      value += seg;
    }
    if (text.charCodeAt(q + 1) === 34) {
      // A doubled quote is one quote; the field goes on.
      value += '"';
      pos = q + 2;
      segStart = pos;
      continue;
    }
    // The quote closes here.
    pos = q + 1;
    if (pos >= n) return [value, END, pos, line];
    const c = text.charCodeAt(pos);
    if (c === 44) return [value, COMMA, pos + 1, line];
    if (c === 10) return [value, BREAK, pos + 1, line + 1];
    if (c === 13 && text.charCodeAt(pos + 1) === 10) return [value, BREAK, pos + 2, line + 1];
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break.
    const junk = readUnquoted(text, n, value, pos, line, recordLine, recordRow, errors);
    if (junk[3] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return [junk[0], junk[1], junk[2], junk[4]];
  }
}

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1; // the line the character at pos is on

  while (true) {
    // A line left with no characters is no record.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended;
    let lastQuoted = false;

    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const field = readQuoted(text, n, pos, line, recordLine, recordRow, errors);
        fields.push(field[0]);
        ended = field[1];
        pos = field[2];
        line = field[3];
      } else {
        // An unquoted field: it ends at the next comma or line break.
        lastQuoted = false;
        let comma = text.indexOf(',', pos);
        if (comma === -1) comma = n;
        let lf = text.indexOf('\n', pos);
        if (lf === -1) lf = n;
        let end;
        let next;
        if (comma < lf) {
          end = comma;
          next = comma + 1;
          ended = COMMA;
        } else if (lf < n) {
          end = text.charCodeAt(lf - 1) === 13 ? lf - 1 : lf;
          next = lf + 1;
          ended = BREAK;
        } else {
          end = n;
          next = n;
          ended = END;
        }
        const span = text.slice(pos, end);
        if (span.indexOf('\r') === -1) {
          fields.push(span);
        } else {
          // A CR inside, not followed by LF, is dropped (stray_cr).
          fields.push(appendStripped(text, '', pos, end, recordLine, recordRow, errors)[0]);
        }
        if (ended === BREAK) line += 1;
        pos = next;
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
