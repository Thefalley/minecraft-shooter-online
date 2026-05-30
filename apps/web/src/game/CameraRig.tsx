"use client";

import { useFrame } from "@react-three/fiber";
import { usePlayersStore } from "@/stores/playersStore";
import { getPrediction, isPredictionReady } from "@/game/selfPrediction";

const OFFSET_BACK = 10;
const OFFSET_UP = 6;

export function CameraRig({
  yawRef,
}: {
  yawRef: { current: number };
}): JSX.Element | null {
  useFrame(({ camera }) => {
    // Prefer the predicted position so the camera tracks the local player at
    // 60 Hz, with no input-to-render lag. Fall back to the server snapshot
    // until prediction is initialized (first frames after join).
    let cx: number;
    let cy: number;
    let cz: number;
    if (isPredictionReady()) {
      const p = getPrediction();
      cx = p.x;
      cy = p.y;
      cz = p.z;
    } else {
      const { selfId, players } = usePlayersStore.getState();
      if (!selfId) return;
      const self = players[selfId];
      if (!self) return;
      cx = self.x;
      cy = self.y;
      cz = self.z;
    }

    const yaw = yawRef.current;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    const targetX = cx + sin * OFFSET_BACK;
    const targetY = cy + OFFSET_UP;
    const targetZ = cz + cos * OFFSET_BACK;

    camera.position.x += (targetX - camera.position.x) * 0.18;
    camera.position.y += (targetY - camera.position.y) * 0.18;
    camera.position.z += (targetZ - camera.position.z) * 0.18;

    camera.lookAt(cx, cy + 1, cz);
  });

  return null;
}
