# Search growth plan

This is a maintainer plan for earning useful referrals to RepoRelay. It is
not a backlink-submission list, a promise of rankings, or a reason to create
pages for every keyword variant.

## Keep the entity consistent

Use these values in public listings and technical references:

| Field | Canonical value |
| --- | --- |
| Product | `RepoRelay` |
| Descriptive name | `RepoRelay MCP` |
| npm package | `reporelay-mcp` |
| GitHub | `Lukie-81/RepoRelay` |
| MCP identifier | `io.github.Lukie-81/reporelay` |
| Website | `https://lukie-81.github.io/RepoRelay/` |

When a directory has stale metadata, first verify the repository source,
`server.json`, package metadata, and the live site. Then request a rescan or
edit through that directory's normal maintainer process. Do not change the
security model or tool surface to satisfy a crawler.

The published npm `reporelay-mcp@1.2.5` record still has the older GitHub
README homepage, even though the repository package metadata now points to the
Pages site. npm updates that public field only when a package is published, so
carry the corrected metadata into the next legitimate release and verify it
with `npm view reporelay-mcp homepage`. Do not publish a version solely to
change SEO metadata.

## Backlink target map

When an external article or discussion genuinely covers one of these topics,
link to the most specific useful page rather than sending every visitor to the
homepage.

| External topic | Preferred RepoRelay target |
| --- | --- |
| What is RepoRelay? | [`/`](https://lukie-81.github.io/RepoRelay/) |
| ChatGPT accessing a local repository | [`/chatgpt-local-repo/`](https://lukie-81.github.io/RepoRelay/chatgpt-local-repo/) |
| ChatGPT accessing local files without a ZIP upload | [`/chatgpt-local-files/`](https://lukie-81.github.io/RepoRelay/chatgpt-local-files/) |
| RepoRelay security boundary | [`/security/`](https://lukie-81.github.io/RepoRelay/security/) |
| GitHub versus local review | [`/github-vs-local/`](https://lukie-81.github.io/RepoRelay/github-vs-local/) |
| Installation and tunnel setup | [`/install/`](https://lukie-81.github.io/RepoRelay/install/) |
| Common questions | [`/faq/`](https://lukie-81.github.io/RepoRelay/faq/) |

Only pursue a link when the page is a useful source for that audience. Do not
buy links, exchange links in bulk, post repetitive comments, or submit the
same URL to unrelated directories.

## Technical article opportunities

These are ideas to evaluate against Search Console queries and recurring
developer questions. They are not a request to publish all of them.

| User intent | Article angle | Link target | New value required |
| --- | --- | --- | --- |
| Review code before a push | A local-first review workflow for uncommitted changes | `/github-vs-local/` | Show the boundary between local working state, GitHub, and an AI review. |
| Understand MCP repository access | What an MCP client, server, tunnel, and approved root each do | `/chatgpt-local-repo/` | Explain the request path with a concrete, bounded example. |
| Connect ChatGPT Web locally | A tested Secure MCP Tunnel setup and troubleshooting guide | `/install/` | Include current prerequisites, expected output, and failure recovery. |
| Choose permissions for an AI code-review server | Read/search access versus shell and arbitrary-write access | `/security/` | Compare capabilities and explain why the smaller surface is easier to audit. |
| Avoid giving an AI a shell | Threat-model a repository reviewer without process execution | `/security/` | Show realistic attack paths and the controls that stop them. |
| Review local files without a ZIP upload | What travels through an explicit MCP connection | `/chatgpt-local-files/` | Distinguish no archive upload from no data transmission. |
| Understand GitHub versus local review | Which state each workflow can observe and when | `/github-vs-local/` | Give a decision table tied to actual developer situations. |
| Debug a zero-tool or stale-tool ChatGPT app | Verify the bridge, tunnel, app, and tool surface in order | `/faq/` | Provide evidence-based checks without asking users to weaken security. |

An article should answer a question substantially better than the existing
page. A lightly rewritten keyword variant belongs in the existing page, not a
new URL.

## What to measure

Review these metrics monthly or after a meaningful site change:

- Google Search Console: indexed pages, impressions, clicks, CTR, average
  position, queries, pages receiving impressions, and crawl/indexing issues.
- Bing Webmaster Tools: submitted URLs, crawl/indexing status, search queries,
  clicks, impressions, and errors.
- GitHub: referral traffic, repository views, clones, stars, and forks.
- npm: package downloads and the referring context when available.

Use query and page data to decide what to explain next. Treat generic SEO
scores, domain-authority estimates, and raw backlink counts as secondary
signals.

## When to create another page

Create additional website content only when there is evidence of distinct
intent, such as:

1. a Search Console query cluster that existing pages do not answer;
2. a recurring community question that needs more than a short FAQ answer;
3. a concept too large to explain clearly on an existing canonical page; or
4. a comparison with a genuinely different decision and audience.

Before publishing, identify the target question, the evidence or example the
new page adds, its canonical URL, and the existing page it should link to. If
the only justification is that a keyword exists, do not create the page.
