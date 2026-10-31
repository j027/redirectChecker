/**
 * Run one Taboola hunt cycle without production side effects.
 *
 * It logs in to Yahoo Mail, captures native and auction Taboola responses,
 * processes at most one ad, screenshots it, and runs the local classifier. It
 * does not write ads, send Discord alerts, add redirects, or report to any
 * external service.
 *
 * Usage:
 *   yarn tsx scripts/taboola-hunt-once.ts
 *   yarn tsx scripts/taboola-hunt-once.ts --max-ads=1 --capture-window=30000
 */
import "../src/services/hunterService.js";
import { taboolaHunter } from "../src/services/taboolaHunter.js";
import { aiClassifierService } from "../src/services/aiClassifierService.js";

function readNumberArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (argument == null) {
    return fallback;
  }

  const value = Number.parseInt(argument.slice(prefix.length), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const maxAds = readNumberArgument("max-ads", 1);
  const captureWindowMs = readNumberArgument("capture-window", 35_000);

  console.log(
    `Taboola dry run: maxAds=${maxAds}, captureWindow=${captureWindowMs / 1000}s`
  );

  await aiClassifierService.init();
  await taboolaHunter.init();
  let exitCode = 0;

  try {
    const result = await taboolaHunter.huntTaboolaAds({
      dryRun: true,
      maxAds,
      captureWindowMs,
    });

    console.log("\nDry-run result:");
    console.log(JSON.stringify(result, null, 2));

    if (result.status === "failed") {
      exitCode = 1;
    }
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    // This is a standalone diagnostic. Closing several Playwright browsers at
    // once can race with context teardown, so let process exit reclaim them.
    process.exit(exitCode);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
