#!/usr/bin/env node
// Batch literature downloader for the SJTU CARSI / Web of Science route.
//
// Runs the whole chain inside Node + the web-access CDP proxy, so large data
// (search DOMs, PDF bytes) never enters the agent's context. Only compact
// per-paper status is printed. This is the token-efficient fast path.
//
// Usage:
//   node batch_download.mjs --topic "<query>" --count 10 --out <dir> [--si]
//   node batch_download.mjs --dois 10.x/a,10.y/b --out <dir> [--si]
//   node batch_download.mjs --title "<exact title>" --out <dir> [--open-access]
//   node batch_download.mjs --pdf-url "https://..." --title "<title>" --out <dir>
//   node batch_download.mjs --title "<中文题名>" --out <dir> [--cnki-url <entry>] [--cnki-format pdf|any]
//   options: [--proxy http://127.0.0.1:3456] [--debug] [--legacy-status]
//
// Boundaries: uses only the user's already-authenticated browser session.
// Stops at jAccount / CARSI / CAPTCHA pages (reported as *_waiting_user), never
// handles credentials. Main PDF only by default; --si also fetches supplements.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROXY,
  healthCheck,
  evalJs,
  newTab,
  navigate,
  closeTab,
  listTargets,
  click,
  scroll,
  waitForComplete,
  proxyGet,
} from "./lib/cdp-utils.mjs";
import { classifyWall, STATUS, isSuccess, mapLegacyStatus } from "./lib/status-codes.mjs";
import { fetchToFile, fetchAnyToFile } from "./lib/pdf-utils.mjs";
import {
  DEFAULT_DISCOVERY_URL,
  discoveryUrlFromConfig,
  loadSchoolConfig,
  schoolSummary,
} from "./lib/school-config.mjs";
import { filenameForPdfUrl, findArxivByTitle } from "./lib/open-access.mjs";
import {
  DEFAULT_CNKI_URL,
  downloadCnkiTitle,
  looksChinese,
} from "./lib/cnki.mjs";

const PUBLISHER_ROUTES_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "publisher-routes.json"
);

function publisherHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rememberPublisherRoute(url, route) {
  const host = publisherHost(url);
  if (!host) return;
  try {
    const routes = fs.existsSync(PUBLISHER_ROUTES_FILE)
      ? JSON.parse(fs.readFileSync(PUBLISHER_ROUTES_FILE, "utf8"))
      : {};
    const previous = routes[host] || {};
    routes[host] = {
      ...previous,
      host,
      strategy: route.strategy,
      outcome: route.outcome,
      transport: route.transport || previous.transport || null,
      verifiedAt: new Date().toISOString(),
      observations: Number(previous.observations || 0) + 1,
    };
    fs.mkdirSync(path.dirname(PUBLISHER_ROUTES_FILE), { recursive: true });
    fs.writeFileSync(PUBLISHER_ROUTES_FILE, `${JSON.stringify(routes, null, 2)}\n`, "utf8");
  } catch (error) {
    if (route.debug) process.stderr.write(`[debug][routes] ${error.message}\n`);
  }
}

function isRobotStatus(status) {
  return (
    status === STATUS.SCIENCEDIRECT_ROBOT_CHECK ||
    status === STATUS.PUBLISHER_VERIFICATION_WAITING_USER
  );
}

async function refreshRobotWallOnce(proxy, target, wall, debug) {
  if (!wall || !isRobotStatus(wall.status)) return { wall };
  // Security walls are user actions, not transient page-load failures. Keep
  // the tab available for a later manual verification and continue the queue.
  if (debug) process.stderr.write(`[debug][robot] ${wall.reason}; deferred to verification queue\n`);
  return { wall, keepTabOpen: true };
}

async function openDoiLanding(proxy, target, doi) {
  let info = await waitForComplete(proxy, target);
  if (!info || info.url === "about:blank" || !info.title) {
    await navigate(proxy, target, `https://doi.org/${doi}`);
    info = await waitForComplete(proxy, target);
  }
  return info;
}

// Core Collection only: journal articles that carry DOIs (avoids Derwent/patent records).
const WOS = DEFAULT_DISCOVERY_URL;

function parseArgs(argv) {
  const a = { count: 10, out: ".", si: false, proxy: DEFAULT_PROXY, debug: false, legacyStatus: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--topic") a.topic = argv[++i];
    else if (k === "--title") a.title = argv[++i];
    else if (k === "--pdf-url") a.pdfUrl = argv[++i];
    else if (k === "--open-access") a.openAccess = true;
    else if (k === "--cnki-url") a.cnkiUrl = argv[++i];
    else if (k === "--cnki-format") a.cnkiFormat = argv[++i];
    else if (k === "--dois") a.dois = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--count") a.count = Number(argv[++i]);
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--si") a.si = true;
    else if (k === "--proxy") a.proxy = argv[++i].replace(/\/$/, "");
    else if (k === "--debug") a.debug = true;
    else if (k === "--legacy-status") a.legacyStatus = true;
    else throw new Error("unknown arg " + k);
  }
  const modes = [a.topic, a.title, a.pdfUrl, a.dois?.length].filter(Boolean).length;
  if (modes > 1 && !(a.topic && a.title && modes === 2)) {
    throw new Error("--topic, --title, --pdf-url, and --dois are mutually exclusive except --topic with --title");
  }
  if (a.cnkiFormat && !["pdf", "any"].includes(a.cnkiFormat)) {
    throw new Error("--cnki-format must be pdf or any");
  }
  return a;
}

function cnkiUrlFromConfig(config, argUrl) {
  return (
    argUrl ||
    config?.discovery?.cnki_url ||
    config?.discovery?.cnki ||
    DEFAULT_CNKI_URL
  );
}

async function downloadScienceDirectViewerPdf(proxy, target, pdfUrl, outPath, metaUrl, debug) {
  if (!/sciencedirect\.com/i.test(pdfUrl)) return null;

  // ScienceDirect's View PDF link may redirect the same tab to a signed PDF
  // resource. Fetch that final resource in the same authenticated tab.
  await navigate(proxy, target, pdfUrl);
  const viewer = await waitForComplete(proxy, target);
  const hint = await evalJs(
    proxy,
    target,
    `(()=>({title:document.title||'',body:(document.body?.innerText||'').slice(0,2400)}))()`
  ).catch(() => ({}));
  const wall = classifyWall(viewer?.url || '', hint?.title || viewer?.title || '', hint?.body || '');
  const checked = await refreshRobotWallOnce(proxy, target, wall, debug);
  if (checked.wall) return { blocked: true, status: checked.wall.status, reason: checked.wall.reason, url: viewer?.url, keepTabOpen: checked.keepTabOpen };
  if (!/pdf\.sciencedirectassets\.com/i.test(viewer?.url || '')) return null;

  const got = await fetchToFile(proxy, target, viewer.url, outPath);
  if (!got.ok) {
    if (debug) process.stderr.write(`[debug][sciencedirect-viewer] ${pdfUrl} -> ${got.err || "unknown"}\n`);
    return { blocked: false, err: got.err || "viewer PDF fetch failed", url: viewer.url };
  }
  return {
    blocked: false,
    ok: true,
    file: got.file,
    bytes: got.bytes,
    transport: got.direct ? "cdp-network" : "page-fetch",
    via: metaUrl,
  };
}

async function downloadWileyViewerPdf(proxy, target, pdfUrl, outPath, metaUrl, debug) {
  if (!/wiley\.com/i.test(pdfUrl)) return null;

  // Wiley may expose access state only after the visible PDF link is clicked.
  // Direct navigation to /doi/epdf can redirect back to the abstract page.
  if (metaUrl && !/\/doi\/epdf\//i.test(pdfUrl)) {
    await navigate(proxy, target, metaUrl);
    await waitForComplete(proxy, target, 15000);
    await click(proxy, target, 'a[href*="/doi/epdf/"]');
    await new Promise((r) => setTimeout(r, 4000));
  } else {
    await navigate(proxy, target, pdfUrl);
  }
  const viewer = await waitForComplete(proxy, target, 10000);
  const hint = await evalJs(
    proxy,
    target,
    `(()=>({title:document.title||'',body:(document.body?.innerText||'').slice(0,2400)}))()`
  ).catch(() => ({}));
  const wall = classifyWall(viewer?.url || '', hint?.title || viewer?.title || '', hint?.body || '');
  const checked = await refreshRobotWallOnce(proxy, target, wall, debug);
  if (checked.wall) return { blocked: true, status: checked.wall.status, reason: checked.wall.reason, url: viewer?.url, keepTabOpen: checked.keepTabOpen };

  const got = await fetchToFile(proxy, target, viewer?.url || pdfUrl, outPath);
  if (got.ok) {
    return {
      blocked: false,
      ok: true,
      file: got.file,
      bytes: got.bytes,
      transport: got.direct ? "cdp-network" : "page-fetch",
      via: metaUrl,
    };
  }
  if (debug) process.stderr.write(`[debug][wiley-viewer] ${pdfUrl} -> ${got.err || "unknown"}\n`);
  return { blocked: false, err: got.err || "Wiley viewer PDF fetch failed", url: viewer?.url || pdfUrl };
}

async function downloadGenericViewerPdf(proxy, target, sourceUrl, outPath, metaUrl, debug) {
  if (!sourceUrl || /^about:blank$/i.test(sourceUrl)) return null;
  await navigate(proxy, target, sourceUrl);
  let viewer = await waitForComplete(proxy, target, 15000);
  let hint = await evalJs(
    proxy,
    target,
    `(()=>({title:document.title||'',body:(document.body?.innerText||'').slice(0,2400)}))()`
  ).catch(() => ({}));
  const wall = classifyWall(viewer?.url || "", hint?.title || viewer?.title || "", hint?.body || "");
  const checked = await refreshRobotWallOnce(proxy, target, wall, debug);
  if (checked.wall) {
    rememberPublisherRoute(metaUrl || sourceUrl, {
      strategy: "generic-viewer",
      outcome: checked.wall.status,
      debug,
    });
    return {
      blocked: true,
      status: checked.wall.status,
      reason: checked.wall.reason,
      keepTabOpen: checked.keepTabOpen,
    };
  }
  if (checked.info) viewer = checked.info;
  if (checked.hint) hint = checked.hint;

  const raw = await evalJs(
    proxy,
    target,
    `(()=>JSON.stringify({
      links:[...document.querySelectorAll('a,button,[role=button],iframe,embed,object,link,meta')]
        .flatMap(e=>['href','src','data-href','data-url','data-pdf-url','formaction','content'].map(k=>e.getAttribute(k)).filter(Boolean)),
      resources:performance.getEntriesByType('resource').map(e=>e.name)
    }))()`
  ).catch(() => "{}");
  let found = {};
  try { found = JSON.parse(raw || "{}"); } catch {}
  const candidates = [...new Set([
    viewer?.url,
    ...(found.links || []),
    ...(found.resources || []),
  ])].filter((u) => /pdf|epdf|pdfft|pdfdirect|article-pdf|download|fulltext/i.test(u || ""));

  for (const candidate of candidates.slice(0, 20)) {
    const got = await fetchToFile(proxy, target, candidate, outPath);
    if (!got.ok) continue;
    const transport = got.direct ? "cdp-network" : "page-fetch";
    rememberPublisherRoute(metaUrl || sourceUrl, {
      strategy: "generic-viewer",
      outcome: "downloaded",
      transport,
      debug,
    });
    return { blocked: false, ok: true, file: got.file, bytes: got.bytes, transport, via: metaUrl || sourceUrl, route: "generic-viewer" };
  }
  return null;
}

async function handleWosAuthPreference(proxy, target) {
  const info = await proxyGet(proxy, "/info", { target }, 8000).catch(() => ({}));
  const marker = `${info.url || ""} ${info.title || ""}`;
  if (!/AUTH_PREFERENCE_ERROR|身份验证首选项|Authentication Preference/i.test(marker)) {
    return false;
  }
  const clicked = await evalJs(
    proxy,
    target,
    `(()=>{const r=document.querySelector('#radio-shibboleth,input[value="shibboleth"]');if(r)r.click();const b=[...document.querySelectorAll('button,a,input[type=button],input[type=submit]')].find(e=>/(继续|Continue)/i.test(e.innerText||e.value||''));if(b)b.click();return !!b;})()`
  ).catch(() => false);
  if (clicked) {
    await new Promise((r) => setTimeout(r, 3000));
    await waitForComplete(proxy, target);
  }
  return Boolean(clicked);
}

// --- WoS: search a topic, return the first N full-record URLs ---
async function wosRecordUrls(proxy, topic, count, debug, discoveryUrl = WOS) {
  const tabs = await listTargets(proxy);
  let target = (tabs.find((t) => /webofscience\./i.test(t.url || "")) || {}).targetId;
  if (target) await navigate(proxy, target, discoveryUrl);
  else target = (await newTab(proxy, discoveryUrl)).targetId;
  await waitForComplete(proxy, target);
  await handleWosAuthPreference(proxy, target);
  await new Promise((r) => setTimeout(r, 1500));
  await evalJs(
    proxy,
    target,
    `(()=>{const a=document.querySelector('#onetrust-accept-btn-handler');if(a)a.click();return 1;})()`
  ).catch(() => {});
  await evalJs(
    proxy,
    target,
    `(()=>{const i=document.querySelector('#search-option-0');if(!i)return 0;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(topic)});i.dispatchEvent(new Event('input',{bubbles:true}));return 1;})()`
  );
  await click(proxy, target, 'button[data-ta="run-search"]');
  // WoS renders records in shadow DOM + a virtualized list, so we walk shadow roots
  // and scroll to load more rows until we have enough record links.
  const collect = `(()=>{const out=new Set();(function w(r){r.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)w(e.shadowRoot);if(e.tagName==='A'&&/\\/full-record\\//.test(e.href||''))out.add(e.href);});})(document);return JSON.stringify([...out]);})()`;
  let urls = [];
  let lastInfo = null;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const inf = await proxyGet(proxy, "/info", { target }, 8000).catch(() => ({}));
    lastInfo = inf;
    if (!/\/summary\//.test(inf.url || "")) continue;
    const found = JSON.parse((await evalJs(proxy, target, collect)) || "[]");
    if (found.length > urls.length) urls = found;
    if (urls.length >= count * 2) break;
    await scroll(proxy, target, "bottom");
  }
  if (debug && urls.length === 0) {
    const html = await evalJs(
      proxy,
      target,
      `document.documentElement.outerHTML.slice(0,5000)`
    ).catch(() => "");
    process.stderr.write(`[debug][wos] no records found. url=${lastInfo?.url||'?'} title=${lastInfo?.title||'?'}\n`);
    process.stderr.write(`[debug][wos] html snippet: ${html.slice(0, 500)}\n`);
  }
  return { target, urls: urls.slice(0, count * 3) };
}

// --- From a WoS full-record page, get the article DOI ---
async function doiFromRecord(proxy, target, recordUrl) {
  await navigate(proxy, target, recordUrl);
  await waitForComplete(proxy, target);
  await new Promise((r) => setTimeout(r, 1200));
  const doi = await evalJs(
    proxy,
    target,
    `(()=>{let h='';(function w(r){r.querySelectorAll('*').forEach(e=>{if(e.shadowRoot)w(e.shadowRoot);if(!h&&e.tagName==='A'&&/doi\\.org\\/10\\./.test(e.href||''))h=e.href;});})(document);if(h)return (h.match(/10\\.\\d{4,9}\\/[^\\s"?]+/)||[])[0];const m=(document.body.innerText||'').match(/10\\.\\d{4,9}\\/[^\\s"]+/);return m?m[0]:'';})()`
  );
  return (doi || "").replace(/[.,;]+$/, "");
}

// --- Download main PDF (and optionally SI) for a DOI via the authenticated browser ---
async function downloadDoi(proxy, doi, outDir, wantSi, debug) {
  const tab = (await newTab(proxy, "https://doi.org/" + doi)).targetId;
  let keepTabOpen = false;
  try {
    let info = await openDoiLanding(proxy, tab, doi);
    const wall = classifyWall(info.url || "", info.title || "");
    const checked = await refreshRobotWallOnce(proxy, tab, wall, debug);
    if (checked.wall) {
      keepTabOpen = Boolean(checked.keepTabOpen);
      rememberPublisherRoute(info.url, { strategy: "observed", outcome: checked.wall.status, debug });
      return { doi, status: checked.wall.status, url: info.url, reason: checked.wall.reason, tab_kept_open: keepTabOpen };
    }
    if (checked.info) info = checked.info;
    // poll: publisher landings often JS-redirect (e.g. linkinghub -> sciencedirect)
    // and inject citation_pdf_url late; re-read a few times before giving up.
    let meta = {};
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      meta = JSON.parse(
        (await evalJs(
          proxy,
          tab,
          `(()=>{try{
        const cand=[];
        const add=(value)=>{
          if(!value)return;
          try{
            const u=new URL(String(value),location.href).href;
            if(/pdf|pdfdirect|pdfft|epdf/i.test(u))cand.push(u);
          }catch{}
        };
        document.querySelectorAll('meta,link').forEach(e=>{
          const key=((e.getAttribute('name')||'')+' '+(e.getAttribute('property')||'')+' '+(e.getAttribute('type')||'')).toLowerCase();
          if(key.includes('citation_pdf')||key.includes('application/pdf'))add(e.content||e.href);
        });
        document.querySelectorAll('a,button,[role=button],iframe,embed').forEach(e=>{
          const text=((e.textContent||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')).toLowerCase();
          add(e.href);
          ['href','src','data-href','data-url','data-pdf-url','formaction'].forEach(k=>add(e.getAttribute(k)));
          if(text.includes('pdf')||text.includes('full text')||text.includes('download'))add(e.href);
        });
        return JSON.stringify({cand:[...new Set(cand)].slice(0,12),title:document.title||'',url:location.href,body:(document.body?.innerText||'').slice(0,2400)});
      }catch(e){return JSON.stringify({error:String(e),title:document.title||'',url:location.href,body:(document.body?.innerText||'').slice(0,2400)});}})()`
        )) || "{}"
      );
      if (meta.error) {
        if (debug) process.stderr.write(`[debug][doi] ${doi} PDF-link probe error: ${meta.error}\n`);
        continue;
      }
      const w = classifyWall(meta.url || "", meta.title || "", meta.body || "");
      const checkedMeta = await refreshRobotWallOnce(proxy, tab, w, debug);
      if (checkedMeta.wall) {
        keepTabOpen = Boolean(checkedMeta.keepTabOpen);
        rememberPublisherRoute(meta.url, { strategy: "observed", outcome: checkedMeta.wall.status, debug });
        return { doi, status: checkedMeta.wall.status, url: meta.url, reason: checkedMeta.wall.reason, tab_kept_open: keepTabOpen };
      }
      if (w) continue;
      // Wiley may expose an access decision only after the PDF link is opened.
      if (/wiley\.com/i.test(meta.url || "") && /does not provide access to this content|downloading and printing are disabled/i.test(meta.body || "")) {
        const access = classifyWall(meta.url || "", meta.title || "", meta.body || "");
        if (access) return { doi, status: access.status, url: meta.url, reason: access.reason };
      }
      if (meta.cand && meta.cand.length) break;
    }
    // Publisher quirk: Wiley's citation_pdf_url/epdf opens a viewer, not raw bytes.
    // The pdfdirect?download=true endpoint returns the actual PDF in the same session.
    if (/wiley\.com/i.test(meta.url || "") || (meta.cand || []).some((c) => /wiley\.com/i.test(c))) {
      meta.cand = [
        `https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}?download=true`,
        ...(meta.cand || []),
      ];
    }
    const safe = doi.replace(/[\/:*?"<>|]/g, "_");
    // Distinguish WoS-stage "no record" from publisher-stage "no PDF":
    // if we got here, WoS found the record (we have a doi.org redirect to a
    // publisher page), so "no PDF candidates" means no_authorized_pdf_found.
    if (!meta.cand || !meta.cand.length) {
      const generic = await downloadGenericViewerPdf(
        proxy,
        tab,
        meta.url,
        path.join(outDir, "PDFs", safe + ".pdf"),
        meta.url,
        debug
      );
      if (generic?.blocked) {
        keepTabOpen = Boolean(generic.keepTabOpen);
        return { doi, status: generic.status, url: meta.url, reason: generic.reason, tab_kept_open: keepTabOpen };
      }
      if (generic?.ok) {
        return { doi, status: STATUS.DOWNLOADED, file: generic.file, bytes: generic.bytes, via: generic.via, transport: generic.transport, route: generic.route };
      }
      if (debug) {
        process.stderr.write(
          `[debug][doi] ${doi} no PDF candidates. url=${meta.url||'?'} title=${meta.title||'?'}\n`
        );
      }
      return { doi, status: STATUS.NO_AUTHORIZED_PDF_FOUND, url: meta.url };
    }

    const fetchErrors = [];
    for (const pdfUrl of meta.cand) {
      const got = await fetchToFile(proxy, tab, pdfUrl, path.join(outDir, "PDFs", safe + ".pdf"));
      if (got.ok) {
        const res = {
          doi,
          status: STATUS.DOWNLOADED,
          file: got.file,
          bytes: got.bytes,
          via: meta.url,
          transport: got.direct ? "cdp-network" : "page-fetch",
        };
        if (wantSi) {
          const si = await downloadSi(proxy, tab, meta.url, doi, outDir);
          res.si = si;
          if (si && si.count > 0) res.status = STATUS.DOWNLOADED_WITH_SI;
        }
        return res;
      }
      fetchErrors.push({ url: pdfUrl, err: got.err || "unknown" });
      if (debug) process.stderr.write(`[debug][pdf] ${doi} ${pdfUrl} -> ${got.err || "unknown"}\n`);

      const viewer = await downloadScienceDirectViewerPdf(
        proxy,
        tab,
        pdfUrl,
        path.join(outDir, "PDFs", safe + ".pdf"),
        meta.url,
        debug
      );
      if (viewer?.blocked) {
        keepTabOpen = Boolean(viewer.keepTabOpen);
        return { doi, status: viewer.status, url: meta.url, reason: viewer.reason, tab_kept_open: keepTabOpen };
      }
      if (viewer?.ok) {
        return {
          doi,
          status: STATUS.DOWNLOADED,
          file: viewer.file,
          bytes: viewer.bytes,
          via: viewer.via,
          transport: viewer.transport,
        };
      }
      if (viewer?.err) fetchErrors.push({ url: "sciencedirect-viewer", err: viewer.err });

      const wileyViewer = await downloadWileyViewerPdf(
        proxy,
        tab,
        pdfUrl,
        path.join(outDir, "PDFs", safe + ".pdf"),
        meta.url,
        debug
      );
      if (wileyViewer?.blocked) {
        keepTabOpen = Boolean(wileyViewer.keepTabOpen);
        return { doi, status: wileyViewer.status, url: meta.url, reason: wileyViewer.reason, tab_kept_open: keepTabOpen };
      }
      if (wileyViewer?.ok) {
        return {
          doi,
          status: STATUS.DOWNLOADED,
          file: wileyViewer.file,
          bytes: wileyViewer.bytes,
          via: wileyViewer.via,
          transport: wileyViewer.transport,
        };
      }
      if (wileyViewer?.err) fetchErrors.push({ url: "wiley-viewer", err: wileyViewer.err });

      if (!/sciencedirect\.com|wiley\.com/i.test(pdfUrl)) {
        const genericViewer = await downloadGenericViewerPdf(
          proxy,
          tab,
          pdfUrl,
          path.join(outDir, "PDFs", safe + ".pdf"),
          meta.url,
          debug
        );
        if (genericViewer?.blocked) {
          keepTabOpen = Boolean(genericViewer.keepTabOpen);
          return { doi, status: genericViewer.status, url: meta.url, reason: genericViewer.reason, tab_kept_open: keepTabOpen };
        }
        if (genericViewer?.ok) {
          return { doi, status: STATUS.DOWNLOADED, file: genericViewer.file, bytes: genericViewer.bytes, via: genericViewer.via, transport: genericViewer.transport, route: genericViewer.route };
        }
      }

      // One Wiley viewer attempt is enough; repeating the same access path
      // only adds latency and can trigger publisher rate limits.
      if (/wiley\.com/i.test(pdfUrl)) break;
    }
    return {
      doi,
      status: STATUS.PDF_FETCH_FAILED,
      url: meta.url,
      attempted: fetchErrors.length,
      err: fetchErrors.map((x) => x.err).join(" | ").slice(0, 1200),
    };
  } finally {
    if (!keepTabOpen) await closeTab(proxy, tab);
  }
}

async function downloadPdfUrl(proxy, pdfUrl, outDir, title = "") {
  const tab = (await newTab(proxy, pdfUrl)).targetId;
  try {
    await waitForComplete(proxy, tab);
    const fileName = filenameForPdfUrl(pdfUrl, title);
    const got = await fetchToFile(proxy, tab, pdfUrl, path.join(outDir, "PDFs", fileName));
    if (got.ok) {
      return {
        title,
        status: STATUS.DOWNLOADED,
        file: got.file,
        bytes: got.bytes,
        via: pdfUrl,
      };
    }
    return { title, status: STATUS.PDF_FETCH_FAILED, url: pdfUrl, err: got.err };
  } finally {
    await closeTab(proxy, tab);
  }
}

async function downloadSi(proxy, tab, landingUrl, doi, outDir) {
  // Best-effort: scan landing page for supplement links, download each.
  await navigate(proxy, tab, landingUrl);
  await waitForComplete(proxy, tab);
  await new Promise((r) => setTimeout(r, 800));
  const links = JSON.parse(
    (await evalJs(
      proxy,
      tab,
      `JSON.stringify([...new Set(Array.from(document.querySelectorAll('a')).map(a=>a.href).filter(h=>/downloadSupplement|\\/suppl|supplementary|mmc\\d|_si_/i.test(h)))].slice(0,30))`
    )) || "[]"
  );
  const safe = doi.replace(/[\/:*?"<>|]/g, "_");
  let n = 0;
  for (const u of links) {
    const name = (u.split("file=")[1] || u.split("/").pop() || "si" + ++n)
      .replace(/[\/:*?"<>|]/g, "_")
      .slice(0, 80);
    const got = await fetchAnyToFile(
      proxy,
      tab,
      u,
      path.join(outDir, "SupportingInformation", safe + "__" + name)
    );
    if (got.ok) n++;
  }
  return { count: n, found: links.length };
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.out, { recursive: true });
  const schoolConfig = loadSchoolConfig();
  const discoveryUrl = discoveryUrlFromConfig(schoolConfig);
  const cnkiUrl = cnkiUrlFromConfig(schoolConfig, args.cnkiUrl);
  process.stderr.write(`[config] ${schoolSummary(schoolConfig)}; discovery=${discoveryUrl}; cnki=${cnkiUrl}\n`);

  // Fail fast with a friendly message if the CDP proxy isn't running.
  await healthCheck(args.proxy);

  const results = [];
  const t0 = Date.now();

  if (args.pdfUrl) {
    const r = await downloadPdfUrl(args.proxy, args.pdfUrl, args.out, args.title || "").catch((e) => ({
      title: args.title || "",
      status: STATUS.FAILED_AFTER_RETRY,
      url: args.pdfUrl,
      err: String(e).slice(0, 120),
    }));
    results.push(r);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(JSON.stringify({ summary: { total: 1, downloaded: isSuccess(r.status) ? 1 : 0, seconds: Number(secs) }, results }, null, 2));
    return;
  }

  if (args.title && args.openAccess && !args.topic) {
    process.stderr.write(`[oa] searching arXiv exact title: ${args.title}\n`);
    const hit = await findArxivByTitle(args.title).catch((e) => ({ err: String(e).slice(0, 120) }));
    if (hit && hit.pdfUrl) {
      process.stderr.write(`[oa] arXiv ${hit.id} -> ${hit.pdfUrl}\n`);
      const r = await downloadPdfUrl(args.proxy, hit.pdfUrl, args.out, hit.title).catch((e) => ({
        title: args.title,
        status: STATUS.FAILED_AFTER_RETRY,
        err: String(e).slice(0, 120),
      }));
      results.push({ ...r, arxiv: hit.id });
    } else {
      results.push({ title: args.title, status: STATUS.NO_AUTHORIZED_PDF_FOUND, err: hit?.err || "no exact arXiv title match" });
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(JSON.stringify({ summary: { total: 1, downloaded: results.filter((r) => isSuccess(r.status)).length, seconds: Number(secs) }, results }, null, 2));
    return;
  }

  if (args.title && looksChinese(args.title) && !args.topic) {
    process.stderr.write(`[cnki] searching Chinese title: ${args.title}\n`);
    const r = await downloadCnkiTitle(args.proxy, args.title, args.out, {
      cnkiUrl,
      format: args.cnkiFormat || "any",
      debug: args.debug,
    }).catch((e) => ({
      title: args.title,
      status: STATUS.FAILED_AFTER_RETRY,
      err: String(e).slice(0, 120),
      source: "cnki",
    }));
    results.push(r);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(JSON.stringify({ summary: { total: 1, downloaded: isSuccess(r.status) ? 1 : 0, seconds: Number(secs) }, results }, null, 2));
    return;
  }

  let dois = args.dois || [];

  if (!dois.length && args.topic) {
    process.stderr.write(`[wos] searching: ${args.topic}\n`);
    const { target, urls } = await wosRecordUrls(args.proxy, args.topic, args.count, args.debug, discoveryUrl);
    process.stderr.write(`[wos] ${urls.length} records\n`);
    for (const u of urls) {
      if (dois.length >= args.count) break;
      const doi = await doiFromRecord(args.proxy, target, u);
      if (doi && /^10\./.test(doi)) {
        dois.push(doi);
        process.stderr.write(`[doi] ${doi}\n`);
      }
    }
    if (!dois.length && args.title) {
      process.stderr.write(`[oa] WoS produced no DOI; trying arXiv exact title: ${args.title}\n`);
      const hit = await findArxivByTitle(args.title).catch((e) => ({ err: String(e).slice(0, 120) }));
      if (hit && hit.pdfUrl) {
        process.stderr.write(`[oa] arXiv ${hit.id} -> ${hit.pdfUrl}\n`);
        const r = await downloadPdfUrl(args.proxy, hit.pdfUrl, args.out, hit.title).catch((e) => ({
          title: args.title,
          status: STATUS.FAILED_AFTER_RETRY,
          err: String(e).slice(0, 120),
        }));
        results.push({ ...r, arxiv: hit.id });
      } else {
        results.push({ title: args.title, status: STATUS.NO_AUTHORIZED_PDF_FOUND, err: hit?.err || "no exact arXiv title match" });
      }
    }
  }
  dois = [...new Set(dois)].slice(0, args.count);

  for (const doi of dois) {
    const r = await downloadDoi(args.proxy, doi, args.out, args.si, args.debug).catch((e) => {
      // Distinguish parameter/logic errors (do_not_auto_retry) from
      // network/CDP errors (failed_after_retry).
      const msg = String(e).slice(0, 120);
      const isLogic = /unknown arg|mutually exclusive|required|not reachable/i.test(msg);
      return {
        doi,
        status: isLogic ? STATUS.DO_NOT_AUTO_RETRY : STATUS.FAILED_AFTER_RETRY,
        err: msg,
      };
    });
    // Apply legacy status mapping for backward-compatible output if requested.
    if (args.legacyStatus) {
      r.status = reverseMapStatus(r.status);
    }
    results.push(r);
    process.stderr.write(
      `[dl] ${doi} -> ${r.status}${r.bytes ? " " + r.bytes + "B" : ""}\n`
    );
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = results.filter((r) => isSuccess(r.status)).length;
  console.log(
    JSON.stringify(
      { summary: { total: dois.length, downloaded: ok, seconds: Number(secs) }, results },
      null,
      2
    )
  );
}

// Reverse mapping: canonical -> legacy (only for --legacy-status output).
// Best-effort; some canonical codes have no legacy equivalent and pass through.
function reverseMapStatus(s) {
  const m = {
    [STATUS.CARSI_WAITING_USER]: "needs_user_login",
    [STATUS.PUBLISHER_VERIFICATION_WAITING_USER]: "needs_user_verify",
    [STATUS.SCIENCEDIRECT_ROBOT_CHECK]: "needs_user_verify",
    [STATUS.PUBLISHER_BLOCKED_WAITING_USER]: "publisher_blocked",
    [STATUS.NO_FULL_TEXT_LINK]: "no_pdf_link",
    [STATUS.NO_AUTHORIZED_PDF_FOUND]: "no_pdf_link",
    [STATUS.FAILED_AFTER_RETRY]: "error",
    [STATUS.DO_NOT_AUTO_RETRY]: "error",
  };
  return m[s] || s;
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
