"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Canvas } from "@react-three/fiber";
import { HUD } from "@/components/HUD";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { StatsOverlay } from "@/components/StatsOverlay";
import { useInput } from "@/hooks/useInput";
import { useTransportSubscription } from "@/hooks/useTransportSubscription";
import { useLobbyStore } from "@/stores/lobbyStore";
import { resetPrediction } from "./selfPrediction";
import { tickFrame } from "./clientStats";
import { Ground } from "./Ground";
import { Players } from "./Players";
import { CameraRig } from "./CameraRig";
import { useFrame } from "@react-three/fiber";

function FrameTicker(): null {
  useFrame(() => {
    tickFrame(performance.now());
  });
  return null;
}

export function GameScene(): JSX.Element {
  useTransportSubscription();
  const { yawRef } = useInput();
  const router = useRouter();
  const leaveRoom = useLobbyStore((s) => s.leaveRoom);

  // Esc returns to lobby.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        await leaveRoom();
        router.push("/");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leaveRoom, router]);

  // Clear any prediction left over from a previous session.
  useEffect(() => {
    resetPrediction();
    return () => resetPrediction();
  }, []);

  return (
    <div className="game">
      <Canvas
        shadows
        camera={{ position: [0, 8, 12], fov: 60 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0a0c10"]} />
        <fog attach="fog" args={["#0a0c10", 30, 100]} />
        <ambientLight intensity={0.6} />
        <directionalLight
          position={[10, 20, 10]}
          intensity={1}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <Ground />
        <Players />
        <CameraRig yawRef={yawRef} />
        <FrameTicker />
      </Canvas>
      <HUD />
      <ConnectionBadge />
      <StatsOverlay />
      <div className="crosshair" />
    </div>
  );
}
