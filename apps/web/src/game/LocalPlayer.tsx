"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Mesh } from "three";
import type { PlayerSnapshot } from "@mvp/shared";

const LERP = 0.25;

export function LocalPlayer({
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
    <mesh
      ref={meshRef}
      position={[player.x, player.y, player.z]}
      rotation={[0, player.rotationY, 0]}
      castShadow
    >
      <capsuleGeometry args={[0.4, 1.2, 8, 16]} />
      <meshStandardMaterial color="#5b8def" />
    </mesh>
  );
}
