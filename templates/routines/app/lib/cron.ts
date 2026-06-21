/**
 * Client-side cron helpers for live form feedback only.
 *
 * The authoritative cron validation lives server-side in `save-routine`
 * (`isValidCron` from `@agent-native/core/jobs`, backed by `cron-parser`). We do
 * NOT import that subpath into the browser bundle because its barrel re-exports
 * the scheduler/tools (server + DB only). These pure helpers give instant UX
 * echo while editing; the server stays the source of truth on save and the
 * action returns the canonical `describeCron`.
 *
 * `describeCron` is a faithful port of `packages/core/src/jobs/cron.ts` so the
 * live echo matches what the action returns. `looksLikeCron` is a lightweight
 * 5-field structural check — it never claims an expression the server will
 * reject is fine for *display*, but the real gate is the server.
 */

const DAY_NAMES: Record<string, string> = {
  "0": "Sunday",
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
  "7": "Sunday",
};

const ALIASES: Record<string, string> = {
  "@midnight": "0 0 * * *",
  "@daily": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function normalize(cronExpr: string): string {
  return ALIASES[cronExpr.trim().toLowerCase()] ?? cronExpr;
}

/**
 * Lightweight structural validation for instant form feedback. Accepts a
 * 5-field expression or a known alias. The server's `isValidCron` is the
 * authoritative gate on save.
 */
export function looksLikeCron(cronExpr: string): boolean {
  const trimmed = cronExpr.trim();
  if (!trimmed) return false;
  if (ALIASES[trimmed.toLowerCase()]) return true;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  const fieldChars = /^[\d*/,\-A-Za-z]+$/;
  return parts.every((part) => fieldChars.test(part));
}

/**
 * Human-readable description of a cron expression. Faithful port of
 * `describeCron` in core so the live echo matches the action result. Falls back
 * to the raw expression for patterns it does not specialize.
 */
export function describeCron(cronExpr: string): string {
  const normalized = normalize(cronExpr);
  const parts = normalized.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (normalized === "* * * * *") return "Every minute";

  const minMatch = minute.match(/^\*\/(\d+)$/);
  if (
    minMatch &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every ${minMatch[1]} minutes`;
  }

  if (
    minute !== "*" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return `Every hour at :${minute.padStart(2, "0")}`;
  }

  const formatTime = (h: string, m: string): string => {
    if (h === "*") return "";
    const hours = h.split(",").map((hh) => {
      const hr = parseInt(hh, 10);
      const ampm = hr >= 12 ? "PM" : "AM";
      const hr12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
      const min = m === "0" || m === "00" ? "" : `:${m.padStart(2, "0")}`;
      return `${hr12}${min} ${ampm}`;
    });
    return hours.join(" and ");
  };

  const time = formatTime(hour, minute);

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && time) {
    return `Every day at ${time}`;
  }

  if (
    dayOfMonth === "*" &&
    month === "*" &&
    (dayOfWeek === "1-5" || dayOfWeek === "MON-FRI") &&
    time
  ) {
    return `Every weekday at ${time}`;
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*" && time) {
    const days = dayOfWeek.split(",").map((d) => DAY_NAMES[d] || d);
    return `Every ${days.join(", ")} at ${time}`;
  }

  if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*" && time) {
    return `On day ${dayOfMonth} of every month at ${time}`;
  }

  return cronExpr;
}

/** Common cron presets for the editor's quick-pick. */
export interface CronPreset {
  id: string;
  label: string;
  cron: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { id: "daily-8am", label: "Every day at 8:00 AM", cron: "0 8 * * *" },
  {
    id: "weekday-830",
    label: "Every weekday at 8:30 AM",
    cron: "30 8 * * 1-5",
  },
  { id: "hourly", label: "Every hour", cron: "0 * * * *" },
] as const;

export const CUSTOM_CRON_PRESET_ID = "custom";

/** Find the preset matching an expression, or "custom" when none match. */
export function presetIdForCron(cron: string): string {
  const trimmed = cron.trim();
  const match = CRON_PRESETS.find((preset) => preset.cron === trimmed);
  return match?.id ?? CUSTOM_CRON_PRESET_ID;
}
