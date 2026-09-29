import type { Household } from "./types";

export function formatMoney(minor: number, household?: Household | null, compact = false) {
  const currency = household?.currency ?? "INR";
  const locale = currency === "INR" ? "en-IN" : "en";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: compact ? 1 : 2,
    notation: compact ? "compact" : "standard",
  }).format(minor / 100);
}

export function toMinor(value: string): number {
  const normalized = value.replace(/[^0-9.-]/g, "");
  return Math.round(Number(normalized || "0") * 100);
}

function calendarParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function todayIso(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const { year, month, day } = calendarParts(new Date(), timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatDate(value: string, style: "short" | "medium" = "medium") {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: style === "short" ? "short" : "long",
    year: style === "medium" ? "numeric" : undefined,
  }).format(new Date(`${value}T00:00:00`));
}

export type PeriodKey = "7d" | "month" | "quarter" | "half" | "year" | "custom";

export function periodRange(period: PeriodKey, anchor = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = calendarParts(anchor, timeZone);
  const end = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  let start: Date;
  switch (period) {
    case "7d":
      start = new Date(end);
      start.setDate(end.getDate() - 6);
      break;
    case "quarter":
      start = new Date(Date.UTC(end.getUTCFullYear(), Math.floor(end.getUTCMonth() / 3) * 3, 1));
      break;
    case "half":
      start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() < 6 ? 0 : 6, 1));
      break;
    case "year":
      start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
      break;
    case "custom":
    case "month":
    default:
      start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  }
  const iso = (date: Date) => {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  return { from: iso(start), to: iso(end) };
}

export function percent(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

export function apiItems<T>(value: { items: T[] } | T[]): T[] {
  return Array.isArray(value) ? value : value.items;
}
