"use client";

import dynamic from "next/dynamic";

const GameScene = dynamic(
  () => import("@/game/Scene").then((m) => m.GameScene),
  { ssr: false }
);

export default function PlayPage() {
  return <GameScene />;
}
