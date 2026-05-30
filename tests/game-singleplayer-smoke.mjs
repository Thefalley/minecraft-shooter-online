/**
 * Phase 0 smoke test: opens the imported Voxel-Dragons singleplayer and
 * captures the menu → in-game flow. Pure visual proof the import is intact.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const URL = process.env.GAME_URL || "http://localhost:5173";
const OUT = resolve("screenshots/voxel-dragons-phase0");

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log("[smoke] launching chromium");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    // Pretend we have permission to lock pointer so the click handler doesn't bail
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();

  page.on("pageerror", (e) => console.log("[err]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text());
  });

  console.log("[smoke] goto", URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/01-loaded.png`, fullPage: true });
  const titleHTML = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log("[smoke] visible text:\n", titleHTML.replace(/\s+/g, " ").slice(0, 300));

  // The Menu module mounts a fullscreen UI. Wait for it.
  const menuShown = await page.evaluate(() => {
    const t = document.body.innerText;
    return /personaj|character|jugar|select|elige/i.test(t);
  });
  console.log("[smoke] menu visible:", menuShown);

  // Find clickable character cards. The Menu inserts buttons/divs with the character names.
  const buttons = await page.$$eval("button, [role=button], .character, .vd-character, .menu-card, div", (els) =>
    els
      .map((el) => ({
        tag: el.tagName,
        text: (el.innerText || "").trim().slice(0, 80),
        cls: el.className,
      }))
      .filter((e) => e.text && e.text.length > 0 && e.text.length < 80),
  );
  console.log("[smoke] candidate clickables (top 10):");
  for (const b of buttons.slice(0, 10)) console.log("  ", JSON.stringify(b));

  // Step 1: click the Duck character card to select it (already pre-selected, but
  //         clicking is harmless and verifies hit-test works).
  await page.click(".vd-char-card", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/02-character-selected.png`, fullPage: true });

  // Step 2: click "Empezar partida" to actually start the game.
  const startBtn = await page.$('text=/empezar partida/i');
  if (startBtn) {
    await startBtn.click();
    console.log("[smoke] clicked Empezar partida");
  } else {
    console.log("[smoke] could not find Empezar partida button");
  }

  // Game heavy init: World.generate(), enemy managers, viewmodel build, shader compile.
  // Give it some time.
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/03-after-start.png`, fullPage: true });

  // Detect canvas (Three.js renders to canvas)
  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return { found: false };
    const r = c.getBoundingClientRect();
    return { found: true, w: r.width, h: r.height, dpr: window.devicePixelRatio };
  });
  console.log("[smoke] canvas:", canvasInfo);

  if (canvasInfo.found) {
    await page.screenshot({ path: `${OUT}/04-game-canvas.png`, fullPage: true });

    // Click into the canvas to acquire pointer lock (best effort — headless may decline)
    await page.click("canvas").catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/05-after-click-canvas.png`, fullPage: true });

    // Try to move forward for 1.2 s so the camera changes if controls actually work
    await page.keyboard.down("KeyW").catch(() => {});
    await page.waitForTimeout(1200);
    await page.keyboard.up("KeyW").catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/06-after-w-press.png`, fullPage: true });

    // Try a small look-around via simulated mouse movement
    await page.mouse.move(640, 400);
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(640 + i * 20, 400, { steps: 1 });
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/07-after-look.png`, fullPage: true });

    // Inspect game state by reaching into the renderer
    const gameDiag = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return { ok: false };
      // The Game instance is not exposed on window — peek what we can from the DOM
      const huds = Array.from(document.querySelectorAll('.vd-hud, .vd-hotbar, .vd-bottom-right, .vd-bottom-left, .vd-top-right')).map(el => ({
        cls: el.className,
        text: (el.innerText || '').slice(0, 120).replace(/\s+/g,' ').trim(),
      }));
      return {
        ok: true,
        canvas: { w: canvas.width, h: canvas.height },
        hudPieces: huds,
        bodyText: document.body.innerText.slice(0, 400).replace(/\s+/g,' '),
      };
    });
    console.log("[smoke] in-game diagnostic:");
    console.log(JSON.stringify(gameDiag, null, 2));
  }

  console.log("[smoke] DONE. Screenshots in", OUT);
  await browser.close();
}

main().catch((e) => {
  console.error("[smoke] failed:", e);
  process.exit(1);
});
