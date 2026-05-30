"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Mesh } from "three";
import type { PlayerSnapshot } from "@mvp/shared";
import {
  getPrediction,
  reconcileWithSnapshot,
} from "@/game/selfPrediction";

/**
 * Local player: rendered from the predicted position so WASD feels instant.
 * Every new server snapshot triggers a reconcile that blends or snaps the
 * prediction back to the authoritative truth.
 */
export function LocalPlayer({
  player,
}: {
  player: PlayerSnapshot;
}): JSX.Element {
  const meshRef = useRef<Mesh>(null);

  // Reconcile when the snapshot changes (server tick). Comparing primitives
  // by value avoids running on every render of the parent.
  useEffect(() => {
    reconcileWithSnapshot({
      x: player.x,
      y: player.y,
      z: player.z,
      rotationY: player.rotationY,
    });
  }, [player.x, player.y, player.z, player.rotationY]);

  useFrame(() => {
    const m = meshRef.current;
    if (!m) return;
    const p = getPrediction();
    m.position.set(p.x, p.y, p.z);
    m.rotation.y = p.rotationY;
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
