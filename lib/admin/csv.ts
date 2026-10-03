// Pure CSV serialization (RFC 4180) with spreadsheet formula-injection
// protection. No Prisma / server-only imports — safe to unit test directly.

// A formula may be preceded by whitespace / control characters, so look past
// them (" =1+1"), and always treat a leading tab / CR as dangerous.
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r]/;
// Plain phone / number shapes ("+213 (0) 555-12-34", "-5"): a sign followed by
// digits and plain spaces / separators only (no tabs or newlines). These cannot
// encode a function call, so they are left untouched instead of being prefixed.
const NUMERIC_LIKE = /^[+-]?\(?\d[ \d().-]*$/;

/**
 * Cells that a spreadsheet would interpret as a formula (=, +, -, @, tab, CR)
 * are prefixed with a single quote so they render as inert text. Attendees
 * control these values (names, organisation...), so this is attacker input.
 */
export function neutralizeFormula(value: string): string {
  if (!FORMULA_START.test(value)) return value;
  if (!/^[\t\r]/.test(value) && NUMERIC_LIKE.test(value)) return value;
  return `'${value}`;
}

export function csvCell(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let value =
    raw instanceof Date ? raw.toISOString() : String(raw);
  value = neutralizeFormula(value);
  if (/[",\r\n]/.test(value) || value !== value.trim()) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** UTF-8 BOM + CRLF rows, so Excel opens accented / Arabic text correctly. */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
