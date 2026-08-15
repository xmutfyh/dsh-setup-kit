// FULink title search and document-delivery handoff.
// Search is automatic; final request/fee confirmation remains user-controlled.
import path from "node:path";
import {
  DEFAULT_PROXY,
  healthCheck,
  newTab,
  navigate,
  evalJs,
  waitForComplete,
  closeTab,
} from "./lib/cdp-utils.mjs";
import { fetchToFile } from "./lib/pdf-utils.mjs";
import { STATUS } from "./lib/status-codes.mjs";

const SEARCH_ROOT = "https://fx.fulink.superlib.net/";

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/co\s*2|co₂/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleVariants(title) {
  const original = String(title || "").trim();
  const noCo2 = original.replace(/co\s*2|co₂/giu, " ").replace(/\s+/g, " ").trim();
  const noPunctuation = noCo2.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  const stop = new Set(["a", "an", "and", "as", "by", "during", "for", "from", "in", "into", "of", "on", "the", "to", "with"]);
  const core = noPunctuation.split(" ").filter((x) => x.length >= 3 && !stop.has(x.toLowerCase())).slice(0, 12).join(" ");
  return [...new Set([original, noCo2, noPunctuation, core].filter((x) => x.length >= 8))];
}

function scoreCandidate(candidate, requested, year, journal) {
  const titleText = normalizeText(candidate.title);
  const titleTokens = normalizeText(requested).split(" ").filter((x) => x.length >= 3);
  const matchedTitle = titleTokens.filter((x) => titleText.includes(x)).length;
  const titleScore = titleTokens.length ? matchedTitle / titleTokens.length : 0;
  const metadata = normalizeText(`${candidate.text}`);
  let score = titleScore * 0.8;
  if (year && metadata.includes(String(year))) score += 0.1;
  if (journal && normalizeText(journal).split(" ").filter((x) => x.length >= 4).every((x) => metadata.includes(x))) score += 0.1;
  return { score, titleScore };
}

async function inspectResults(proxy, target) {
  return evalJs(proxy, target, `(()=>{
    const links=[...document.querySelectorAll('a[href*="detail_"]')];
    const out=[]; const seen=new Set();
    for(const link of links){
      if(seen.has(link.href)) continue; seen.add(link.href);
      let node=link;
      for(let i=0;i<8 && node;i++,node=node.parentElement){
        const text=(node.innerText||'').trim();
        if(text.includes('出处') && text.includes('获取')){
          const delivery=[...node.querySelectorAll('a[href]')].find(a=>(a.innerText||'').includes('文献传递'));
          out.push({title:(link.innerText||'').replace(/^\\[.*?\\]\\s*/, '').trim(),text:text.slice(0,3000),detailUrl:link.href,deliveryUrl:delivery?.href||null});
          break;
        }
      }
    }
    return {title:document.title||'',url:location.href,body:(document.body?.innerText||'').slice(0,1600),items:out.slice(0,100)};
  })()`);
}

async function inspectRequestPage(proxy, target) {
  return evalJs(proxy, target, `(()=>({
    title:document.title||'',url:location.href,
    body:(document.body?.innerText||'').slice(0,5000),
    login:!!document.querySelector('input[type=password]') || /login|登录/i.test(location.href),
    fields:[...document.querySelectorAll('input,select,textarea,button')].map(e=>({tag:e.tagName,type:e.type||'',name:e.name||'',id:e.id||'',text:(e.innerText||e.value||'').trim().slice(0,120)})),
    pdfLinks:[...document.querySelectorAll('a[href],iframe[src],embed[src]')].map(e=>e.href||e.src).filter(x=>/\\.pdf(?:$|[?#])|download|fulltext|全文/i.test(x||'')).slice(0,30)
  }))()`);
}

async function searchOne(proxy, title, year, journal, keepTab = true) {
  const tab = (await newTab(proxy, SEARCH_ROOT)).targetId;
  let selected = null;
  let usedQuery = null;
  try {
    for (const query of titleVariants(title)) {
      usedQuery = query;
      const url = `${SEARCH_ROOT}s?sw=${encodeURIComponent(query)}&strchannel=1,2&strchoren=1`;
      await navigate(proxy, tab, url);
      await waitForComplete(proxy, tab, 45000);
      const page = await inspectResults(proxy, tab);
      const candidates = (page?.items || [])
        .map((item) => ({ ...item, ...scoreCandidate(item, title, year, journal) }))
        .sort((a, b) => b.score - a.score);
      if (candidates[0] && candidates[0].titleScore >= 0.65 && candidates[0].score >= 0.65) {
        selected = candidates[0];
        break;
      }
    }
    if (!selected) {
      if (!keepTab) await closeTab(proxy, tab);
      return { title, status: STATUS.FULINK_SEARCH_NO_MATCH, query: usedQuery, tab_id: keepTab ? tab : null };
    }
    if (!selected.deliveryUrl) {
      if (!keepTab) await closeTab(proxy, tab);
      return { title, status: STATUS.FULINK_MATCH_WITHOUT_DELIVERY, query: usedQuery, match: selected, tab_id: keepTab ? tab : null };
    }
    await navigate(proxy, tab, selected.deliveryUrl);
    await waitForComplete(proxy, tab, 45000);
    const request = await inspectRequestPage(proxy, tab);
    return {
      title,
      status: request.login ? STATUS.FULINK_LOGIN_REQUIRED : STATUS.FULINK_REQUEST_FORM,
      query: usedQuery,
      tab_id: tab,
      match: selected,
      request: {
        url: request.url,
        title: request.title,
        body: request.body,
        fields: request.fields,
        pdfLinks: request.pdfLinks,
      },
    };
  } catch (error) {
    if (!keepTab) await closeTab(proxy, tab);
    return { title, status: STATUS.FULINK_FAILED, query: usedQuery, tab_id: keepTab ? tab : null, error: String(error).slice(0, 300) };
  }
}

async function continueTarget(proxy, target, outPath) {
  const page = await inspectRequestPage(proxy, target);
  if (page.login) return { status: STATUS.FULINK_LOGIN_REQUIRED, target_id: target, url: page.url, fields: page.fields };
  const pdf = page.pdfLinks.find((x) => /\.pdf(?:$|[?#])/i.test(x));
  if (!pdf) return { status: STATUS.FULINK_WAITING_DELIVERY, target_id: target, url: page.url, body: page.body, fields: page.fields };
  const got = await fetchToFile(proxy, target, pdf, outPath);
  return got.ok ? { status: STATUS.FULINK_PDF_DOWNLOADED, target_id: target, file: got.file, bytes: got.bytes, url: pdf } : { status: STATUS.FULINK_PDF_FETCH_FAILED, target_id: target, url: pdf, error: got.err };
}

async function main() {
  const args = process.argv.slice(2);
  const proxy = argValue(args, "--proxy", DEFAULT_PROXY);
  const title = argValue(args, "--title");
  const target = argValue(args, "--target");
  const year = argValue(args, "--year");
  const journal = argValue(args, "--journal");
  const out = argValue(args, "--out", path.resolve("fulink_delivery.pdf"));
  if (!title && !target) throw new Error("Provide --title or --target");
  await healthCheck(proxy);
  const result = target
    ? await continueTarget(proxy, target, out)
    : await searchOne(proxy, title, year, journal, true);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
