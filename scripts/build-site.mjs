// Static site generator for aips.antseed.com.
// Reads AIPS/*.md, renders one page per AIP plus an index grouped by status.
// Output: _site/ (deployed by Cloudflare Pages on merges to main).

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
const STATUS_BLURB = {
  Living: 'Continually updated; never reaches finality.',
  Final: 'The accepted standard.',
  'Last Call': 'Final review window before Final.',
  Review: 'Author has requested peer review.',
  Draft: 'Well-formed and formally tracked; content still changing.',
  Stagnant: 'Inactive for six months or more.',
  Withdrawn: 'Withdrawn by the author.',
};

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

const statusClass = (s) => `status-${s.toLowerCase().replace(/\s+/g, '-')}`;

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

const page = ({ title, description, canonicalPath, content, extraClass = '' }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://aips.antseed.com${canonicalPath}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#001E12"/><circle cx="16" cy="16" r="6.5" fill="#24CD95"/></svg>'
)}">
<link rel="preconnect" href="https://api.fontshare.com">
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@500,600,700&display=swap" rel="stylesheet">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body class="${extraClass}">
<header class="masthead">
  <div class="shell masthead-row">
    <a class="wordmark" href="/"><span class="seed"></span>AntSeed <em>Improvement Proposals</em></a>
    <nav class="mast-nav">
      <a href="/#proposals">Proposals</a>
      <a href="/aip-1">Process</a>
      <a href="${REPO}">GitHub</a>
    </nav>
  </div>
</header>
${content}
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

// ── per-AIP pages ────────────────────────────────────────────────────
const PREAMBLE_ROWS = [
  ['description', 'Description'],
  ['author', 'Author'],
  ['discussions-to', 'Discussion'],
  ['status', 'Status'],
  ['type', 'Type'],
  ['category', 'Category'],
  ['created', 'Created'],
  ['requires', 'Requires'],
];

for (const { front, body, file } of aips) {
  const n = front.aip;
  const rows = PREAMBLE_ROWS.filter(([k]) => front[k] != null)
    .map(([k, label]) => {
      let v;
      if (k === 'author') v = renderAuthors(front.author);
      else if (k === 'discussions-to') v = `<a href="${esc(front[k])}">${esc(front[k])}</a>`;
      else if (k === 'status') v = `<span class="pill ${statusClass(front.status)}">${esc(front.status)}</span>`;
      else if (k === 'requires')
        v = String(front.requires)
          .split(/,\s*/)
          .map((r) => `<a href="/aip-${r.trim()}">AIP-${r.trim()}</a>`)
          .join(', ');
      else if (k === 'created') v = `<time>${esc(front.created)}</time>`;
      else v = esc(front[k]);
      return `<div class="pre-row"><dt>${label}</dt><dd>${v}</dd></div>`;
    })
    .join('\n');

  const toc = tocFor(body);
  const tocHtml = toc.length
    ? `<nav class="toc"><h2>Contents</h2><ol>${toc
        .map((i) => `<li><a href="#${esc(i.id)}">${esc(i.text)}</a></li>`)
        .join('')}</ol></nav>`
    : '';

  const content = `
<main class="shell doc-shell">
  <article class="doc">
    <div class="doc-kicker"><a href="/">Proposals</a> / <span class="mono">AIP-${n}</span></div>
    <span class="ghost-numeral" aria-hidden="true">${n}</span>
    <h1 class="doc-title">${esc(front.title)}</h1>
    <dl class="preamble">${rows}</dl>
    <div class="prose">${md.render(body)}</div>
    <p class="doc-source"><a href="${REPO}/blob/main/AIPS/${file}">View source on GitHub</a></p>
  </article>
  ${tocHtml}
</main>`;

  mkdirSync(join(out, `aip-${n}`), { recursive: true });
  writeFileSync(
    join(out, `aip-${n}`, 'index.html'),
    page({
      title: `AIP-${n}: ${front.title} — AntSeed Improvement Proposals`,
      description: front.description,
      canonicalPath: `/aip-${n}`,
      content,
      extraClass: 'is-doc',
    })
  );
}

// ── index ────────────────────────────────────────────────────────────
const groups = STATUS_ORDER.map((status) => ({
  status,
  items: aips.filter((a) => a.front.status === status),
})).filter((g) => g.items.length);

const tables = groups
  .map(
    ({ status, items }) => `
<section class="status-group">
  <header class="group-head">
    <h2><span class="pill ${statusClass(status)}">${esc(status)}</span></h2>
    <p>${esc(STATUS_BLURB[status] ?? '')}</p>
  </header>
  <table class="aip-table">
    <thead><tr><th class="col-num">Number</th><th>Title</th><th class="col-type">Type</th><th class="col-auth">Author</th></tr></thead>
    <tbody>
    ${items
      .map(({ front }) => {
        const type = front.category ? `${front.type} · ${front.category}` : front.type;
        return `<tr>
        <td class="col-num"><a class="mono" href="/aip-${front.aip}">${front.aip}</a></td>
        <td><a class="row-title" href="/aip-${front.aip}">${esc(front.title)}</a><span class="row-desc">${esc(front.description)}</span></td>
        <td class="col-type mono">${esc(type)}</td>
        <td class="col-auth">${renderAuthors(front.author)}</td>
      </tr>`;
      })
      .join('\n')}
    </tbody>
  </table>
</section>`
  )
  .join('\n');

const indexContent = `
<section class="hero">
  <div class="shell">
    <h1>AntSeed<br>Improvement<br>Proposals</h1>
    <p class="hero-sub">Design documents for the AntSeed peer-to-peer AI services network —
    protocol standards, contract specifications, and process. Anyone may author one:
    start from <a href="/aip-1">AIP-1</a> and open a pull request against
    <a href="${REPO}">AntSeed/AIPs</a>.</p>
    <div class="hero-meta mono">${aips.length} proposal${aips.length === 1 ? '' : 's'} · ${groups
  .map((g) => `${g.items.length} ${g.status.toLowerCase()}`)
  .join(' · ')}</div>
  </div>
</section>
<main class="shell" id="proposals">
${tables}
</main>`;

writeFileSync(
  join(out, 'index.html'),
  page({
    title: 'AntSeed Improvement Proposals',
    description: 'Design documents for the AntSeed peer-to-peer AI services network.',
    canonicalPath: '/',
    content: indexContent,
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

// Cloudflare Pages: clean-URL 404 fallback.
writeFileSync(
  join(out, '404.html'),
  page({
    title: 'Not found — AntSeed Improvement Proposals',
    description: 'No such proposal.',
    canonicalPath: '/404',
    content: `<main class="shell doc-shell"><article class="doc"><h1 class="doc-title">Not found</h1>
<div class="prose"><p>No proposal lives at this address. Browse the <a href="/">index</a>.</p></div></article></main>`,
  })
);

console.log(`built ${aips.length} AIP page(s) + index → _site/`);
