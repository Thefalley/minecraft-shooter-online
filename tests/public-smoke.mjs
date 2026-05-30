import { chromium } from "playwright";

const WEB = process.argv[2] || "https://pensions-wing-humidity-bike.trycloudflare.com";
const WS = process.argv[3] || "https://meetup-ease-thomson-elite.trycloudflare.com";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
page.on("requestfailed", (req) =>
  console.log("[fail]", req.url(), "→", req.failure()?.errorText),
);

console.log("=== probing WS tunnel health ===");
try {
  const res = await page.request.get(WS + "/health", { timeout: 15000 });
  console.log("WS /health status:", res.status(), await res.text());
} catch (e) {
  console.log("WS /health ERROR:", e.message);
}

console.log("=== probing web tunnel ===");
try {
  const res = await page.request.get(WEB + "/", { timeout: 15000 });
  console.log("WEB / status:", res.status());
  const html = await res.text();
  console.log("contains 'Voxel':", html.includes("Voxel Shooter"));
} catch (e) {
  console.log("WEB / ERROR:", e.message);
}

console.log("=== full lobby load + screenshot ===");
try {
  await page.goto(WEB, { waitUntil: "load", timeout: 30000 });
  await page.screenshot({ path: "screenshots/public-lobby.png", fullPage: true });
  console.log("loaded ok, screenshot saved");
} catch (e) {
  console.log("WEB load ERROR:", e.message);
}

await browser.close();
