
import axios from "axios";
import cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setTimeout as wait } from "timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = (() => {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    if (p.startsWith("--")) {
      const key = p.replace(/^--/, "");
      const next = a[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
})();

function normalizeUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    const A = new URL(a);
    const B = new URL(b);
    return A.protocol === B.protocol && A.hostname === B.hostname && A.port === B.port;
  } catch {
    return false;
  }
}

async function fetchHtml(url, opts = {}) {
  const headers = {
    "User-Agent": opts.ua || "Mozilla/5.0 (compatible; simple-scraper/1.0)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
  const res = await axios.get(url, { headers, timeout: opts.timeout || 15000 });
  return res.data;
}

function extractData(html, base, selector) {
  const $ = cheerio.load(html);
  const title = ($("title").first().text() || "").trim();
  const description =
    ($("meta[name=description]").attr("content") ||
      $("meta[name=Description]").attr("content") ||
      "").trim();
  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const url = normalizeUrl(base, href);
    if (url) links.push({ href: url, text: ($(el).text() || "").trim() });
  });
  const images = [];
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    const url = normalizeUrl(base, src);
    if (url) images.push({ src: url, alt: ($(el).attr("alt") || "").trim() });
  });
  const metas = {};
  $("meta").each((_, el) => {
    const name = $(el).attr("name") || $(el).attr("property") || $(el).attr("http-equiv");
    const content = $(el).attr("content") || $(el).attr("value");
    if (name && content) metas[name.toLowerCase()] = content;
  });
  const selected = [];
  if (selector) {
    $(selector).each((_, el) => {
      selected.push($(el).text().trim());
    });
  }
  return { title, description, metas, links, images, selected };
}

async function writeOutput(data, outPath, format = "json") {
  const toWrite = format === "csv" ? toCSV(data) : JSON.stringify(data, null, 2);
  if (outPath) {
    fs.writeFileSync(outPath, toWrite, "utf8");
    console.log(`Saved to ${outPath}`);
  } else {
    console.log(toWrite);
  }
}

function toCSV(data) {
  const rows = [];
  rows.push(`url,title,description,links_count,images_count`);
  for (const item of data) {
    const line = [
      escapeCSV(item.url),
      escapeCSV(item.title),
      escapeCSV(item.description),
      item.links ? item.links.length : 0,
      item.images ? item.images.length : 0,
    ].join(",");
    rows.push(line);
  }
  return rows.join("\n");
}

function escapeCSV(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function crawl(startUrl, opts = {}) {
  const maxDepth = Number(opts.depth || 1);
  const delayMs = Number(opts.delay || 200);
  const limit = Number(opts.max || 50);
  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  const results = [];

  while (queue.length && visited.size < limit) {
    const node = queue.shift();
    if (visited.has(node.url)) continue;
    try {
      const html = await fetchHtml(node.url, opts);
      const data = extractData(html, node.url, opts.selector);
      results.push({ url: node.url, depth: node.depth, ...data });
      visited.add(node.url);
      if (node.depth < maxDepth) {
        for (const l of data.links) {
          const href = l.href;
          if (!href) continue;
          if (opts.sameOrigin && !sameOrigin(startUrl, href)) continue;
          if (!visited.has(href) && !queue.find((q) => q.url === href)) {
            queue.push({ url: href, depth: node.depth + 1 });
          }
        }
      }
    } catch (err) {
      results.push({ url: node.url, error: String(err) });
    }
    await wait(delayMs);
  }
  return results;
}

async function singleFetch(url, opts = {}) {
  const html = await fetchHtml(url, opts);
  const data = extractData(html, url, opts.selector);
  return [{ url, depth: 0, ...data }];
}

async function main() {
  const url = argv.url || argv.u;
  if (!url) {
    console.log("Usage: node scraper.js --url https://example.com [--selector '.article'] [--out out.json] [--depth 1] [--sameOrigin] [--format json|csv] [--delay ms] [--max 50]");
    process.exit(1);
  }
  const opts = {
    selector: argv.selector || argv.s,
    depth: argv.depth || argv.d || 0,
    sameOrigin: argv.sameOrigin || argv.sameorigin || argv.o || false,
    delay: argv.delay || 200,
    max: argv.max || 50,
    ua: argv.ua || null,
    timeout: argv.timeout || 15000,
  };
  const outPath = argv.out || argv.o;
  const format = (argv.format || argv.f || "json").toLowerCase();

  let data;
  if (Number(opts.depth) > 0) data = await crawl(url, opts);
  else data = await singleFetch(url, opts);

  await writeOutput(data, outPath, format);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
