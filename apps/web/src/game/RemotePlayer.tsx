"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Mesh } from "three";
import type { PlayerSnapshot } from "@mvp/shared";

const LERP = 0.2;

export function RemotePlayer({
  player,
}: {
  player: PlayerSnapshot;
}): JSX.Element {
  const meshRef = useRef<Mesh>(null);

  useFrame(() => {
    const m = meshRef.current;
    if (!m) return;
    m.position.x += (player.x - m.position.x) * LERP;
    m.position.y += (player.y - m.position.y) * LERP;
    m.position.z += (player.z - m.position.z) * LERP;
    m.rotation.y += (player.rotationY - m.rotation.y) * LERP;
  });

  return (
    <group>
      <mesh
        ref={meshRef}
        position={[player.x, player.y, player.z]}
        rotation={[0, player.rotationY, 0]}
        castShadow
      >
        <capsuleGeometry args={[0.4, 1.2, 8, 16]} />
        <meshStandardMaterial color={player.alive ? "#ef5b5b" : "#5a2a31"} />
      </mesh>
      <Html
        position={[player.x, player.y + 1.6, player.z]}
        center
        distanceFactor={10}
        zIndexRange={[1, 0]}
      >
        <div className="player-label">{player.name}</div>
      </Html>
    </group>
  );
}
