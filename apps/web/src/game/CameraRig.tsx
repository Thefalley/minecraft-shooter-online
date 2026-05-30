"use client";

import { useFrame } from "@react-three/fiber";
import { usePlayersStore } from "@/stores/playersStore";

const OFFSET_BACK = 10;
const OFFSET_UP = 6;

export function CameraRig({
  yawRef,
}: {
  yawRef: { current: number };
}): JSX.Element | null {
  useFrame(({ camera }) => {
    const { selfId, players } = usePlayersStore.getState();
    if (!selfId) return;
    const self = players[selfId];
    if (!self) return;

    const yaw = yawRef.current;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    const targetX = self.x + sin * OFFSET_BACK;
    const targetY = self.y + OFFSET_UP;
    const targetZ = self.z + cos * OFFSET_BACK;

    camera.position.x += (targetX - camera.position.x) * 0.12;
    camera.position.y += (targetY - camera.position.y) * 0.12;
    camera.position.z += (targetZ - camera.position.z) * 0.12;

    camera.lookAt(self.x, self.y + 1, self.z);
  });

  return null;
}
