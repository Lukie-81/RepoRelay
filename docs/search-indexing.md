# Search indexing checklist

This is a maintainer checklist for the RepoRelay GitHub Pages site. It helps
inspect Google's current status; it cannot force indexing or guarantee ranking.

1. Open [Google Search Console](https://search.google.com/search-console).
2. Verify the GitHub Pages property for `https://lukie-81.github.io/RepoRelay/`.
3. Submit this sitemap:

   `https://lukie-81.github.io/RepoRelay/sitemap.xml`

4. Use **URL inspection** for the homepage and choose **Request indexing** if
   the inspected URL is eligible.
5. Repeat inspection for the key canonical pages:

   - `https://lukie-81.github.io/RepoRelay/install/`
   - `https://lukie-81.github.io/RepoRelay/chatgpt-local-repo/`
   - `https://lukie-81.github.io/RepoRelay/chatgpt-local-files/`
   - `https://lukie-81.github.io/RepoRelay/security/`
   - `https://lukie-81.github.io/RepoRelay/github-vs-local/`
   - `https://lukie-81.github.io/RepoRelay/docs/`
   - `https://lukie-81.github.io/RepoRelay/faq/`

Common status meanings:

- **URL is on Google**: Google has indexed the inspected URL.
- **Discovered - currently not indexed**: Google knows about the URL but has
  not indexed it yet. Check crawl signals, content quality, and canonical
  consistency, then allow time for recrawling.
- **Crawled - currently not indexed**: Google fetched the URL but has not
  selected it for indexing. Inspect the rendered page, duplication, and
  canonical signals.
- **Duplicate / canonical issue**: Google found another URL it considers the
  canonical version, or the submitted URL's canonical signals conflict. Check
  the page's canonical tag, internal links, and sitemap entry.
- **Blocked by noindex**: the page or response tells Google not to index it.
  Confirm that only the custom 404 page uses `noindex,follow`, and inspect the
  rendered HTML and response headers in Search Console.
- **Soft 404**: Google thinks a page looks empty, missing, or error-like even
  if the server returned `200`. Check that the page answers a real question,
  has a useful title/H1, and does not render an error state as normal content.

Search Console is the authoritative place to inspect Google's actual indexing
status. Site changes can improve crawl and index signals, but they cannot
guarantee indexing, ranking, or AI citation.

## Technical readiness check

From the GitHub Pages (`gh-pages`) checkout, run:

```text
npm run seo:index-readiness
```

This checks the live HTTPS pages, sitemap, robots declaration, canonical and
robots metadata, Google verification tag, internal assets, identity markers,
and the custom 404 response. It reports technical readiness only. It cannot
confirm whether Google has indexed a URL; use Search Console for that.

## Bing Webmaster Tools

1. Open [Bing Webmaster Tools](https://www.bing.com/webmasters/).
2. Add or import the URL-prefix site:
   `https://lukie-81.github.io/RepoRelay/`.
3. Verify ownership using the available site-verification method.
4. Submit:
   `https://lukie-81.github.io/RepoRelay/sitemap.xml`.
5. Inspect the homepage and the seven other canonical URLs, then monitor
   indexing, crawl errors, and submitted-URL status.

IndexNow is not enabled by this repository. The site is a small, infrequently
changed GitHub Pages project under `/RepoRelay/`; adding a public key file,
key-location handling, and another notification workflow would add ongoing
maintenance without replacing sitemap or webmaster-tool checks. Revisit the
decision if publishing becomes frequent enough to justify it. Bing's current
[IndexNow documentation](https://www.indexnow.org/documentation) describes the
key-file and URL-submission requirements.

To refresh the static site metadata before publishing the Pages branch, run
`node scripts/update-sitemap.mjs` from the GitHub Pages (`gh-pages`) checkout,
which is the site source. The script uses the most recent relevant Git commit
date for each page; run it again after a commit that changes a page so
`lastmod`, `dateModified`, and the visible update line stay truthful.

For the post-indexing backlink, article, and measurement plan, see
[`docs/search-growth.md`](search-growth.md).
