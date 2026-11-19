// Spreadsheet-safe CSV cell. Text that starts with = + - @ (or a tab / carriage return) can run as a formula
// when the file is opened in Excel or Sheets, and students choose their own titles, so such cells get a leading '.
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
module.exports = { csvCell };
