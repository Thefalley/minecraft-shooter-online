// Public surface of the networking layer.
//
// Game modules and the boot entry-point import only from here so the internal
// file layout can shift without touching every call site.

export { NetworkBridge } from "./NetworkBridge.js";
export { ColyseusClient } from "./ColyseusClient.js";
export { InputPump } from "./InputPump.js";
export { RemotePlayerMesh } from "./RemotePlayerMesh.js";
export { MultiplayerCoordinator } from "./MultiplayerCoordinator.js";
export { RemotePlayerRegistry } from "./RemotePlayerRegistry.js";
export { EnemySync } from "./EnemySync.js";
export { readJoinParams, clearJoinParams } from "./UrlParams.js";
