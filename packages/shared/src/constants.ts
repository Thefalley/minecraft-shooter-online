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

// Voxel world constants — Phase 1
export const BLOCK_INTERACTION_RANGE = 6; // server validation tolerance for mine/place
export const WORLD_WIDTH = 64;
export const WORLD_DEPTH = 64;
export const WORLD_MAX_HEIGHT = 20;
export const WORLD_WATER_LEVEL = 6;

// Networking — voxel multiplayer
export const INPUT_PUMP_RATE = TICK_RATE; // 20 Hz, matches server tick
export const INPUT_PUMP_INTERVAL_MS = TICK_INTERVAL_MS;
export const SNAPSHOT_INTERPOLATION_DELAY_MS = 120;
export const RECONCILE_HARD_SNAP_DISTANCE = 1.5;
export const LAG_COMPENSATION_WINDOW_MS = 300;

// Combat
export const PROJECTILE_LIFETIME_S = 3.25;
export const FIREBALL_COLLISION_RADIUS = 1.15;

// Wave / shop
export const SHOP_DURATION_MS = 30000;
export const DEFAULT_WAVE_COUNT = 10;
