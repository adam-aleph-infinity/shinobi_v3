export type DateInput = string | number | Date | null | undefined;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseServerDate(value: DateInput): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  let s = String(value).trim();
  if (!s) return null;

  // "YYYY-MM-DD HH:MM:SS" -> ISO-like
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    s = s.replace(/\s+/, "T");
  }

  // Naive ISO timestamps from backend are UTC in this app.
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s) &&
    !/[zZ]$/.test(s) &&
    !/[+-]\d{2}:\d{2}$/.test(s)
  ) {
    s = `${s}Z`;
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLocalDateTime(value: DateInput, includeSeconds = true): string {
  const d = parseServerDate(value);
  if (!d) return "—";
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = includeSeconds
    ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${date} ${time}`;
}

export function formatLocalDate(value: DateInput): string {
  const d = parseServerDate(value);
  if (!d) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function formatLocalTime(value: DateInput, includeSeconds = true): string {
  const d = parseServerDate(value);
  if (!d) return "—";
  return includeSeconds
    ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Convert an HH:MM:SS UTC timestamp (from backend logs) to viewer local time. */
export function utcHmsToLocal(hms: string): string {
  const m = String(hms || "").trim().match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return hms || "";
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
  ));
  return formatLocalTime(d, true);
}

