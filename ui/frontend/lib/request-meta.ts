export function getClientLocalTimeIso(): string {
  return new Date().toISOString();
}

export function getClientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function withClientMetaHeaders(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers || {});
  headers.set("X-Client-Local-Time", getClientLocalTimeIso());
  const tz = getClientTimezone();
  if (tz) headers.set("X-Client-Timezone", tz);
  return { ...(init || {}), headers };
}

