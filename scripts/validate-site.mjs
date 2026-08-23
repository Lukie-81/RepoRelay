import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://lukie-81.github.io/RepoRelay";
const prefix = "/RepoRelay";
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
const errors = [];
const warnings = [];
const statuses = new Map([
  ["pages", true],
  ["titles", true],
  ["descriptions", true],
  ["canonical", true],
  ["robots", true],
  ["jsonld", true],
  ["internal", true],
  ["images", true],
  ["encoding", true],
  ["sitemap", true],
  ["siteText", true],
  ["identity", true],
  ["indexing", true],
]);
let toolSurfaceSummary = "not checked";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const siteRoot = resolve(argValue("--site-root") ?? process.env.REPORELAY_SITE_ROOT ?? scriptRoot);
const sourceRoot = resolve(argValue("--source-root") ?? process.env.REPORELAY_SOURCE_ROOT ?? siteRoot);

function fail(message, category = "siteText") {
  errors.push(message);
  if (statuses.has(category)) statuses.set(category, false);
}

function warn(message) {
  warnings.push(message);
}

function relativeName(file) {
  return relative(siteRoot, file).replaceAll("\\", "/");
}

function readText(file, category = "siteText") {
  if (!existsSync(file)) {
    fail(`${relativeName(file)}: missing`, category);
    return "";
  }
  return readFileSync(file, "utf8");
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label}: missing or malformed JSON (${error.message})`, "identity");
    return {};
  }
}

function htmlFiles(dir = siteRoot) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".ai-handoff") continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) results.push(...htmlFiles(path));
    else if (extname(entry.name).toLowerCase() === ".html") results.push(path);
  }
  return results;
}

function count(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function firstTagValue(html, pattern) {
  return html.match(pattern)?.[1]?.trim() ?? "";
}

function attributeValue(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]?.trim() ?? "";
}

function metaContent(html, name) {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (attributeValue(attributes, "name").toLowerCase() === name.toLowerCase()) {
      return attributeValue(attributes, "content");
    }
  }
  return "";
}

function canonicalHref(html) {
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (attributeValue(attributes, "rel").toLowerCase().split(/\s+/).includes("canonical")) {
      return attributeValue(attributes, "href");
    }
  }
  return "";
}

function routeForFile(file) {
  const relativeFile = relativeName(file);
  if (relativeFile === "index.html") return "/";
  if (relativeFile.endsWith("/index.html")) return `/${relativeFile.slice(0, -"index.html".length)}`;
  return `/${relativeFile}`;
}

function fileForRoute(route) {
  if (route === `${prefix}/` || route === prefix) return resolve(siteRoot, "index.html");
  if (!route.startsWith(`${prefix}/`)) return null;
  let relativeRoute;
  try {
    relativeRoute = decodeURIComponent(route.slice(prefix.length)).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const candidate = resolve(siteRoot, relativeRoute.endsWith("/") ? join(relativeRoute, "index.html") : relativeRoute);
  const rootPrefix = siteRoot.endsWith(sep) ? siteRoot : `${siteRoot}${sep}`;
  if (candidate !== siteRoot && !candidate.startsWith(rootPrefix)) return null;
  return candidate;
}

function checkLocalReference(pageFile, raw) {
  if (!raw || raw.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(raw)) {
    if (raw.startsWith("#")) checkFragment(pageFile, pageFile, raw.slice(1));
    return;
  }

  let url;
  try {
    url = new URL(raw, `${origin}${routeForFile(pageFile)}`);
  } catch {
    fail(`${relativeName(pageFile)}: invalid link or asset reference ${raw}`, "internal");
    return;
  }
  if (url.origin !== origin) return;
  const target = fileForRoute(url.pathname);
  if (!target || !existsSync(target)) {
    fail(`${relativeName(pageFile)}: broken link or asset reference ${raw}`, "internal");
    return;
  }
  if (url.hash) checkFragment(pageFile, target, decodeURIComponent(url.hash.slice(1)));
}

function checkFragment(pageFile, targetFile, fragment) {
  if (!fragment) return;
  const targetHtml = readText(targetFile, "internal");
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(?:id|name)=["']${escaped}["']`).test(targetHtml)) {
    fail(`${relativeName(pageFile)}: broken fragment #${fragment}`, "internal");
  }
}

function validateHtml(page, html, file, titles, descriptions) {
  if (!/^<!doctype html>/i.test(html.trim())) fail(`${page.file}: missing HTML5 doctype`, "siteText");
  if (!/<meta\s+charset=["']utf-8["']\s*\/?>/i.test(html)) fail(`${page.file}: missing UTF-8 charset`, "siteText");

  const title = firstTagValue(html, /<title>([^<]*)<\/title>/i);
  const description = metaContent(html, "description");
  const canonical = canonicalHref(html);
  const robots = metaContent(html, "robots").toLowerCase();
  if (count(html, /<title>/gi) !== 1 || !title) fail(`${page.file}: missing or duplicate title`, "titles");
  if (count(html, /<meta\b[^>]*\bname=["']description["']/gi) !== 1 || !description) fail(`${page.file}: missing or duplicate meta description`, "descriptions");
  if (count(html, /<link\b[^>]*\brel=["'][^"']*canonical[^"']*["']/gi) !== 1 || canonical !== `${origin}${page.route}`) fail(`${page.file}: canonical mismatch (${canonical || "missing"})`, "canonical");
  if (count(html, /<meta\b[^>]*\bname=["']robots["']/gi) !== 1 || !robots.includes("index") || !robots.includes("follow") || robots.includes("noindex")) fail(`${page.file}: expected one index,follow robots directive`, "robots");
  if (count(html, /<h1\b/gi) !== 1) fail(`${page.file}: expected exactly one H1`, "siteText");
  if (count(html, /<script\s+type=["']application\/ld\+json["']/gi) < 1) fail(`${page.file}: missing JSON-LD`, "jsonld");
  if (!html.includes("data-site-last-modified") || !/"dateModified"\s*:\s*"\d{4}-\d{2}-\d{2}"/.test(html)) fail(`${page.file}: missing modification date markers`, "siteText");

  if (titles.has(title)) fail(`duplicate title: ${page.file} and ${titles.get(title)}`, "titles");
  else titles.set(title, page.file);
  if (descriptions.has(description)) fail(`duplicate description: ${page.file} and ${descriptions.get(description)}`, "descriptions");
  else descriptions.set(description, page.file);

  for (const script of html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(script[1]);
      if (value?.["@context"] !== "https://schema.org") fail(`${page.file}: JSON-LD context is not schema.org`, "jsonld");
    } catch (error) {
      fail(`${page.file}: malformed JSON-LD (${error.message})`, "jsonld");
    }
  }

  for (const tag of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attributes = tag[1];
    if (!/\balt=["'][^"']*["']/i.test(attributes)) fail(`${page.file}: image is missing alt text`, "images");
    if (!/\bwidth=["'][^"']+["']/i.test(attributes) || !/\bheight=["'][^"']+["']/i.test(attributes)) fail(`${page.file}: image is missing explicit dimensions`, "images");
  }

  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (raw.startsWith("/") && !raw.startsWith(prefix)) fail(`${page.file}: path is missing /RepoRelay/ prefix: ${raw}`, "internal");
    checkLocalReference(file, raw);
  }
  if (/[\u00c3\u00c2]|\u00e2\u0080|\u00ef\u00bf\u00bd|\ufffd/.test(html)) fail(`${page.file}: obvious encoding corruption detected`, "encoding");
  return { title, description };
}

function validate404() {
  const file = resolve(siteRoot, "404.html");
  const html = readText(file, "siteText");
  const robots = metaContent(html, "robots").toLowerCase();
  if (!robots.includes("noindex") || !robots.includes("follow")) fail("404.html: expected noindex,follow robots meta", "indexing");
  if (count(html, /<h1\b/gi) !== 1) fail("404.html: expected exactly one H1", "siteText");
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) checkLocalReference(file, match[1]);
  if (/[\u00c3\u00c2]|\u00e2\u0080|\u00ef\u00bf\u00bd|\ufffd/.test(html)) fail("404.html: obvious encoding corruption detected", "encoding");
}

function validateSitemap() {
  const file = resolve(siteRoot, "sitemap.xml");
  const xml = readText(file, "sitemap");
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') || !xml.includes("<urlset") || !xml.includes("</urlset>")) fail("sitemap.xml: malformed XML envelope", "sitemap");
  const entries = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>\s*<\/url>/g)].map((match) => ({ url: match[1], lastmod: match[2] }));
  if (entries.length !== pages.length) fail(`sitemap.xml: expected ${pages.length} canonical entries, found ${entries.length}`, "sitemap");
  const expected = new Set(pages.map((page) => `${origin}${page.route}`));
  const actual = new Set(entries.map((entry) => entry.url));
  for (const url of expected) if (!actual.has(url)) fail(`sitemap.xml: missing ${url}`, "sitemap");
  for (const url of actual) if (!expected.has(url)) fail(`sitemap.xml: unexpected URL ${url}`, "sitemap");
  for (const entry of entries) {
    try {
      if (!existsSync(fileForRoute(new URL(entry.url).pathname))) fail(`sitemap.xml: URL has no matching page ${entry.url}`, "sitemap");
    } catch {
      fail(`sitemap.xml: invalid URL ${entry.url}`, "sitemap");
    }
  }
  if (entries.length !== actual.size) fail("sitemap.xml: duplicate URLs", "sitemap");
}

function parseStringArray(source, name) {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as const;`));
  if (!match) throw new Error(`could not read ${name} from src/security-verification.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function normalizeRepositoryUrl(value) {
  return String(value ?? "").replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
}

function normalizedText(value) {
  return value.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function validateSourceFacts(homepage) {
  const packageJson = readJson(resolve(sourceRoot, "package.json"), "package.json");
  const serverJson = readJson(resolve(sourceRoot, "server.json"), "server.json");
  const expectedOrigin = `${origin}/`;
  const packageRepository = normalizeRepositoryUrl(packageJson.repository?.url);
  const serverRepository = normalizeRepositoryUrl(serverJson.repository?.url);
  if (packageJson.name !== "reporelay-mcp") fail(`package.json: expected name reporelay-mcp, found ${packageJson.name || "missing"}`, "identity");
  if (packageJson.mcpName !== "io.github.Lukie-81/reporelay") fail(`package.json: MCP name mismatch (${packageJson.mcpName || "missing"})`, "identity");
  if (packageJson.homepage !== expectedOrigin) fail(`package.json: homepage must be ${expectedOrigin}`, "identity");
  if (packageJson.license !== "MIT") fail(`package.json: license must be MIT`, "identity");
  if (packageRepository !== "https://github.com/Lukie-81/RepoRelay") fail("package.json: repository URL mismatch", "identity");
  if (serverJson.name !== packageJson.mcpName) fail("server.json: MCP name mismatch", "identity");
  if (serverJson.websiteUrl !== expectedOrigin) fail(`server.json: websiteUrl must be ${expectedOrigin}`, "identity");
  if (serverRepository !== packageRepository) fail("server.json: repository URL does not match package.json", "identity");
  if (serverJson.version !== packageJson.version || serverJson.packages?.[0]?.version !== packageJson.version) fail("server.json: version does not match package.json", "identity");
  if (serverJson.packages?.[0]?.identifier !== packageJson.name) fail("server.json: npm identifier does not match package.json", "identity");

  const version = String(packageJson.version ?? "");
  const nodeRequirement = String(packageJson.engines?.node ?? "");
  const siteText = pages.map((page) => readText(resolve(siteRoot, page.file))).join("\n") + readText(resolve(siteRoot, "llms.txt")) + readText(resolve(siteRoot, "README.md"));
  const decodedSiteText = normalizedText(siteText);
  if (!homepage.includes(`"softwareVersion": "${version}"`)) fail(`website JSON-LD: softwareVersion is not ${version}`, "identity");
  if (!homepage.includes(`"identifier": "${packageJson.mcpName}"`)) fail("website JSON-LD: MCP identifier is missing or stale", "identity");
  if (!siteText.includes(packageJson.name) || !siteText.includes(packageJson.mcpName)) fail("website: canonical package/MCP identity is missing", "identity");
  for (const part of nodeRequirement.split(/\s+/).filter(Boolean)) {
    if (!decodedSiteText.includes(part)) fail(`website: Node requirement is missing ${part}`, "identity");
  }

  const verificationSource = readText(resolve(sourceRoot, "src/security-verification.ts"), "identity");
  try {
    const readTools = parseStringArray(verificationSource, "REVIEW_READ_TOOLS");
    const handoffTools = parseStringArray(verificationSource, "HANDOFF_WRITE_TOOLS");
    const documentedTools = ["security/index.html", "chatgpt-local-repo/index.html", "README.md"].map((file) => readText(resolve(siteRoot, file))).join("\n");
    for (const tool of [...readTools, ...handoffTools]) {
      if (!documentedTools.includes(tool)) fail(`website: documented tool surface is missing ${tool}`, "identity");
    }
    toolSurfaceSummary = `PASS (${readTools.length} inspection + ${handoffTools.length} fixed handoff)`;
  } catch (error) {
    fail(`source tool surface: ${error.message}`, "identity");
  }

  if (!metaContent(homepage, "google-site-verification")) fail("homepage: Google verification tag is missing", "indexing");
}

function validateDiscoveryFiles() {
  const robots = readText(resolve(siteRoot, "robots.txt"));
  if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) fail("robots.txt: missing project sitemap declaration", "sitemap");
  if (!robots.includes("project-site") || !robots.includes("host-root")) warn("robots.txt: project-site limitation comment is not explicit");
  const llms = readText(resolve(siteRoot, "llms.txt"));
  for (const required of ["reporelay-mcp", "io.github.Lukie-81/reporelay", "chatgpt-local-files", "SECURITY.md"]) {
    if (!llms.includes(required)) fail(`llms.txt: missing ${required}`, "siteText");
  }
}

const titles = new Map();
const descriptions = new Map();
const allHtml = htmlFiles();
const homepageFile = resolve(siteRoot, "index.html");
const homepage = readText(homepageFile);
for (const page of pages) {
  const file = resolve(siteRoot, page.file);
  if (!existsSync(file)) {
    fail(`${page.file}: canonical page is missing`, "pages");
    continue;
  }
  validateHtml(page, readFileSync(file, "utf8"), file, titles, descriptions);
}
validate404();
validateSitemap();
validateDiscoveryFiles();
validateSourceFacts(homepage);
if (allHtml.length !== pages.length + 1) warn(`Found ${allHtml.length} HTML files; expected ${pages.length} canonical pages plus 404.html.`);

console.log("RepoRelay Site Audit");
console.log("");
console.log(`Canonical pages:       ${pages.filter((page) => existsSync(resolve(siteRoot, page.file))).length}/${pages.length} ${statuses.get("pages") ? "PASS" : "FAIL"}`);
console.log(`Unique titles:         ${statuses.get("titles") ? "PASS" : "FAIL"}`);
console.log(`Meta descriptions:     ${statuses.get("descriptions") ? "PASS" : "FAIL"}`);
console.log(`Canonical URLs:        ${statuses.get("canonical") ? "PASS" : "FAIL"}`);
console.log(`Robots directives:     ${statuses.get("robots") ? "PASS" : "FAIL"}`);
console.log(`JSON-LD:               ${statuses.get("jsonld") ? "PASS" : "FAIL"}`);
console.log(`Internal links:        ${statuses.get("internal") ? "PASS" : "FAIL"}`);
console.log(`Sitemap consistency:   ${statuses.get("sitemap") ? "PASS" : "FAIL"}`);
console.log(`404 noindex:           ${statuses.get("indexing") ? "PASS" : "FAIL"}`);
console.log(`Images / alt:          ${statuses.get("images") ? "PASS" : "FAIL"}`);
console.log(`Entity consistency:    ${statuses.get("identity") ? "PASS" : "FAIL"}`);
console.log(`Tool surface:          ${toolSurfaceSummary}`);
console.log("");

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.error(`RESULT: FAIL (${errors.length} error(s))`);
  process.exitCode = 1;
} else {
  console.log("RESULT: PASS");
}
