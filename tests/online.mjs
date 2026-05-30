import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const WEB = process.env.WEB_URL || "http://localhost:3000";
const OUT = resolve("screenshots");

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log("[test] launching chromium (headless shell)");
  const browser = await chromium.launch({ headless: true });

  // Two isolated browser contexts simulate two players on two devices.
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Surface console errors from the page so we can debug.
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    page.on("pageerror", (err) => console.log(`[${label}] pageerror`, err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`[${label}] console.error`, msg.text());
    });
  }

  // ── 1. Alice opens the lobby ──────────────────────────────────────────────
  console.log("[test] Alice → lobby");
  await pageA.goto(WEB, { waitUntil: "networkidle", timeout: 30_000 });
  await pageA.fill("#name", "Alice");
  await pageA.screenshot({ path: `${OUT}/01-alice-lobby.png`, fullPage: true });

  // ── 2. Alice creates the room ─────────────────────────────────────────────
  console.log("[test] Alice → create room");
  await Promise.all([
    pageA.waitForURL(/\/play/, { timeout: 30_000 }),
    pageA.click('button:has-text("Crear sala")'),
  ]);
  await pageA.waitForLoadState("networkidle");

  // Wait for the HUD to show the room code (5 chars uppercase).
  console.log("[test] Alice → reading room code from HUD");
  await pageA.waitForFunction(
    () => {
      const txt = document.body.innerText;
      return /[A-Z0-9]{5}/.test(txt);
    },
    null,
    { timeout: 15_000 },
  );
  const hudText = await pageA.locator("body").innerText();
  const codeMatch = hudText.match(/[A-Z2-9]{5}/);
  if (!codeMatch) throw new Error("Room code not found in HUD: " + hudText.slice(0, 400));
  const roomCode = codeMatch[0];
  console.log("[test] roomCode =", roomCode);

  // Wait for the canvas to render at least once
  await pageA.waitForSelector("canvas", { timeout: 10_000 });
  await pageA.waitForTimeout(1500);
  await pageA.screenshot({ path: `${OUT}/02-alice-in-room.png`, fullPage: true });

  // ── 3. Bob opens the lobby and joins with the code ────────────────────────
  console.log("[test] Bob → lobby");
  await pageB.goto(WEB, { waitUntil: "networkidle", timeout: 30_000 });
  await pageB.fill("#name", "Bob");
  await pageB.fill("#code", roomCode);
  await pageB.screenshot({ path: `${OUT}/03-bob-lobby-with-code.png`, fullPage: true });

  console.log("[test] Bob → join");
  await Promise.all([
    pageB.waitForURL(/\/play/, { timeout: 30_000 }),
    pageB.click('button:has-text("Unirse")'),
  ]);
  await pageB.waitForLoadState("networkidle");
  await pageB.waitForSelector("canvas", { timeout: 10_000 });
  await pageB.waitForTimeout(1500);

  // ── 4. Both pages should now show 2 players ───────────────────────────────
  console.log("[test] checking both clients see 2 players");
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    await page.waitForFunction(
      () => {
        const txt = document.body.innerText;
        return txt.includes("Alice") && txt.includes("Bob");
      },
      null,
      { timeout: 15_000 },
    );
    console.log(`[test] ${label}: sees both players ✓`);
  }

  await pageA.screenshot({ path: `${OUT}/04-alice-sees-bob.png`, fullPage: true });
  await pageB.screenshot({ path: `${OUT}/05-bob-sees-alice.png`, fullPage: true });

  // ── 5. Alice moves with WASD; Bob's screen should reflect movement ────────
  console.log("[test] Alice → press W for 1.5s");
  await pageA.focus("canvas");
  await pageA.keyboard.down("w");
  await pageA.waitForTimeout(1500);
  await pageA.keyboard.up("w");

  console.log("[test] Alice → press D for 1.0s");
  await pageA.keyboard.down("d");
  await pageA.waitForTimeout(1000);
  await pageA.keyboard.up("d");

  await pageA.waitForTimeout(500);
  await pageA.screenshot({ path: `${OUT}/06-alice-after-move.png`, fullPage: true });
  await pageB.screenshot({ path: `${OUT}/07-bob-sees-alice-moved.png`, fullPage: true });

  console.log("[test] Bob → press S for 1.0s");
  await pageB.focus("canvas");
  await pageB.keyboard.down("s");
  await pageB.waitForTimeout(1000);
  await pageB.keyboard.up("s");
  await pageB.waitForTimeout(500);
  await pageA.screenshot({ path: `${OUT}/08-alice-sees-bob-moved.png`, fullPage: true });
  await pageB.screenshot({ path: `${OUT}/09-bob-after-move.png`, fullPage: true });

  // ── 6. Bob leaves; Alice should see only one player ───────────────────────
  console.log("[test] Bob → close (disconnect)");
  await ctxB.close();
  await pageA.waitForTimeout(2500);
  await pageA.screenshot({ path: `${OUT}/10-alice-alone.png`, fullPage: true });
  const hudAfter = await pageA.locator("body").innerText();
  console.log("[test] HUD on Alice after Bob left (first 400 chars):", hudAfter.slice(0, 400).replace(/\s+/g, " "));

  await browser.close();
  console.log("[test] DONE. Screenshots in", OUT);
}

main().catch((err) => {
  console.error("[test] FAILED:", err);
  process.exit(1);
});
