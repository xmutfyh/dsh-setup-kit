#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROXY,
  healthCheck,
  proxyGet,
  proxyPostUrl,
  waitForComplete,
  closeTab,
} from "./lib/cdp-utils.mjs";
import { fetchToFile, fetchAnyToFile } from "./lib/pdf-utils.mjs";

function usage() {
  console.log(`Usage:
  node browser_pdf_downloader.mjs --url <pdf-url> --out <file.pdf> [--proxy http://127.0.0.1:3456] [--close] [--allow-non-pdf]
  node browser_pdf_downloader.mjs --target <targetId> --out <file.pdf> [--proxy http://127.0.0.1:3456]

Downloads through an already-authenticated Chrome page controlled by the web-access CDP proxy.
It first uses Chrome's Network.loadNetworkResource path, then falls back to page-context fetch.
It does not bypass logins, CAPTCHA, Cloudflare, paywalls, or publisher restrictions.`);
}

function parseArgs(argv) {
  const args = { proxy: DEFAULT_PROXY, close: false, allowNonPdf: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--proxy") args.proxy = argv[++i].replace(/\/$/, "");
    else if (a === "--close") args.close = true;
    else if (a === "--allow-non-pdf") args.allowNonPdf = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();
  if (!args.out) throw new Error("--out is required");
  if (!args.url && !args.target) throw new Error("Provide --url or --target");

  await healthCheck(args.proxy);

  let target = args.target;
  let openedByScript = false;
  if (!target) {
    const created = await proxyPostUrl(args.proxy, "/new", args.url, {}, 60000);
    target = created.targetId;
    openedByScript = true;
    await waitForComplete(args.proxy, target);
  } else if (args.url) {
    await proxyPostUrl(args.proxy, "/navigate", args.url, { target }, 60000);
    await waitForComplete(args.proxy, target);
  }

  const info = await proxyGet(args.proxy, "/info", { target }, 10000);
  const sourceUrl = args.url || info.url;
  if (!sourceUrl) throw new Error("Could not determine the resource URL");

  const got = args.allowNonPdf
    ? await fetchAnyToFile(args.proxy, target, sourceUrl, args.out)
    : await fetchToFile(args.proxy, target, sourceUrl, args.out);

  if (!got.ok) throw new Error(`Browser download failed: ${got.err || "unknown error"}`);

  const saved = fs.readFileSync(args.out);
  const signature = saved.subarray(0, 8).toString("ascii");
  console.log(JSON.stringify({
    out: path.resolve(args.out),
    bytes: saved.length,
    contentType: got.contentType || "",
    sourceUrl,
    signature,
    pdf: signature.startsWith("%PDF-"),
    transport: got.direct ? "cdp-network" : "page-fetch",
  }, null, 2));

  if (args.close && openedByScript) await closeTab(args.proxy, target);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
