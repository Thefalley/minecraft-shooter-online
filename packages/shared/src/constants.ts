// Server tick rate and intervals
export const TICK_RATE = 20; // ticks per second
export const TICK_INTERVAL_MS = 1000 / TICK_RATE; // 50ms

// Player limits
export const MAX_PLAYERS_PER_ROOM = 8;
export const PLAYER_NAME_MIN_LENGTH = 2;
export const PLAYER_NAME_MAX_LENGTH = 16;

// Movement
export const PLAYER_SPEED = 6; // units per second on ground plane
export const PLAYER_MAX_DELTA = PLAYER_SPEED * (TICK_INTERVAL_MS / 1000) * 1.5;
export const WORLD_HALF_SIZE = 50; // bounds: -50..50 on X and Z
export const PLAYER_SPAWN_Y = 1;
export const PLAYER_DEFAULT_HEALTH = 100;

// Room codes
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0,1,I,O

// Networking
export const SERVER_DEFAULT_PORT = 2567;
export const GAME_ROOM_NAME = "game" as const;
