// Keeps chivearcade.com URLs identical to the old GitHub Pages site and keeps
// non-production hosts (pages.dev, branch previews) out of search results.
const PROD = "chivearcade.com";

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);

  // Single 301: www -> bare domain (same direction as before).
  if (url.hostname === "www." + PROD) {
    url.hostname = PROD;
    return Response.redirect(url.toString(), 301);
  }

  let res;
  if (url.pathname === "/CNAME") {
    res = await ctx.env.ASSETS.fetch(new Request(new URL("/404.html", url)));
    res = new Response(res.body, { status: 404, headers: res.headers });
  } else if (url.pathname.endsWith(".html") && url.pathname !== "/404.html") {
    // GitHub Pages served /privacy.html and /teachers/index.html with 200.
    // Pages would 308 them to the pretty URL; serve the same file in place instead.
    const pretty = url.pathname.replace(/index\.html$/, "").replace(/\.html$/, "");
    const r = await ctx.env.ASSETS.fetch(new Request(new URL(pretty + url.search, url), ctx.request));
    res = r.status === 200 ? r : await ctx.next();
  } else {
    res = await ctx.next();
  }

  if (url.hostname !== PROD) {
    res = new Response(res.body, res);
    res.headers.set("X-Robots-Tag", "noindex");
  }
  return res;
}
