import { PLAYER_NAME_MAX_LENGTH, PLAYER_NAME_MIN_LENGTH } from "@mvp/shared";

export function isValidName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < PLAYER_NAME_MIN_LENGTH) return false;
  if (trimmed.length > PLAYER_NAME_MAX_LENGTH) return false;
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(trimmed)) return false;
  return true;
}

export function sanitizeName(name: string): string {
  return name.trim().slice(0, PLAYER_NAME_MAX_LENGTH);
}
