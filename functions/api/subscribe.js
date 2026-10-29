/**
 * POST /api/subscribe
 * Newsletter signup: honeypot, Turnstile, rate limit, then Kit public form POST.
 * No database. Emails are never logged. No Kit API key required.
 *
 * Kit public form (double opt-in):
 *   POST https://app.kit.com/forms/{KIT_FORM_ID}/subscriptions
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: email_address=...
 * Embed: https://chive-arcade.kit.com/fd74872931/index.js (form 10114495)
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
 * Kit public form subscribe (no API key).
 * Field name from embed: email_address. Form-encoded POST.
 * Success: 200/201. Validation: 422. Already subscribed often still 200.
 */
async function subscribeViaKitPublicForm(email, formId) {
  const url =
    "https://app.kit.com/forms/" + encodeURIComponent(formId) + "/subscriptions";
  const body = new URLSearchParams();
  body.set("email_address", email);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  // Do not log response bodies (may include email).
  if (res.status === 200 || res.status === 201) {
    return { ok: true, status: res.status };
  }
  if (res.status === 422) {
    return { ok: false, status: 422, error: "invalid_email" };
  }
  // HTML success redirects sometimes return 302 to a thank-you page
  if (res.status >= 300 && res.status < 400) {
    return { ok: true, status: res.status };
  }
  return { ok: false, status: res.status, error: "provider_error" };
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
    // Production without a real secret must not accept signups
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

  try {
    const result = await subscribeViaKitPublicForm(email, formId);
    if (!result.ok) {
      if (result.error === "invalid_email") {
        return json(400, { ok: false, error: "invalid_email" });
      }
      return json(502, { ok: false, error: "provider_error" });
    }
    return json(200, { ok: true });
  } catch {
    return json(502, { ok: false, error: "provider_error" });
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
