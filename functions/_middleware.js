// Keeps chivearcade.com URLs identical to the old GitHub Pages site and keeps
// non-production hosts (pages.dev, branch previews) out of search results.
const PROD = "chivearcade.com";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function applySecurity(res, url) {
  res = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  if (url.hostname !== PROD) {
    res.headers.set("X-Robots-Tag", "noindex");
  }
  return res;
}

function redirect(url, status, location) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Location", location);
  if (url.hostname !== PROD) headers.set("X-Robots-Tag", "noindex");
  return new Response(null, { status, headers });
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);

  // Single 301: www -> bare domain (same direction as before).
  if (url.hostname === "www." + PROD) {
    const dest = new URL(url.toString());
    dest.hostname = PROD;
    return redirect(url, 301, dest.toString());
  }

  // Soft-404 page must not be indexed as a real document.
  if (url.pathname === "/404" || url.pathname === "/404.html") {
    const r = await ctx.env.ASSETS.fetch(
      new Request(new URL("/404.html", url), ctx.request)
    );
    return applySecurity(
      new Response(r.body, { status: 404, headers: r.headers }),
      url
    );
  }

  // Canonicalize */index.html -> directory slash URL (or / for root).
  if (url.pathname === "/index.html" || url.pathname.endsWith("/index.html")) {
    const path =
      url.pathname === "/index.html"
        ? "/"
        : url.pathname.replace(/index\.html$/, "");
    return redirect(url, 301, new URL(path + url.search, url).toString());
  }

  let res;
  if (url.pathname === "/CNAME") {
    res = await ctx.env.ASSETS.fetch(new Request(new URL("/404.html", url)));
    res = new Response(res.body, { status: 404, headers: res.headers });
  } else if (url.pathname === "/privacy.html") {
    // GitHub Pages served /privacy.html with 200; keep that path in place.
    const r = await ctx.env.ASSETS.fetch(
      new Request(new URL("/privacy.html", url), ctx.request)
    );
    res = r.status === 200 ? r : await ctx.next();
  } else {
    res = await ctx.next();
    // GitHub Pages used 301 for /teachers -> /teachers/; match it.
    if (res.status === 308) {
      const loc = res.headers.get("Location");
      if (loc) return redirect(url, 301, new URL(loc, url).toString());
    }
  }

  return applySecurity(res, url);
}
