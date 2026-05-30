"use client";

import { useMemo } from "react";
import { usePlayersStore } from "@/stores/playersStore";
import { LocalPlayer } from "./LocalPlayer";
import { RemotePlayer } from "./RemotePlayer";

export function Players(): JSX.Element {
  const players = usePlayersStore((s) => s.players);
  const selfId = usePlayersStore((s) => s.selfId);

  const list = useMemo(() => Object.values(players), [players]);

  return (
    <>
      {list.map((p) =>
        p.id === selfId ? (
          <LocalPlayer key={p.id} player={p} />
        ) : (
          <RemotePlayer key={p.id} player={p} />
        )
      )}
    </>
  );
}
