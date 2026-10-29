/**
 * POST /api/subscribe
 * Newsletter signup: honeypot, Turnstile, rate limit, then Kit public form POST.
 * No database. Emails are never logged. No Kit API key required.
 *
 * Kit public form (from embed https://chive-arcade.kit.com/fd74872931/index.js
 * and runtime https://f.convertkit.com/ckjs/ck.1.js):
 *   POST https://app.kit.com/forms/{KIT_FORM_ID}/subscriptions
 *   Body: FormData with email_address (+ referrer, user)
 *   Header: Accept: application/json  (do NOT force Content-Type; FormData sets multipart)
 *   Success ONLY when response JSON has status === "success".
 *   HTTP 200 with status "quarantined" / errors is NOT success.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const DEFAULT_KIT_FORM_ID = "10114495";

/**
 * Cloudflare Turnstile always-pass TEST secret.
 * Docs: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 * ONLY used as a fallback when TURNSTILE_SECRET_KEY is unset AND the request
 * host ends with ".pages.dev" (preview). Never on production hosts.
 */
const TURNSTILE_TEST_SECRET_ALWAYS_PASS =
  "1x0000000000000000000000000000000AA";

/** Best-effort in-memory map (per isolate). Cache API used when available. */
const memHits = new Map();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function requestHost(request) {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Resolve Turnstile secret: prefer env.TURNSTILE_SECRET_KEY.
 * Preview-only fallback: Cloudflare always-pass test secret on *.pages.dev.
 */
function resolveTurnstileSecret(env, host) {
  if (env.TURNSTILE_SECRET_KEY) return env.TURNSTILE_SECRET_KEY;
  if (host.endsWith(".pages.dev")) {
    // PREVIEW ONLY — Cloudflare Turnstile always-pass TEST secret.
    // Do not use on production. Replace by setting TURNSTILE_SECRET_KEY.
    return TURNSTILE_TEST_SECRET_ALWAYS_PASS;
  }
  return null;
}

async function parseBody(request) {
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const data = await request.json().catch(() => null);
    return data && typeof data === "object" ? data : {};
  }
  if (
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  ) {
    const fd = await request.formData();
    const out = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  const text = await request.text();
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch {
    const params = new URLSearchParams(text);
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
}

async function rateLimited(ip) {
  const now = Date.now();
  try {
    const cache = caches.default;
    const key = new Request(
      "https://rate-limit.internal/subscribe/" + encodeURIComponent(ip),
      { method: "GET" }
    );
    const hit = await cache.match(key);
    let stamps = [];
    if (hit) {
      const data = await hit.json().catch(() => null);
      if (data && Array.isArray(data.t)) stamps = data.t;
    }
    stamps = stamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (stamps.length >= RATE_MAX) return true;
    stamps.push(now);
    const res = new Response(JSON.stringify({ t: stamps }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "max-age=60",
      },
    });
    await cache.put(key, res);
    return false;
  } catch {
    let stamps = memHits.get(ip) || [];
    stamps = stamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (stamps.length >= RATE_MAX) {
      memHits.set(ip, stamps);
      return true;
    }
    stamps.push(now);
    memHits.set(ip, stamps);
    return false;
  }
}

async function verifyTurnstile(token, secret, ip) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );
  const data = await res.json().catch(() => ({ success: false }));
  return !!(data && data.success);
}

/**
 * Kit public form subscribe (no API key), matching CKJS:
 * FormData + Accept: application/json. Only status==="success" counts.
 * Never logs response bodies (may include email).
 */
async function subscribeViaKitPublicForm(email, formId, referrer, request) {
  const url =
    "https://app.kit.com/forms/" + encodeURIComponent(formId) + "/subscriptions";

  const fd = new FormData();
  fd.append("email_address", email);
  if (referrer) fd.append("referrer", referrer);
  // CKJS sends a visitor id from localStorage; a random id is better than omitting.
  fd.append("user", crypto.randomUUID());

  const headers = {
    Accept: "application/json",
  };
  // Forward browser Origin/Referer when present (helps Kit; never log them with email)
  const origin = request.headers.get("Origin");
  const reqReferer = request.headers.get("Referer");
  if (origin) headers.Origin = origin;
  if (reqReferer) headers.Referer = reqReferer;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: fd,
    redirect: "manual",
  });

  const httpStatus = res.status;

  // Redirects without a JSON body are not acceptance.
  if (httpStatus >= 300 && httpStatus < 400) {
    return {
      ok: false,
      httpStatus,
      kitStatus: "redirect",
      error: "provider_error",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      httpStatus,
      kitStatus: "http_" + httpStatus,
      error: "provider_error",
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return {
      ok: false,
      httpStatus,
      kitStatus: "non_json",
      error: "provider_error",
    };
  }

  const kitStatus =
    data && typeof data.status === "string" ? data.status : "unknown";

  // CKJS: success | quarantined | else errors
  if (kitStatus === "success") {
    return { ok: true, httpStatus, kitStatus };
  }

  return {
    ok: false,
    httpStatus,
    kitStatus,
    error: "provider_error",
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await parseBody(request);
  } catch {
    return json(400, { ok: false, error: "bad_request" });
  }

  // Honeypot: reject silently with fake success (do not reveal, do not call Kit)
  const honey = body.website || body.company || body._gotcha || "";
  if (typeof honey === "string" && honey.trim() !== "") {
    return json(200, { ok: true });
  }

  const emailRaw = (body.email || body.email_address || "").toString().trim();
  const email = emailRaw.toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return json(400, { ok: false, error: "invalid_email" });
  }

  const ip = clientIp(request);
  if (await rateLimited(ip)) {
    return json(429, { ok: false, error: "rate_limited" });
  }

  const host = requestHost(request);
  const turnstileSecret = resolveTurnstileSecret(env, host);
  if (!turnstileSecret) {
    return json(503, { ok: false, error: "turnstile_not_configured" });
  }

  const token = (
    body["cf-turnstile-response"] ||
    body.turnstileToken ||
    body.cf_turnstile_response ||
    ""
  ).toString();
  if (!token) {
    return json(400, { ok: false, error: "turnstile_required" });
  }
  const turnstileOk = await verifyTurnstile(token, turnstileSecret, ip);
  if (!turnstileOk) {
    return json(400, { ok: false, error: "turnstile_failed" });
  }

  const formId = (env.KIT_FORM_ID || DEFAULT_KIT_FORM_ID).toString().trim();
  if (!formId) {
    return json(503, { ok: false, error: "not_configured" });
  }

  const referrer = (body.referrer || request.headers.get("Referer") || "")
    .toString()
    .slice(0, 500);

  try {
    const result = await subscribeViaKitPublicForm(
      email,
      formId,
      referrer || null,
      request
    );
    if (!result.ok) {
      // 502 with Kit's status; never include email or raw Kit body.
      return json(502, {
        ok: false,
        error: "provider_error",
        kit_status: result.kitStatus || "unknown",
        kit_http: result.httpStatus || null,
      });
    }
    return json(200, { ok: true });
  } catch {
    return json(502, { ok: false, error: "provider_error", kit_status: "exception" });
  }
}

export async function onRequest(context) {
  if (context.request.method === "POST") {
    return onRequestPost(context);
  }
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  return json(405, { ok: false, error: "method_not_allowed" });
}
