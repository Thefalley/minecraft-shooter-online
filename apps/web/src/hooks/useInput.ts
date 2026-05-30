"use client";

import { useEffect, useRef } from "react";
import { TICK_INTERVAL_MS, type PlayerInput } from "@mvp/shared";
import { getTransport } from "@/networking/colyseusTransport";
import { applyLocalInput } from "@/game/selfPrediction";

const YAW_RATE = 2.4; // radians per second when holding Q or E

type KeyState = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  yawLeft: boolean;
  yawRight: boolean;
};

function emptyKeys(): KeyState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    yawLeft: false,
    yawRight: false,
  };
}

export type UseInputResult = {
  yawRef: { current: number };
};

/**
 * Captures keyboard state and pumps it to the server at TICK_INTERVAL_MS.
 * Q/E rotate a local yaw value that the camera reads each frame.
 */
export function useInput(): UseInputResult {
  const yawRef = useRef(0);
  const keysRef = useRef<KeyState>(emptyKeys());
  const seqRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          keysRef.current.forward = true;
          break;
        case "KeyS":
        case "ArrowDown":
          keysRef.current.backward = true;
          break;
        case "KeyA":
        case "ArrowLeft":
          keysRef.current.left = true;
          break;
        case "KeyD":
        case "ArrowRight":
          keysRef.current.right = true;
          break;
        case "KeyQ":
          keysRef.current.yawLeft = true;
          break;
        case "KeyE":
          keysRef.current.yawRight = true;
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          keysRef.current.forward = false;
          break;
        case "KeyS":
        case "ArrowDown":
          keysRef.current.backward = false;
          break;
        case "KeyA":
        case "ArrowLeft":
          keysRef.current.left = false;
          break;
        case "KeyD":
        case "ArrowRight":
          keysRef.current.right = false;
          break;
        case "KeyQ":
          keysRef.current.yawLeft = false;
          break;
        case "KeyE":
          keysRef.current.yawRight = false;
          break;
      }
    };

    const onBlur = () => {
      keysRef.current = emptyKeys();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    // Drive yaw integration from a high-frequency rAF loop so it feels smooth.
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const k = keysRef.current;
      if (k.yawLeft) yawRef.current -= YAW_RATE * dt;
      if (k.yawRight) yawRef.current += YAW_RATE * dt;
      // Client-side prediction: apply the same movement math the server uses
      // so the local capsule responds at 60 Hz, then reconcile in LocalPlayer
      // when the authoritative snapshot arrives.
      applyLocalInput(
        {
          forward: k.forward,
          backward: k.backward,
          left: k.left,
          right: k.right,
          rotationY: yawRef.current,
        },
        dt,
      );
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // 20 Hz input pump to the server.
    const interval = window.setInterval(() => {
      const k = keysRef.current;
      const payload: PlayerInput = {
        forward: k.forward,
        backward: k.backward,
        left: k.left,
        right: k.right,
        rotationY: yawRef.current,
        seq: ++seqRef.current,
      };
      try {
        getTransport().sendInput(payload);
      } catch {
        /* swallow — transport may be mid-disconnect */
      }
    }, TICK_INTERVAL_MS);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      cancelAnimationFrame(raf);
      window.clearInterval(interval);
    };
  }, []);

  return { yawRef };
}
