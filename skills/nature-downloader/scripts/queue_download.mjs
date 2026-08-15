// Serial, resumable DOI queue. Each DOI runs in its own downloader process so
// a slow publisher page cannot block the rest of the queue.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADER = path.join(HERE, "batch_download.mjs");

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function safeName(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
}

function readLines(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function appendVerification(file, result) {
  if (!file || !result || !/robot|verification/i.test(result.status || "")) return;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      "doi\tstatus\tsource_url\tnext_action\tnotes\n",
      "utf8"
    );
  }
  const row = [
    result.doi || "",
    result.status || "",
    result.url || "",
    "user_complete_publisher_verification",
    "自动队列已停止该条目的重试；完成验证后再重试一次。",
  ].join("\t");
  fs.appendFileSync(file, `${row}\n`, "utf8");
}

function runOne(doi, outDir, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DOWNLOADER, "--dois", doi, "--out", outDir], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ doi, status: "item_timeout", exit_code: code, stderr: stderr.slice(-500) });
        return;
      }
      try {
        const payload = JSON.parse(stdout.trim());
        resolve({ ...(payload.results?.[0] || {}), doi, exit_code: code });
      } catch {
        resolve({ doi, status: "downloader_error", exit_code: code, stderr: stderr.slice(-500) });
      }
    });
  });
}

const args = process.argv.slice(2);
const outRoot = argValue(args, "--out", path.resolve("literature_download_queue"));
const manifest = argValue(args, "--manifest", path.join(outRoot, "download_manifest.jsonl"));
const verification = argValue(args, "--verification-file", path.join(outRoot, "publisher_verification.tsv"));
const timeoutSec = Number(argValue(args, "--item-timeout-sec", "90"));
const doiFile = argValue(args, "--dois-file");
const explicitDois = csv(argValue(args, "--dois"));
const skip = new Set(csv(argValue(args, "--skip-doi" )).map((x) => x.toLowerCase()));

let dois = [...explicitDois, ...readLines(doiFile)];
dois = [...new Set(dois.map((x) => x.toLowerCase()).filter((x) => /^10\./.test(x)))];
if (!dois.length) throw new Error("Provide --dois or --dois-file");

fs.mkdirSync(outRoot, { recursive: true });
fs.mkdirSync(path.dirname(manifest), { recursive: true });
const completed = new Set();
if (fs.existsSync(manifest)) {
  for (const line of readLines(manifest)) {
    try {
      const item = JSON.parse(line);
      if (item.doi) completed.add(item.doi.toLowerCase());
    } catch {}
  }
}

const results = [];
for (let i = 0; i < dois.length; i++) {
  const doi = dois[i];
  if (skip.has(doi)) {
    const result = { doi, status: "skipped", reason: "verification_queue" };
    fs.appendFileSync(manifest, `${JSON.stringify(result)}\n`, "utf8");
    results.push(result);
    continue;
  }
  if (completed.has(doi)) {
    results.push({ doi, status: "skipped", reason: "manifest_resume" });
    continue;
  }
  const itemDir = path.join(outRoot, `${String(i + 1).padStart(3, "0")}_${safeName(doi)}`);
  const result = await runOne(doi, itemDir, Math.max(10, timeoutSec) * 1000);
  result.item_dir = itemDir;
  fs.appendFileSync(manifest, `${JSON.stringify(result)}\n`, "utf8");
  appendVerification(verification, result);
  results.push(result);
  process.stdout.write(`${JSON.stringify({ doi, status: result.status, file: result.file || null })}\n`);
}

const downloaded = results.filter((x) => /^(downloaded|open_access_downloaded|downloaded_with_si)$/.test(x.status)).length;
console.log(JSON.stringify({ summary: { total: dois.length, downloaded }, results }, null, 2));
