"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Group } from "three";
import type { PlayerSnapshot } from "@mvp/shared";

/**
 * Snapshot interpolation buffer (Source/Quake style).
 *
 * Each new server snapshot is timestamped and pushed into a small ring.
 * Every frame we sample the buffer at `now - INTERP_DELAY_MS` and interpolate
 * between the two snapshots that bracket that render time. The result is a
 * silky-smooth playback even when snapshots arrive at 20 Hz with jitter.
 *
 * Trade-off: remotes lag behind real time by INTERP_DELAY_MS. In a casual
 * shooter that's invisible; in a precision FPS you'd add lag compensation
 * server-side. We can revisit when combat lands.
 */
const SNAPSHOT_BUFFER_SIZE = 24;
const INTERP_DELAY_MS = 120;

type BufferEntry = {
  t: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
};

function shortAngleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function RemotePlayer({
  player,
}: {
  player: PlayerSnapshot;
}): JSX.Element {
  const groupRef = useRef<Group>(null);
  const bufferRef = useRef<BufferEntry[]>([]);

  useEffect(() => {
    const buf = bufferRef.current;
    const now = performance.now();
    const last = buf[buf.length - 1];
    // Drop out-of-order or duplicate snapshots so the interpolator never
    // sees a negative time span.
    if (last && last.t >= now) return;
    buf.push({
      t: now,
      x: player.x,
      y: player.y,
      z: player.z,
      rotationY: player.rotationY,
    });
    if (buf.length > SNAPSHOT_BUFFER_SIZE) buf.shift();
  }, [player.x, player.y, player.z, player.rotationY]);

  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const buf = bufferRef.current;
    if (buf.length === 0) return;

    const renderT = performance.now() - INTERP_DELAY_MS;

    // Render time is older than our oldest sample → stick with oldest.
    if (renderT <= buf[0]!.t) {
      const a = buf[0]!;
      g.position.set(a.x, a.y, a.z);
      g.rotation.y = a.rotationY;
      return;
    }
    // Render time is newer than the freshest sample → buffer underrun;
    // stick with the latest sample (mild stutter rather than extrapolation).
    const newest = buf[buf.length - 1]!;
    if (renderT >= newest.t) {
      g.position.set(newest.x, newest.y, newest.z);
      g.rotation.y = newest.rotationY;
      return;
    }

    // Linear scan from the end to find the pair bracketing renderT.
    let i = buf.length - 1;
    while (i > 0 && buf[i]!.t > renderT) i--;
    const a = buf[i]!;
    const b = buf[i + 1]!;
    const span = b.t - a.t;
    const alpha = span > 0 ? (renderT - a.t) / span : 0;

    g.position.x = a.x + (b.x - a.x) * alpha;
    g.position.y = a.y + (b.y - a.y) * alpha;
    g.position.z = a.z + (b.z - a.z) * alpha;
    g.rotation.y = a.rotationY + shortAngleDelta(a.rotationY, b.rotationY) * alpha;
  });

  return (
    <group ref={groupRef}>
      <mesh castShadow>
        <capsuleGeometry args={[0.4, 1.2, 8, 16]} />
        <meshStandardMaterial color={player.alive ? "#ef5b5b" : "#5a2a31"} />
      </mesh>
      <Html
        position={[0, 1.6, 0]}
        center
        distanceFactor={10}
        zIndexRange={[1, 0]}
      >
        <div className="player-label">{player.name}</div>
      </Html>
    </group>
  );
}
