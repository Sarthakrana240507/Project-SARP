// Minimal RFC 4180 CSV parser (no dependency).
// Handles: quoted fields, commas/newlines inside quotes, "" escaped quotes,
// CRLF / LF / CR line endings, a leading UTF-8 BOM, and blank lines.
// Returns { records: [{ line, fields: [] }] } where `line` is the physical line
// number the record starts on (used for error messages), or throws on malformed input.
function parseCsv(input) {
  let text = String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let fieldWasQuoted = false;

  const endField = () => { fields.push(field); field = ''; fieldWasQuoted = false; };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0].trim() === '';
    if (!blank) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '' && !fieldWasQuoted) { inQuotes = true; fieldWasQuoted = true; }
    else if (c === '"') throw new Error(`Unexpected quote on line ${line}`);
    else if (c === ',') endField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else field += c;
  }
  if (inQuotes) throw new Error(`Unterminated quoted field starting near line ${recordLine}`);
  if (field !== '' || fields.length > 0 || fieldWasQuoted) endRecord();
  return { records };
}

module.exports = { parseCsv };
