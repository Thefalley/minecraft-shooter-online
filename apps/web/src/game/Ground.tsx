"use client";

import { Grid } from "@react-three/drei";
import { WORLD_HALF_SIZE } from "@mvp/shared";

const SIZE = WORLD_HALF_SIZE * 2;

export function Ground(): JSX.Element {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[SIZE, SIZE]} />
        <meshStandardMaterial color="#1d2128" />
      </mesh>
      <Grid
        position={[0, 0.01, 0]}
        args={[SIZE, SIZE]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#2c313b"
        sectionSize={10}
        sectionThickness={1.2}
        sectionColor="#3a4150"
        fadeDistance={SIZE}
        fadeStrength={1}
        infiniteGrid={false}
      />
    </group>
  );
}
