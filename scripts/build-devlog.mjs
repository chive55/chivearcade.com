#!/usr/bin/env node
/**
 * Tiny Devlog generator. Reads Markdown posts from devlog-src/posts/,
 * writes static HTML under /devlog/, plus feed.xml and updates sitemap.xml.
 *
 * Usage: node scripts/build-devlog.mjs
 * No dependencies. Commit both source and generated output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'devlog-src', 'posts');
const OUT = path.join(ROOT, 'devlog');
const SITE = 'https://chivearcade.com';
const PLACEHOLDER = {
  src: '/devlog/assets/placeholder.svg',
  width: 1200,
  height: 675,
  alt: 'Chive Arcade Devlog',
};

const NAV = `<nav class="site-nav" id="site-nav" aria-label="Main"><ul><li><a href="/#vroom-boom">Vroom Boom</a></li><!-- <li><a href="/games/">Browser Games</a></li> --><li><a href="/devlog/" aria-current="page">Devlog</a></li><li><a href="/about/">About</a></li><li><a class="nav-steam" href="https://store.steampowered.com/app/5446380/?utm_source=chivearcade&amp;utm_medium=site&amp;utm_campaign=vroomboom" target="_blank" rel="noopener">Wishlist on Steam</a></li></ul><ul class="site-social" aria-label="Chive Arcade on social media"><li><a href="https://x.com/ChiveArcade" target="_blank" rel="noopener">X</a></li><li><a href="https://www.tiktok.com/@chive.arcade" target="_blank" rel="noopener">TikTok</a></li><li><a href="https://www.youtube.com/@ChiveArcade" target="_blank" rel="noopener">YouTube</a></li><li><a href="https://www.instagram.com/chivearcade" target="_blank" rel="noopener">Instagram</a></li><li><a href="https://bsky.app/profile/chivearcade.com" target="_blank" rel="noopener">Bluesky</a></li></ul></nav>`;

const FOOT = `<footer class="site-foot">
    <nav aria-label="Footer"><ul><li><a href="/#vroom-boom">Vroom Boom</a></li><!-- <li><a href="/games/">Browser Games</a></li> --><li><a href="/devlog/">Devlog</a></li><li><a href="/about/">About</a></li><li><a href="mailto:chivearcade@gmail.com">Contact</a></li><li><a href="/privacy.html">Privacy</a></li></ul></nav>
    <p><a href="https://store.steampowered.com/app/5446380/?utm_source=chivearcade&amp;utm_medium=site&amp;utm_campaign=vroomboom" target="_blank" rel="noopener">Vroom Boom is coming to Steam: wishlist now</a></p>
    <p><a href="https://x.com/ChiveArcade">X</a> · <a href="https://www.tiktok.com/@chive.arcade">TikTok</a> · <a href="https://www.youtube.com/@ChiveArcade">YouTube</a> · <a href="https://www.instagram.com/chivearcade">Instagram</a> · <a href="https://bsky.app/profile/chivearcade.com">Bluesky</a> · <a href="https://chive-arcade.itch.io">itch.io</a> · <a href="https://github.com/chive55">GitHub</a></p>
    <p>© <span id="foot-year">2026</span> Chive Arcade</p>
  </footer>`;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) throw new Error('Post missing frontmatter');
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Post frontmatter not closed');
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n+/, '').replace(/\n+$/, '');
  const meta = { tags: [] };
  let listKey = null;
  for (const line of fm.split('\n')) {
    if (/^\s+-\s+/.test(line) && listKey) {
      meta[listKey].push(line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, ''));
      continue;
    }
    listKey = null;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === '') {
      meta[key] = [];
      listKey = key;
      continue;
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'coverWidth' || key === 'coverHeight') meta[key] = Number(val);
    else meta[key] = val;
  }
  if (!meta.title || !meta.date || !meta.slug) {
    throw new Error('Post needs title, date, slug');
  }
  return { meta, body };
}

function mdToHtml(md) {
  const lines = md.split(/\n/);
  const out = [];
  let para = [];
  let inList = false;
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    if (text) out.push('<p>' + inline(text) + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!inList) return;
    out.push('</ul>');
    inList = false;
  };
  for (const line of lines) {
    if (/^!\[[^\]]*\]\([^)]+\)/.test(line.trim())) {
      flushPara();
      flushList();
      const m = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)(?:\s*\{(\d+)x(\d+)\})?$/);
      if (m) {
        const alt = esc(m[1]);
        const src = esc(m[2]);
        const title = m[3] ? esc(m[3]) : alt;
        const w = m[4] || '';
        const h = m[5] || '';
        const wh = (w && h) ? ` width="${w}" height="${h}"` : '';
        out.push(`<figure class="dl-figure"><img src="${src}" alt="${alt}" title="${title}"${wh} loading="lazy" decoding="async"><figcaption>${alt}</figcaption></figure>`);
      }
      continue;
    }
    if (/^### /.test(line)) {
      flushPara(); flushList();
      out.push('<h3>' + inline(line.slice(4)) + '</h3>');
      continue;
    }
    if (/^## /.test(line)) {
      flushPara(); flushList();
      out.push('<h2>' + inline(line.slice(3)) + '</h2>');
      continue;
    }
    if (/^# /.test(line)) {
      flushPara(); flushList();
      out.push('<h2>' + inline(line.slice(2)) + '</h2>');
      continue;
    }
    if (/^- /.test(line)) {
      flushPara();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(line.slice(2)) + '</li>');
      continue;
    }
    if (line.trim() === '') {
      flushPara(); flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

function inline(text) {
  let s = esc(text);
  // links: [text](url) then bare https URLs
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  s = s.replace(/(^|[^">])(https?:\/\/[^\s<]+)/g, (all, pre, url) => {
    const clean = url.replace(/[.,);]+$/, '');
    const trail = url.slice(clean.length);
    return pre + '<a href="' + clean + '" rel="noopener">' + clean + '</a>' + trail;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[m - 1] + ' ' + d + ', ' + y;
}

function rfc822(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toUTCString();
}

function coverOf(post) {
  if (post.cover) {
    return {
      src: post.cover,
      width: post.coverWidth || 1200,
      height: post.coverHeight || 675,
      alt: post.coverAlt || post.title,
    };
  }
  return { ...PLACEHOLDER };
}

function headCommon({ title, description, url, image, imageW, imageH, imageAlt, type, jsonLd, extra }) {
  const absImg = image.startsWith('http') ? image : SITE + image;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<script>document.documentElement.classList.add('js');</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#080B18">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/site-nav.css">
<link rel="stylesheet" href="/devlog/devlog.css">
<link rel="canonical" href="${esc(url)}">
<link rel="alternate" type="application/rss+xml" title="Chive Arcade Devlog" href="${SITE}/devlog/feed.xml">
<meta property="og:type" content="${esc(type || 'website')}">
<meta property="og:site_name" content="Chive Arcade">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(absImg)}">
<meta property="og:image:width" content="${imageW}">
<meta property="og:image:height" content="${imageH}">
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(absImg)}">
<link rel="preload" href="/assets/fonts/russo-one-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/fonts.css">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ''}
${extra || ''}
</head>`;
}

function shell({ head, main }) {
  return `${head}
<body>
<div class="wrap">
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-head">
    <a class="brand" href="/"><img src="/mark-80.png" width="65" height="40" alt=""><span>CHIVE <em>ARCADE</em></span></a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
    ${NAV}
  </header>
<main id="main">
${main}
</main>
  ${FOOT}
</div>
<a class="sticky-wish" href="https://store.steampowered.com/app/5446380/?utm_source=chivearcade&amp;utm_medium=site&amp;utm_campaign=vroomboom" target="_blank" rel="noopener">&#9733; Wishlist on Steam</a>
<script src="/assets/site-nav.js" defer></script>
</body>
</html>
`;
}

function loadPosts() {
  if (!fs.existsSync(SRC)) return [];
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.md')).sort().reverse();
  const posts = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const html = mdToHtml(body);
    const excerpt = meta.excerpt || body.split(/\n\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 220);
    posts.push({ ...meta, body, html, excerpt, file });
  }
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return posts;
}

function writeIndex(posts) {
  const cards = posts.length
    ? posts.map((p) => {
        const c = coverOf(p);
        const tags = (p.tags || []).map((t) => `<span class="dl-tag">${esc(t)}</span>`).join('');
        return `<article class="dl-card">
  <a class="dl-card-link" href="/devlog/${esc(p.slug)}/">
    <div class="dl-card-media">
      <img src="${esc(c.src)}" alt="${esc(c.alt)}" width="${c.width}" height="${c.height}" loading="lazy" decoding="async">
    </div>
    <div class="dl-card-body">
      <h2 class="dl-card-title">${esc(p.title)}</h2>
      <p class="dl-card-meta"><time datetime="${esc(p.date)}">${esc(formatDate(p.date))}</time>${tags ? ' · ' + tags : ''}</p>
      <p class="dl-card-excerpt">${esc(p.excerpt)}</p>
      <span class="dl-card-more">Read post</span>
    </div>
  </a>
</article>`;
      }).join('\n')
    : `<p class="dl-empty">No posts yet. Check back soon.</p>`;

  const head = headCommon({
    title: 'Vroom Boom Devlog: Build Notes and Progress | Chive Arcade',
    description: 'Devlog for Vroom Boom and other Chive Arcade games, with build notes, tips and progress.',
    url: SITE + '/devlog/',
    image: posts[0] ? coverOf(posts[0]).src : PLACEHOLDER.src,
    imageW: posts[0] ? coverOf(posts[0]).width : PLACEHOLDER.width,
    imageH: posts[0] ? coverOf(posts[0]).height : PLACEHOLDER.height,
    imageAlt: posts[0] ? coverOf(posts[0]).alt : PLACEHOLDER.alt,
    type: 'website',
    jsonLd: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: 'Chive Arcade Devlog',
      url: SITE + '/devlog/',
      description: 'Devlog for Vroom Boom and other Chive Arcade games.',
      publisher: { '@type': 'Organization', name: 'Chive Arcade', url: SITE + '/' },
    }),
  });

  const main = `  <header class="dl-index-head">
    <h1 class="dl-title">Devlog</h1>
    <p class="dl-lead">Build notes for Vroom Boom and other Chive Arcade games. Newest first.</p>
  </header>
  <div class="dl-grid">
${cards}
  </div>`;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), shell({ head, main }));
}

function writePost(post, prev, next) {
  const c = coverOf(post);
  const url = SITE + '/devlog/' + post.slug + '/';
  const tags = (post.tags || [])
    .map((t) => `<li><span class="dl-tag">${esc(t)}</span></li>`)
    .join('');
  const navBits = [];
  if (prev) navBits.push(`<a class="dl-nav-prev" href="/devlog/${esc(prev.slug)}/"><span class="dl-nav-label">Previous</span><span class="dl-nav-title">${esc(prev.title)}</span></a>`);
  else navBits.push('<span class="dl-nav-prev dl-nav-empty"></span>');
  if (next) navBits.push(`<a class="dl-nav-next" href="/devlog/${esc(next.slug)}/"><span class="dl-nav-label">Next</span><span class="dl-nav-title">${esc(next.title)}</span></a>`);
  else navBits.push('<span class="dl-nav-next dl-nav-empty"></span>');

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    datePublished: post.date,
    dateModified: post.date,
    description: post.excerpt,
    image: [SITE + c.src],
    author: { '@type': 'Organization', name: 'Chive Arcade', url: SITE + '/' },
    publisher: { '@type': 'Organization', name: 'Chive Arcade', url: SITE + '/', logo: { '@type': 'ImageObject', url: SITE + '/mark.png' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    keywords: (post.tags || []).join(', '),
  });

  const head = headCommon({
    title: post.title + ' | Chive Arcade Devlog',
    description: post.excerpt,
    url,
    image: c.src,
    imageW: c.width,
    imageH: c.height,
    imageAlt: c.alt,
    type: 'article',
    jsonLd,
    extra: `<meta property="article:published_time" content="${esc(post.date)}">`,
  });

  const main = `  <article class="dl-post" itemscope itemtype="https://schema.org/BlogPosting">
    <header class="dl-post-head">
      <p class="dl-post-meta"><time datetime="${esc(post.date)}" itemprop="datePublished">${esc(formatDate(post.date))}</time></p>
      <h1 class="dl-post-title" itemprop="headline">${esc(post.title)}</h1>
      ${tags ? `<ul class="dl-tags" aria-label="Tags">${tags}</ul>` : ''}
    </header>
    <div class="dl-cover">
      <img src="${esc(c.src)}" alt="${esc(c.alt)}" width="${c.width}" height="${c.height}" itemprop="image" fetchpriority="high">
    </div>
    <div class="dl-prose" itemprop="articleBody">
${post.html}
    </div>
    <nav class="dl-post-nav" aria-label="Post">
      ${navBits.join('\n      ')}
    </nav>
    <p class="dl-back"><a href="/devlog/">All Devlog posts</a></p>
  </article>`;

  const dir = path.join(OUT, post.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), shell({ head, main }));
}

function writeFeed(posts) {
  const items = posts.map((p) => {
    const link = SITE + '/devlog/' + p.slug + '/';
    const desc = esc(p.excerpt);
    return `    <item>
      <title>${esc(p.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${desc}</description>
      ${(p.tags || []).map((t) => `<category>${esc(t)}</category>`).join('\n      ')}
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Chive Arcade Devlog</title>
    <link>${SITE}/devlog/</link>
    <description>Build notes for Vroom Boom and other Chive Arcade games.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  fs.writeFileSync(path.join(OUT, 'feed.xml'), xml);
}

function updateSitemap(posts) {
  const sitemapPath = path.join(ROOT, 'sitemap.xml');
  let xml = fs.readFileSync(sitemapPath, 'utf8');
  // strip prior /devlog entries then re-add
  xml = xml.replace(/\s*<url><loc>https:\/\/chivearcade\.com\/devlog\/[^<]*<\/loc>.*?<\/url>/gs, '');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const entries = [
    `  <url><loc>${SITE}/devlog/</loc><lastmod>${today}</lastmod></url>`,
    ...posts.map((p) => `  <url><loc>${SITE}/devlog/${p.slug}/</loc><lastmod>${p.date}</lastmod></url>`),
  ].join('\n');
  xml = xml.replace('</urlset>', entries + '\n</urlset>');
  fs.writeFileSync(sitemapPath, xml);
}

function main() {
  const posts = loadPosts();
  // clean generated post dirs (keep assets + css)
  if (fs.existsSync(OUT)) {
    for (const name of fs.readdirSync(OUT)) {
      if (name === 'assets' || name === 'devlog.css') continue;
      const p = path.join(OUT, name);
      fs.rmSync(p, { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
  }
  writeIndex(posts);
  posts.forEach((p, i) => {
    const newer = posts[i - 1] || null; // previous in reading order (newer)
    const older = posts[i + 1] || null;
    // prev = older chronologically for "previous post", next = newer
    writePost(p, older, newer);
  });
  writeFeed(posts);
  updateSitemap(posts);
  console.log('Built ' + posts.length + ' post(s) into /devlog/');
}

main();
