import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@mvp/shared";

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[idx];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  if (typeof code !== "string") return false;
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const c of code.toUpperCase()) {
    if (!ROOM_CODE_ALPHABET.includes(c)) return false;
  }
  return true;
}

export function normalizeRoomCode(code: string): string {
  return code.toUpperCase();
}
