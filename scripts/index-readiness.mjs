import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const origin = (process.env.REPORELAY_LIVE_ORIGIN ?? "https://lukie-81.github.io/RepoRelay").replace(/\/$/, "");
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pages = [
  { route: "/", label: "homepage" },
  { route: "/install/", label: "install" },
  { route: "/chatgpt-local-repo/", label: "chatgpt-local-repo" },
  { route: "/chatgpt-local-files/", label: "chatgpt-local-files" },
  { route: "/security/", label: "security" },
  { route: "/github-vs-local/", label: "github-vs-local" },
  { route: "/faq/", label: "faq" },
  { route: "/docs/", label: "docs" },
];
const errors = [];
const checks = [];

function fail(message) {
  errors.push(message);
}

function record(label, passed, detail = "") {
  checks.push({ label, passed, detail });
}

async function fetchText(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      redirect: "follow",
      headers: { "user-agent": "RepoRelay-index-readiness/1.0" },
      signal: controller.signal,
    });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

function metaContent(html, name) {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1];
    const metaName = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (metaName === name.toLowerCase()) return attrs.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  }
  return "";
}

function canonicalHref(html) {
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1];
    const rel = attrs.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase().split(/\s+/) ?? [];
    if (rel.includes("canonical")) return attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
  }
  return "";
}

function hasMojibake(text) {
  return /[\u00c3\u00c2]|\u00e2\u0080|\u00ef\u00bf\u00bd|\ufffd/.test(text);
}

function checkCanonicalPage(page, html) {
  const expectedCanonical = `${origin}${page.route}`;
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
  const description = metaContent(html, "description");
  const robots = metaContent(html, "robots").toLowerCase();
  const canonical = canonicalHref(html);
  if (!title) fail(`${page.label}: missing title`);
  if (!description) fail(`${page.label}: missing meta description`);
  if (canonical !== expectedCanonical) fail(`${page.label}: canonical mismatch (${canonical || "missing"})`);
  if (!robots.includes("index") || !robots.includes("follow") || robots.includes("noindex")) fail(`${page.label}: expected index,follow robots meta`);
  if ([...html.matchAll(/<h1\b/gi)].length !== 1) fail(`${page.label}: expected exactly one H1`);
  const scripts = [...html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi)];
  if (!scripts.length) fail(`${page.label}: missing JSON-LD`);
  for (const script of scripts) {
    try {
      JSON.parse(script[1]);
    } catch (error) {
      fail(`${page.label}: malformed JSON-LD (${error.message})`);
    }
  }
  if (hasMojibake(html)) fail(`${page.label}: obvious encoding corruption detected`);
}

async function main() {
  const pageBodies = new Map();
  const assetUrls = new Set();
  for (const page of pages) {
    try {
      const { response, text } = await fetchText(page.route);
      pageBodies.set(page.route, text);
      if (response.status !== 200) fail(`${page.label}: HTTP ${response.status}`);
      checkCanonicalPage(page, text);
      for (const match of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
        const raw = match[1];
        if (raw.startsWith("/RepoRelay/") && !raw.startsWith("#")) assetUrls.add(new URL(raw, `${origin}/`).href);
        if (raw.startsWith("/") && !raw.startsWith("/RepoRelay/")) fail(`${page.label}: path is missing /RepoRelay/ prefix: ${raw}`);
      }
    } catch (error) {
      fail(`${page.label}: request failed (${error.message})`);
    }
  }
  record("Live homepage", !errors.some((error) => error.startsWith("homepage:")));
  record("Canonical pages", pageBodies.size === pages.length && !errors.some((error) => /^(install|chatgpt-local-repo|chatgpt-local-files|security|github-vs-local|faq|docs):/.test(error)), `${pageBodies.size}/${pages.length}`);
  record("No accidental noindex", !errors.some((error) => error.includes("expected index,follow robots meta")));
  record("Canonical consistency", !errors.some((error) => error.includes("canonical mismatch")));

  try {
    const { response, text } = await fetchText("/sitemap.xml");
    const urls = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    const expected = pages.map((page) => `${origin}${page.route}`);
    if (response.status !== 200) fail(`sitemap: HTTP ${response.status}`);
    if (urls.length !== expected.length || expected.some((url) => !urls.includes(url))) fail(`sitemap: expected ${expected.length} canonical URLs, found ${urls.length}`);
    record("Sitemap reachable", response.status === 200, `${urls.length} canonical URLs`);
    record("Canonical pages in sitemap", urls.length === expected.length && expected.every((url) => urls.includes(url)), `${urls.length}/${expected.length}`);
  } catch (error) {
    fail(`sitemap: request failed (${error.message})`);
    record("Sitemap reachable", false);
    record("Canonical pages in sitemap", false);
  }

  try {
    const { response, text } = await fetchText("/robots.txt");
    const passed = response.status === 200 && text.includes(`Sitemap: ${origin}/sitemap.xml`);
    if (!passed) fail(`robots.txt: HTTP ${response.status} or sitemap declaration missing`);
    record("Robots meta", passed);
  } catch (error) {
    fail(`robots.txt: request failed (${error.message})`);
    record("Robots meta", false);
  }

  try {
    const { response, text } = await fetchText("/llms.txt");
    const passed = response.status === 200 && text.includes("io.github.Lukie-81/reporelay") && text.includes("reporelay-mcp");
    if (!passed) fail(`llms.txt: HTTP ${response.status} or canonical identity missing`);
    record("Entity identity", passed);
  } catch (error) {
    fail(`llms.txt: request failed (${error.message})`);
    record("Entity identity", false);
  }

  const homepage = pageBodies.get("/") ?? "";
  const verificationPassed = Boolean(metaContent(homepage, "google-site-verification"));
  if (!verificationPassed) fail("homepage: Google verification tag missing");
  record("Google verification tag", verificationPassed, verificationPassed ? "PRESENT" : "MISSING");

  for (const url of assetUrls) {
    try {
      const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "RepoRelay-index-readiness/1.0" } });
      if (response.status !== 200) fail(`asset: HTTP ${response.status} for ${url}`);
    } catch (error) {
      fail(`asset: request failed for ${url} (${error.message})`);
    }
  }
  record("Internal assets", !errors.some((error) => error.startsWith("asset:")), `${assetUrls.size} checked`);

  const invalidRoute = "/__reporelay-index-readiness-missing__/";
  try {
    const { response, text } = await fetchText(invalidRoute);
    const robots = metaContent(text, "robots").toLowerCase();
    const passed = response.status === 404 && robots.includes("noindex") && robots.includes("follow");
    if (!passed) fail(`404: expected HTTP 404 and noindex,follow, got HTTP ${response.status}`);
    record("404 noindex", passed);
  } catch (error) {
    fail(`404: request failed (${error.message})`);
    record("404 noindex", false);
  }

  const packagePath = resolve(scriptRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
      if (version && !homepage.includes(`"softwareVersion": "${version}"`)) fail(`homepage: live softwareVersion does not match local package version ${version}`);
    } catch (error) {
      fail(`local package.json: malformed JSON (${error.message})`);
    }
  }

  console.log("RepoRelay Index Readiness");
  for (const check of checks) console.log(`${check.label.padEnd(26)} ${check.passed ? "PASS" : "FAIL"}${check.detail ? ` (${check.detail})` : ""}`);
  console.log("");
  console.log("This checks technical readiness only. Google Search Console is required to confirm index status.");
  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    console.error(`RESULT: FAIL (${errors.length} error(s))`);
    process.exitCode = 1;
  } else {
    console.log("RESULT: PASS");
  }
}

await main();
