#!/usr/bin/env node
/**
 * 0.17.0 — convert every Markdown doc to a self-contained HTML
 * page for hosting on the marketing site.
 *
 * Output lives at docs/html/. Each .md becomes a .html with:
 *   • shared inline CSS (no external requests, deploy-anywhere safe)
 *   • anchor links on every heading
 *   • a top header linking back to the index
 *   • a footer with build timestamp + commit ref (when available)
 *
 * Also writes docs/html/index.html with a categorized list of all
 * generated pages.
 *
 * Run:    npm run docs:html
 * Output: docs/html/*.html (gitignored if you prefer; we commit
 *         them in this repo so the marketing site can pull
 *         straight from main without a build step).
 *
 * Dependencies: `marked` (added to root package.json devDeps).
 * No other deps — output is a flat directory of static files.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS_DIR = join(ROOT, 'docs');
const OUT_DIR = join(DOCS_DIR, 'html');

/**
 * Friendly titles + categorized order for the index page. Anything
 * not listed here still gets generated (with a derived title from
 * the first H1) but appears in the "Other" bucket at the bottom.
 */
const CATEGORIES = [
  {
    title: 'Getting started',
    docs: [
      ['README.md',           'README'],
      ['QUICKSTART.md',       'Quick Start'],
      ['INSTALLATION.md',     'Installation'],
    ],
  },
  {
    title: 'Product',
    docs: [
      ['FEATURES.md',         'Features'],
      ['ROADMAP.md',          'Roadmap'],
      ['CHANGELOG.md',        'Changelog'],
      ['KNOWN_ISSUES.md',     'Known Issues'],
    ],
  },
  {
    title: 'SaaS operator',
    docs: [
      ['SAAS_PLAN.md',        'SaaS Plan — pricing + gating'],
      ['STRIPE_SETUP.md',     'Stripe Setup'],
      ['OPERATOR_RUNBOOK.md', 'Operator Runbook'],
      ['ADMIN_GUIDE.md',      'Admin Guide'],
    ],
  },
  {
    title: 'Development',
    docs: [
      ['DOCUMENTATION.md',    'General Documentation (API + architecture)'],
      ['CONTRIBUTING.md',     'Contributing'],
      ['TESTING.md',          'Testing Guide'],
      ['PROCESS.md',          'Process Playbook'],
    ],
  },
  {
    title: 'Legal (placeholders — replace before launch)',
    docs: [
      ['TERMS_OF_SERVICE.md', 'Terms of Service'],
      ['PRIVACY_POLICY.md',   'Privacy Policy'],
    ],
  },
];

/**
 * Shared CSS — kept inline so the output works opened from disk
 * or hosted behind any static file server, no separate request
 * to load. Light/dark via prefers-color-scheme so the marketing
 * site doesn't need to fight the user agent.
 */
const SHARED_CSS = /* css */ `
:root {
  --bg: #ffffff;
  --surface: #f6f7fb;
  --text: #1a1f2e;
  --muted: #5f6678;
  --border: #e4e7ee;
  --accent: #4f46e5;
  --code-bg: #f1f5f9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --text: #e8ecf3;
    --muted: #9aa3b8;
    --border: #2a3038;
    --accent: #818cf8;
    --code-bg: #21262d;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
               system-ui, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.6;
}
.wrap { max-width: 880px; margin: 0 auto; padding: 32px 24px 96px; }
header.page {
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
  margin-bottom: 32px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 12px;
}
header.page .brand {
  font-weight: 700;
  font-size: 18px;
  color: var(--text);
  text-decoration: none;
}
header.page .brand span { color: var(--accent); }
header.page nav a {
  color: var(--muted);
  text-decoration: none;
  margin-left: 16px;
}
header.page nav a:hover { color: var(--accent); }
h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  margin-top: 1.6em;
  margin-bottom: 0.6em;
}
h1 { font-size: 2em; margin-top: 0; }
h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 1.2em; }
h4 { font-size: 1.05em; }
p, ul, ol, table, pre, blockquote { margin: 0 0 1em; }
ul, ol { padding-left: 1.5em; }
li { margin: 0.25em 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  background: var(--code-bg);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.92em;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
pre {
  background: var(--code-bg);
  padding: 14px 18px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 0.92em;
}
pre code { background: transparent; padding: 0; }
blockquote {
  border-left: 3px solid var(--accent);
  padding: 4px 14px;
  color: var(--muted);
  background: var(--surface);
  border-radius: 0 4px 4px 0;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th, td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
th { background: var(--surface); font-weight: 600; }
tr:nth-child(even) td { background: var(--surface); }
hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
footer.page {
  margin-top: 64px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.88em;
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.heading-anchor {
  visibility: hidden;
  margin-left: 8px;
  font-size: 0.7em;
  text-decoration: none;
  color: var(--muted);
}
h1:hover .heading-anchor,
h2:hover .heading-anchor,
h3:hover .heading-anchor,
h4:hover .heading-anchor { visibility: visible; }
.toc { background: var(--surface); padding: 16px 24px; border-radius: 8px; }
.toc h2 { border: 0; margin: 0 0 12px; font-size: 1.1em; }
.toc ul { columns: 2; column-gap: 24px; }
@media (max-width: 600px) {
  .toc ul { columns: 1; }
  .wrap { padding: 16px 12px 64px; }
}
.category {
  margin: 32px 0;
}
.category h2 { margin-bottom: 8px; }
.category ul { padding-left: 1.4em; }
.muted { color: var(--muted); }
.small { font-size: 0.88em; }
`;

/**
 * Slugify a heading text into an id we can anchor-link to.
 * Mirrors GitHub's reasonably enough.
 */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Custom renderer: every heading gets an id + a hover-revealed
 * anchor link. Internal .md links get rewritten to their .html
 * counterparts so navigation across the bundle works.
 */
function buildRenderer() {
  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = renderer.parser.parseInline(tokens);
    const id = slug(text.replace(/<[^>]+>/g, ''));
    return `<h${depth} id="${id}">${text}<a class="heading-anchor" href="#${id}">#</a></h${depth}>\n`;
  };
  renderer.link = ({ href, title, tokens }) => {
    const text = renderer.parser.parseInline(tokens);
    let h = href;
    // .md → .html, preserve fragment + query.
    if (h && !/^[a-z]+:/i.test(h)) {
      h = h.replace(/\.md(?=[)?#]|$)/i, '.html');
      // Strip "./docs/" / "docs/" prefixes — the HTML output is
      // already at docs/html/.
      h = h.replace(/^\.\/docs\//, './');
      h = h.replace(/^docs\//, './');
      // README at the repo root → README.html.
      h = h.replace(/^\.\.\/README\.html$/, 'README.html');
      h = h.replace(/^\.\.\/CHANGELOG\.html$/, 'CHANGELOG.html');
    }
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${h}"${titleAttr}>${text}</a>`;
  };
  return renderer;
}

function htmlShell({ title, body, isIndex = false }) {
  const home = isIndex ? '#' : 'index.html';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · SmrtCash docs</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="page">
  <a class="brand" href="${home}">Smrt<span>Cash</span> docs</a>
  <nav>
    ${isIndex ? '' : '<a href="index.html">All docs</a>'}
    <a href="https://support.builditsmrt.com/" target="_blank" rel="noreferrer">Support</a>
  </nav>
</header>
<main>
${body}
</main>
<footer class="page">
  <span>Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC${gitRefLabel()}</span>
  <span>Source: <a href="https://github.com/dajmlj812/SmrtCa-h">github.com/dajmlj812/SmrtCa-h</a></span>
</footer>
</div>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gitRefLabel() {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return ` · commit ${sha}`;
  } catch {
    return '';
  }
}

async function renderMarkdownFile(absPath, titleOverride) {
  const md = await readFile(absPath, 'utf8');
  const renderer = buildRenderer();
  const body = await marked.parse(md, { renderer, async: true, gfm: true });
  // First H1 in the body becomes the page title if no override.
  const m = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = titleOverride ?? (m ? m[1].replace(/<[^>]+>/g, '').trim() : 'SmrtCash');
  return htmlShell({ title, body });
}

function buildIndexBody() {
  const used = new Set();
  let html = `
<h1>SmrtCash documentation</h1>
<p class="muted">Static HTML mirror of every doc in the repository.
Regenerate with <code>npm run docs:html</code> after editing any
<code>.md</code> source. Linked from the live app's
"Help &amp; feature requests" footer.</p>
`;
  for (const cat of CATEGORIES) {
    html += `<section class="category">
<h2>${escapeHtml(cat.title)}</h2>
<ul>
${cat.docs
  .map(([file, label]) => {
    used.add(file);
    return `<li><a href="${slug(file.replace(/\.md$/i, ''))}.html">${escapeHtml(label)}</a></li>`;
  })
  .join('\n')}
</ul>
</section>`;
  }
  return { html, used };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // Catalog every .md in docs/ + the two root .mds. Skip
  // docs/README.md — it's an outdated in-repo pointer page that
  // the auto-generated index.html replaces in the HTML output.
  const rootMds = ['README.md', 'CHANGELOG.md'];
  const docsMds = (await readdir(DOCS_DIR))
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .filter((f) => f.toLowerCase() !== 'readme.md');
  const all = [
    ...rootMds.map((f) => ({ src: join(ROOT, f), out: slug(f.replace(/\.md$/i, '')) + '.html' })),
    ...docsMds.map((f) => ({ src: join(DOCS_DIR, f), out: slug(f.replace(/\.md$/i, '')) + '.html' })),
  ];

  // Generate every doc.
  for (const { src, out } of all) {
    const html = await renderMarkdownFile(src);
    await writeFile(join(OUT_DIR, out), html);
    console.log(`  ${basename(src)} → docs/html/${out}`);
  }

  // Build the index. Warn about any .md not covered by CATEGORIES
  // so future docs don't silently fall off the index.
  const { html: indexBody, used } = buildIndexBody();
  const orphans = all
    .map(({ src }) => basename(src))
    .filter((f) => !used.has(f) && f !== 'README.md');
  let bodyWithOrphans = indexBody;
  if (orphans.length > 0) {
    bodyWithOrphans +=
      `<section class="category"><h2>Other</h2><ul>` +
      orphans
        .map(
          (f) =>
            `<li><a href="${slug(f.replace(/\.md$/i, ''))}.html">${escapeHtml(f)}</a></li>`,
        )
        .join('\n') +
      `</ul></section>`;
  }
  await writeFile(
    join(OUT_DIR, 'index.html'),
    htmlShell({ title: 'Documentation', body: bodyWithOrphans, isIndex: true }),
  );
  console.log(`  index → docs/html/index.html (${all.length} pages)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
