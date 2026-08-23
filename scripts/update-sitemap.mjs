import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteOrigin = "https://lukie-81.github.io/RepoRelay";
const pages = [
  { file: "index.html", route: "/" },
  { file: "install/index.html", route: "/install/" },
  { file: "chatgpt-local-repo/index.html", route: "/chatgpt-local-repo/" },
  { file: "chatgpt-local-files/index.html", route: "/chatgpt-local-files/" },
  { file: "security/index.html", route: "/security/" },
  { file: "github-vs-local/index.html", route: "/github-vs-local/" },
  { file: "docs/index.html", route: "/docs/" },
  { file: "faq/index.html", route: "/faq/" },
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const siteRoot = resolve(argValue("--site-root") ?? process.env.REPORELAY_SITE_ROOT ?? scriptRoot);

function runGit(args) {
  return execFileSync("git", args, { cwd: siteRoot, encoding: "utf8" }).trim();
}

function commitDateFor(file) {
  try {
    const exact = runGit(["log", "-1", "--format=%cI", "--", file]);
    if (exact) return exact;
  } catch {
    // Exported directories may not have Git metadata; use the site fallback below.
  }

  let fallback = "";
  try {
    fallback = runGit(["log", "-1", "--format=%cI", "--", "index.html"]);
  } catch {
    // Report the actionable error below.
  }
  if (!fallback) throw new Error(`No Git commit date is available for ${file}`);
  console.warn(`No history for ${file}; using the latest site commit date ${fallback}. Run this again after committing the page.`);
  return fallback;
}

function day(value) {
  return value.slice(0, 10);
}

function displayDate(value) {
  return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function updatePageDates(page, date) {
  const path = resolve(siteRoot, page.file);
  if (!existsSync(path)) throw new Error(`${page.file} is missing`);
  let html = readFileSync(path, "utf8");
  const marker = /<time\s+data-site-last-modified\s+datetime="[^"]+">[^<]*<\/time>/;
  if (!marker.test(html)) throw new Error(`${page.file} is missing the data-site-last-modified marker`);
  html = html.replace(marker, `<time data-site-last-modified datetime="${date}">${displayDate(date)}</time>`);
  if (!/"dateModified"\s*:\s*"[^"]+"/.test(html)) throw new Error(`${page.file} is missing dateModified JSON-LD`);
  html = html.replace(/("dateModified"\s*:\s*)"[^"]+"/g, `$1"${date}"`);
  writeFileSync(path, html, "utf8");
}

const entries = pages.map((page) => ({ ...page, lastmod: day(commitDateFor(page.file)) }));
for (const entry of entries) updatePageDates(entry, entry.lastmod);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(({ route, lastmod }) => `  <url><loc>${siteOrigin}${route}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
writeFileSync(resolve(siteRoot, "sitemap.xml"), sitemap, "utf8");
console.log(`Updated ${entries.length} canonical sitemap entries and page modification dates.`);
for (const { file, lastmod } of entries) console.log(`${relative(siteRoot, resolve(siteRoot, file))}: ${lastmod}`);
