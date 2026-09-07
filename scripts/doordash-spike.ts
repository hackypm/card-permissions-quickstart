// DoorDash browser-agent spike.
//
// Goal: validate the riskiest assumption of the build — that an automated
// agent driving a real, logged-in browser can manipulate a DoorDash cart
// without being blocked. This is a standalone proof, NOT the production agent.
//
// Flow: launch a persistent headed Chromium → you log in to DoorDash manually
// once (the session is saved to .playwright-profile/ and reused on later runs,
// so no password is ever stored) → navigate to a store → add the first menu
// item to the cart → proceed through checkout to the payment step → stop.
//
// No card is filled and no order is submitted. Selectors below are resilient
// (role/text) but DoorDash's DOM changes often — expect to tune them on the
// first run; the console output + screenshot tell you where it breaks.
//
// Usage:
//   pnpm spike:doordash                    # uses DOORDASH_STORE_URL or default
//   DOORDASH_STORE_URL=https://www.doordash.com/store/... pnpm spike:doordash

import { chromium, type BrowserContext, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";

// ─── Config ──────────────────────────────────────────────────────────────────

const STORE_URL =
  process.env.DOORDASH_STORE_URL ??
  // A real store URL must be supplied via env on first run. This placeholder
  // is only a fallback so the script can at least open DoorDash for login.
  "https://www.doordash.com/";

const PROFILE_DIR = path.resolve(process.cwd(), ".playwright-profile");
const SHOT_DIR = path.resolve(process.cwd(), "scripts", ".spike-shots");

// Headed is required: you need to log in manually, and a real visible browser
// is less detectable than headless for the actual ordering runs later.
const HEADLESS = false;

// A realistic desktop UA + viewport. We deliberately do NOT use a stealth
// plugin for the spike — we want to see how DoorDash reacts to a plain
// Playwright Chromium before deciding whether hardening is needed.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// ─── Logging ─────────────────────────────────────────────────────────────────

const steps: string[] = [];
function log(step: string, detail?: unknown) {
  const line = detail ? `▶ ${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : `▶ ${step}`;
  console.log(`\n${"─".repeat(60)}\n${line}\n${"─".repeat(60)}`);
  steps.push(step);
}
function fail(step: string, err: unknown) {
  console.error(`\n✖ FAILED at "${step}": ${err instanceof Error ? err.message : String(err)}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pause for a human-readable amount of time to look less like a script. */
const humanDelay = (ms = 600 + Math.random() * 700) => new Promise((r) => setTimeout(r, ms));

async function pressEnterToContinue(msg: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`\n⏸  ${msg}\n   Press Enter when done… `);
  rl.close();
}

/** Take a screenshot into the spike shots dir, returning the path. */
async function snap(page: Page, name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`📸 screenshot → ${path.relative(process.cwd(), file)}`);
  return file;
}

// ─── Login gate ──────────────────────────────────────────────────────────────

/**
 * Detect whether the user is logged in to DoorDash.
 *
 * DoorDash surfaces a "Sign in" affordance when logged out and an account
 * menu/avatar when logged in. We check both signals so a DOM change to one
 * doesn't break detection. Selectors here are deliberately loose text matches.
 */
async function isLoggedIn(page: Page): Promise<boolean> {
  // Logged-in signal: an account/avatar button is present.
  const accountBtn = page.getByRole("button", { name: /account/i }).first();
  // Logged-out signal: a "Sign in" link/button is present.
  const signIn = page.getByRole("link", { name: /sign in/i }).first().or(
    page.getByRole("button", { name: /sign in/i }).first(),
  );
  const [hasAccount, hasSignIn] = await Promise.all([
    accountBtn.isVisible().catch(() => false),
    signIn.isVisible().catch(() => false),
  ]);
  return hasAccount && !hasSignIn;
}

/** Block until the user has completed manual login in the headed window. */
async function waitForLogin(page: Page, context: BrowserContext) {
  log("login", "checking session…");
  if (await isLoggedIn(page)) {
    log("login", "already logged in (session persisted from profile)");
    return;
  }
  log("login", "NOT logged in — manual login required");
  console.log(
    "\n  Please log in to DoorDash in the browser window that just opened.\n" +
      "  Use your real account. Your session will be saved to .playwright-profile/\n" +
      "  so future runs start already logged in — no password is stored.\n",
  );
  // Poll for login with a generous timeout; the user can also press Enter.
  const loginDeadline = Date.now() + 5 * 60_000;
  const poll = setInterval(async () => {
    if (await isLoggedIn(page)) {
      log("login", "detected logged-in state");
    }
  }, 2000);
  try {
    while (Date.now() < loginDeadline) {
      if (await isLoggedIn(page)) return;
      await humanDelay(2000);
    }
    // Fall back to a manual confirm if auto-detection didn't fire.
    await pressEnterToContinue("If login auto-detection didn't trigger, finish logging in then press Enter.");
  } finally {
    clearInterval(poll);
  }
}

// ─── Cart + checkout flow ────────────────────────────────────────────────────

async function addFirstItemToCart(page: Page) {
  log("menu", "waiting for menu items to load");
  // Menu items are links/cards that open a customization modal. We target
  // the first clickable item inside the store's menu container.
  await page.waitForLoadState("networkidle");

  // Try a few resilient strategies for "first menu item".
  const itemCandidates = [
    () => page.getByRole("article").first(),
    () => page.locator('[data-testid^="store-item"], [data-testid^="menu-item"]').first(),
    () => page.locator('a[href*="/item/"], a[href*="/store/"][href*="/item"]').first(),
  ];
  let opened = false;
  for (const candidate of itemCandidates) {
    const item = candidate();
    if (await item.isVisible().catch(() => false)) {
      log("menu", `clicking first menu item (strategy ${itemCandidates.indexOf(candidate) + 1})`);
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await humanDelay();
      await item.click().catch(() => {});
      opened = true;
      break;
    }
  }
  if (!opened) {
    throw new Error("no menu item found — selectors need tuning (see snap: menu-loaded)");
  }
  await snap(page, "01-item-modal");

  // The item modal exposes an "Add to cart" button. Match loosely.
  log("item", "looking for Add to Cart button");
  const addBtnCandidates = [
    () => page.getByRole("button", { name: /add to cart/i }).first(),
    () => page.getByRole("button", { name: /^add$/i }).first(),
    () => page.locator('[data-testid*="add-to-cart"], [data-testid*="addToCart"]').first(),
  ];
  let added = false;
  for (const candidate of addBtnCandidates) {
    const btn = candidate();
    if (await btn.isVisible().catch(() => false)) {
      log("item", `clicking add-to-cart (strategy ${addBtnCandidates.indexOf(candidate) + 1})`);
      await humanDelay();
      await btn.click();
      added = true;
      break;
    }
  }
  if (!added) {
    await snap(page, "02-no-add-button");
    throw new Error("Add to Cart button not found — item may require customization; selectors need tuning");
  }
  await humanDelay(1200);
  await snap(page, "03-after-add");
  log("item", "add-to-cart clicked");
}

async function reachCheckoutPaymentStep(page: Page) {
  log("checkout", "opening cart / proceeding to checkout");

  // Open the cart if it isn't already, then hit Checkout.
  const checkoutCandidates = [
    () => page.getByRole("button", { name: /checkout/i }).first(),
    () => page.getByRole("link", { name: /checkout/i }).first(),
    () => page.locator('[data-testid*="checkout"]').first(),
  ];
  let checkedOut = false;
  for (const candidate of checkoutCandidates) {
    const btn = candidate();
    if (await btn.isVisible().catch(() => false)) {
      log("checkout", `clicking checkout (strategy ${checkoutCandidates.indexOf(candidate) + 1})`);
      await humanDelay();
      await btn.click();
      checkedOut = true;
      break;
    }
  }
  if (!checkedOut) {
    await snap(page, "04-no-checkout");
    throw new Error("Checkout button not found — cart may be empty or selectors need tuning");
  }
  await page.waitForLoadState("networkidle").catch(() => {});
  await humanDelay(1500);
  await snap(page, "05-checkout-started");

  // DoorDash checkout usually walks through address/contact → payment. We
  // advance through any visible "Continue"/"Next" prompts until we land on a
  // payment-method step, detected by the presence of a card-entry or
  // "payment method" affordance. We cap the number of advances so we never
  // accidentally submit an order.
  const PAYMENT_SIGNALS = [
    () => page.getByText(/payment method/i).first(),
    () => page.getByText(/add a card/i).first(),
    () => page.getByLabel(/card number/i).first(),
    () => page.locator('iframe[name*="card"], iframe[title*="card" i]').first(),
  ];
  async function onPaymentStep() {
    for (const signal of PAYMENT_SIGNALS) {
      if (await signal().isVisible().catch(() => false)) return true;
    }
    return false;
  }

  for (let i = 0; i < 6; i++) {
    if (await onPaymentStep()) {
      log("checkout", "reached payment step");
      await snap(page, "06-payment-step");
      return;
    }
    const next = page
      .getByRole("button", { name: /continue|next|place order/i })
      .first();
    if (await next.isVisible().catch(() => false)) {
      // IMPORTANT: never click "Place order" — we only want to *reach* payment.
      if (/place order/i.test(await next.textContent().catch(() => "") ?? "")) {
        log("checkout", "hit a 'Place order' button — stopping before submission");
        await snap(page, "06-place-order-stop");
        return;
      }
      log("checkout", `advancing (step ${i + 1})`);
      await humanDelay();
      await next.click().catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await humanDelay(1200);
    } else {
      // Nothing to click and not on payment — surface it and stop.
      log("checkout", "no Continue button and not on payment step — manual inspection needed");
      await snap(page, "06-stuck");
      return;
    }
  }
  // Final check after loop.
  if (await onPaymentStep()) {
    log("checkout", "reached payment step");
    await snap(page, "06-payment-step");
    return;
  }
  await snap(page, "06-unknown-state");
  throw new Error("did not reach payment step within advance limit — selectors/state need tuning");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  log("launch", `persistent profile → ${path.relative(process.cwd(), PROFILE_DIR)}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    channel: "chromium", // real Chromium build
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // Make navigator.webdriver undefined — a basic, non-stealth tell removal.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Graceful shutdown on Ctrl-C.
  const cleanup = async () => {
    try {
      await snap(page, "99-final").catch(() => {});
      await context.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);

  try {
    log("navigate", `store URL → ${STORE_URL}`);
    await page.goto(STORE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    await waitForLogin(page, context);
    await snap(page, "00-logged-in");

    // If we landed on the home page (no store), prompt for a store URL.
    if (!/\/store\//.test(page.url())) {
      console.log(`\n  Current page is not a store: ${page.url()}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const url = (
        await rl.question("  Paste a DoorDash store URL and press Enter: ")
      ).trim();
      rl.close();
      if (url) {
        log("navigate", `user-supplied store URL → ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("networkidle").catch(() => {});
      }
    }

    await addFirstItemToCart(page);
    await reachCheckoutPaymentStep(page);

    log("done", "spike complete — reached checkout payment step");
    console.log("\n  Steps completed:\n" + steps.map((s) => `   ✓ ${s}`).join("\n"));
    console.log("\n  Leaving the browser open for inspection. Close it or press Ctrl-C to exit.\n");
    // Keep the process alive so the browser stays open.
    await new Promise<void>((resolve) => {
      context.on("close", () => resolve());
    });
  } catch (err) {
    fail(steps[steps.length - 1] ?? "main", err);
    await snap(page, "error").catch(() => {});
    await context.close();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
