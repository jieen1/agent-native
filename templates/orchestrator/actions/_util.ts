import { customAlphabet } from "nanoid";

const gen = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

/** Prefixed, url-safe id, e.g. "task_a1b2...". */
export function newId(prefix: string): string {
  return `${prefix}_${gen()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
