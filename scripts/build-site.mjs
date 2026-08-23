// Static site generator for aips.antseed.com, EIP-site style:
// a prose homepage, per-category listing pages with status sections and
// bordered tables, and one document page per AIP with status/track chips.
// Output: _site/ (deployed by Cloudflare Workers on merges to main).

import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');
const REPO = 'https://github.com/AntSeed/AIPs';

const STATUS_ORDER = ['Living', 'Final', 'Last Call', 'Review', 'Draft', 'Stagnant', 'Withdrawn'];
const CATEGORIES = [
  { slug: 'all', label: 'All', match: () => true },
  { slug: 'core', label: 'Core', match: (f) => f.category === 'Core' },
  { slug: 'contracts', label: 'Contracts', match: (f) => f.category === 'Contracts' },
  { slug: 'interface', label: 'Interface', match: (f) => f.category === 'Interface' },
  { slug: 'economics', label: 'Economics', match: (f) => f.category === 'Economics' },
  { slug: 'asrc', label: 'ASRC', match: (f) => f.category === 'ASRC' },
  { slug: 'meta', label: 'Meta', match: (f) => f.type === 'Meta' },
  { slug: 'informational', label: 'Informational', match: (f) => f.type === 'Informational' },
];

const md = new MarkdownIt({ html: true, linkify: true, typographer: true }).use(anchor, {
  permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'after', class: 'h-anchor' }),
});

// Rewrite intra-repo markdown links to site routes.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href');
  if (href) {
    const aip = href.match(/^(?:\.\/|\.\.\/AIPS\/|AIPS\/)?aip-(\d+)(?:\.md)?(#.*)?$/);
    if (aip) tokens[idx].attrSet('href', `/aip-${aip[1]}${aip[2] ?? ''}`);
    else if (/^(\.\.\/)?LICENSE$/.test(href)) tokens[idx].attrSet('href', `${REPO}/blob/main/LICENSE`);
    else if (/^(\.\/|\.\.\/)?aip-template\.md$/.test(href)) tokens[idx].attrSet('href', `${REPO}/blob/main/aip-template.md`);
    else if (/^(\.\.\/)?CONTRIBUTING\.md$/.test(href)) tokens[idx].attrSet('href', `${REPO}/blob/main/CONTRIBUTING.md`);
    else if (href.startsWith('../assets/') || href.startsWith('assets/'))
      tokens[idx].attrSet('href', `/${href.replace(/^\.\.\//, '')}`);
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parse(file) {
  const raw = readFileSync(join(root, 'AIPS', file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  return { front: yaml.load(m[1]), body: m[2], file };
}

// Render "FirstName LastName (@user)" with the handle linked.
const renderAuthors = (author) =>
  esc(author).replace(/\(@([A-Za-z0-9-]+)\)/g, '(<a href="https://github.com/$1">@$1</a>)');

const statusSlug = (s) => s.toLowerCase().replace(/\s+/g, '-');
const trackLabel = (f) => (f.category ? `${f.type}: ${f.category}` : f.type);

function tocFor(body) {
  const items = [];
  for (const t of md.parse(body, {})) {
    if (t.type === 'heading_open' && t.tag === 'h2') items.push({ open: true });
    else if (t.type === 'inline' && items.length && items[items.length - 1].open) {
      const it = items[items.length - 1];
      it.text = t.content;
      it.id = t.content.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
      it.open = false;
    }
  }
  return items.filter((i) => i.text);
}

const css = readFileSync(join(root, 'site', 'style.css'), 'utf8');

const nav = (active) =>
  CATEGORIES.map(({ slug, label }) => {
    const href = slug === 'all' ? '/all' : `/${slug}`;
    return `<a href="${href}"${slug === active ? ' class="active"' : ''}>${label}</a>`;
  }).join('\n      ');

const page = ({ title, description, canonicalPath, content, active = '' }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://aips.antseed.com${canonicalPath}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://api.fontshare.com">
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@500,600,700&display=swap" rel="stylesheet">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<header class="masthead">
  <a class="wordmark" href="/">AntSeed Improvement Proposals</a>
  <nav class="cat-nav">
      ${nav(active)}
  </nav>
</header>
<div class="shell">
${content}
</div>
<footer class="colophon">
  <div class="shell colophon-row">
    <span>Content: <a href="${REPO}/blob/main/LICENSE">CC0</a> — generated from <a href="${REPO}">AntSeed/AIPs</a></span>
    <a href="https://antseed.com">antseed.com</a>
  </div>
</footer>
</body>
</html>`;

// ── collect ──────────────────────────────────────────────────────────
const aips = readdirSync(join(root, 'AIPS'))
  .filter((f) => /^aip-\d+\.md$/.test(f))
  .map(parse)
  .sort((a, b) => a.front.aip - b.front.aip);

mkdirSync(out, { recursive: true });
if (existsSync(join(root, 'assets'))) cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'site', 'favicon.svg'), join(out, 'favicon.svg'));

// ── per-AIP pages ────────────────────────────────────────────────────
for (const { front, body, file } of aips) {
  const n = front.aip;
  const metaRows = [
    ['Authors', renderAuthors(front.author)],
    front['discussions-to'] && ['Discussion', `<a href="${esc(front['discussions-to'])}">${esc(front['discussions-to'])}</a>`],
    ['Created', esc(front.created)],
    front['last-call-deadline'] && ['Last call deadline', esc(front['last-call-deadline'])],
    front.requires && [
      'Requires',
      String(front.requires).split(/,\s*/).map((r) => `<a href="/aip-${r.trim()}">AIP-${r.trim()}</a>`).join(', '),
    ],
  ]
    .filter(Boolean)
    .map(([label, v]) => `<tr><th>${label}</th><td>${v}</td></tr>`)
    .join('\n');

  const toc = tocFor(body);
  const tocHtml = toc.length
    ? `<h2 class="toc-title">Table of Contents</h2>
<ul class="toc">${toc.map((i) => `<li><a href="#${esc(i.id)}">${esc(i.text)}</a></li>`).join('\n')}</ul>`
    : '';

  const content = `
<article class="doc">
  <div class="chips">
    <span class="chip chip-status status-${statusSlug(front.status)}">${esc(front.status)}</span>
    <span class="chip chip-track">${esc(trackLabel(front))}</span>
  </div>
  <h1 class="doc-title">AIP-${n}: ${esc(front.title)}</h1>
  <p class="doc-desc">${esc(front.description)}</p>
  <table class="meta-table"><tbody>${metaRows}</tbody></table>
  ${tocHtml}
  <div class="prose">${md.render(body)}</div>
  <p class="doc-source"><a href="${REPO}/blob/main/AIPS/${file}">View source on GitHub</a></p>
</article>`;

  mkdirSync(join(out, `aip-${n}`), { recursive: true });
  writeFileSync(
    join(out, `aip-${n}`, 'index.html'),
    page({
      title: `AIP-${n}: ${front.title} — AntSeed Improvement Proposals`,
      description: front.description,
      canonicalPath: `/aip-${n}`,
      content,
      active: front.category ? front.category.toLowerCase() : front.type.toLowerCase(),
    })
  );
}

// ── category listing pages ───────────────────────────────────────────
const listTable = (items) => `<table class="aip-table">
  <thead><tr><th class="col-num">Number</th><th>Title</th><th class="col-auth">Author</th></tr></thead>
  <tbody>
  ${items
    .map(
      ({ front }) => `<tr>
    <td class="col-num"><a href="/aip-${front.aip}">${front.aip}</a></td>
    <td><a class="row-title" href="/aip-${front.aip}">${esc(front.title)}</a></td>
    <td class="col-auth">${renderAuthors(front.author)}</td>
  </tr>`
    )
    .join('\n')}
  </tbody>
</table>`;

for (const { slug, label, match } of CATEGORIES) {
  const items = aips.filter((a) => match(a.front));
  const sections = STATUS_ORDER.map((status) => ({
    status,
    rows: items.filter((a) => a.front.status === status),
  })).filter((s) => s.rows.length);

  const content = `
<h1 class="page-title">${esc(label)}</h1>
${
  sections.length
    ? sections.map(({ status, rows }) => `<h2 class="status-title">${esc(status)}</h2>\n${listTable(rows)}`).join('\n')
    : '<p class="empty">No proposals in this category yet.</p>'
}`;

  mkdirSync(join(out, slug), { recursive: true });
  writeFileSync(
    join(out, slug, 'index.html'),
    page({
      title: `${label} — AntSeed Improvement Proposals`,
      description: `AntSeed Improvement Proposals: ${label}.`,
      canonicalPath: `/${slug}`,
      content,
      active: slug,
    })
  );
}

// ── homepage ─────────────────────────────────────────────────────────
const homeContent = `
<h1 class="page-title">AIPs</h1>
<div class="prose home-prose">
<p>AntSeed Improvement Proposals (AIPs) describe standards for the AntSeed
peer-to-peer AI services network, including core protocol specifications,
contract standards, interfaces, and economics. Browse them by category above,
or see <a href="/all">all proposals</a>.</p>

<h2>Contributing</h2>
<p>First review <a href="/aip-1">AIP-1</a>. Then clone the
<a href="${REPO}">repository</a> and add your AIP to it. There is a
<a href="${REPO}/blob/main/aip-template.md">template AIP here</a>. Then submit
a pull request to the AIPs repository.</p>

<h2>AIP status terms</h2>
<ul>
<li><strong>Idea</strong> — An idea that is pre-draft. Not tracked within the AIP repository.</li>
<li><strong>Draft</strong> — The first formally tracked stage of an AIP in development. Merged by an AIP editor when properly formatted.</li>
<li><strong>Review</strong> — The AIP author marks the AIP as ready for and requesting peer review.</li>
<li><strong>Last Call</strong> — The final review window before Final. An editor assigns it and sets a <code>last-call-deadline</code>, at least 14 days later.</li>
<li><strong>Final</strong> — The AIP represents the final standard, updated only for errata and non-normative clarifications.</li>
<li><strong>Stagnant</strong> — Inactive in Draft, Review, or Last Call for 6+ months.</li>
<li><strong>Withdrawn</strong> — Withdrawn by the author(s); the number is never reused.</li>
<li><strong>Living</strong> — Continually updated and never reaching finality, such as AIP-1.</li>
</ul>

<h2>AIP types</h2>
<ul>
<li><strong>Standards Track</strong> — Changes affecting AntSeed implementations or interoperability: <em>Core</em> (wire protocol, discovery, payments flow), <em>Contracts</em> (on-chain contracts), <em>Interface</em> (APIs, configuration, tooling), <em>Economics</em> (emissions, staking, rewards), and <em>ASRC</em> (application-level standards).</li>
<li><strong>Meta</strong> — Processes surrounding AntSeed, such as AIP-1 itself.</li>
<li><strong>Informational</strong> — Design guidelines and general information.</li>
</ul>
</div>`;

writeFileSync(
  join(out, 'index.html'),
  page({
    title: 'AntSeed Improvement Proposals',
    description: 'Design documents and standards for the AntSeed peer-to-peer AI services network.',
    canonicalPath: '/',
    content: homeContent,
  })
);

writeFileSync(
  join(out, 'index.json'),
  JSON.stringify(
    aips.map(({ front }) => ({ ...front, url: `https://aips.antseed.com/aip-${front.aip}` })),
    null,
    2
  )
);

writeFileSync(
  join(out, '404.html'),
  page({
    title: 'Not found — AntSeed Improvement Proposals',
    description: 'No such proposal.',
    canonicalPath: '/404',
    content: `<h1 class="page-title">Not found</h1>
<div class="prose"><p>No proposal lives at this address. Browse <a href="/all">all proposals</a>.</p></div>`,
  })
);

console.log(`built ${aips.length} AIP page(s), ${CATEGORIES.length} listing page(s), home → _site/`);
