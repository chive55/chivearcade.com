/**
 * POST /api/subscribe
 * Newsletter signup: honeypot, Turnstile, rate limit, then Kit (ConvertKit) v4.
 * No database. Emails are never logged. Without KIT_API_KEY + KIT_FORM_ID,
 * returns 503 {ok:false,error:"not_configured"} and stores nothing.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;

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
 * Kit v4: create inactive subscriber, then add to form (triggers double opt-in).
 * https://developers.kit.com/api-reference/subscribers/create-a-subscriber
 * https://developers.kit.com/api-reference/forms/add-subscriber-to-form-by-email-address
 */
async function subscribeViaKit(email, apiKey, formId, referrer) {
  const headers = {
    "Content-Type": "application/json",
    "X-Kit-Api-Key": apiKey,
  };

  const createRes = await fetch("https://api.kit.com/v4/subscribers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email_address: email,
      state: "inactive",
    }),
  });
  if (!createRes.ok) {
    return { ok: false, status: createRes.status };
  }

  const addBody = { email_address: email };
  if (referrer) addBody.referrer = referrer;

  const addRes = await fetch(
    "https://api.kit.com/v4/forms/" + encodeURIComponent(formId) + "/subscribers",
    {
      method: "POST",
      headers,
      body: JSON.stringify(addBody),
    }
  );
  if (addRes.status === 200 || addRes.status === 201) {
    return { ok: true };
  }
  return { ok: false, status: addRes.status };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await parseBody(request);
  } catch {
    return json(400, { ok: false, error: "bad_request" });
  }

  // Honeypot: reject silently with fake success (do not reveal)
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

  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret) {
    const token = (
      body["cf-turnstile-response"] ||
      body.turnstileToken ||
      body.cf_turnstile_response ||
      ""
    ).toString();
    if (!token) {
      return json(400, { ok: false, error: "turnstile_required" });
    }
    const ok = await verifyTurnstile(token, turnstileSecret, ip);
    if (!ok) {
      return json(400, { ok: false, error: "turnstile_failed" });
    }
  }

  const apiKey = env.KIT_API_KEY;
  const formId = env.KIT_FORM_ID;
  if (!apiKey || !formId) {
    return json(503, { ok: false, error: "not_configured" });
  }

  const referrer = (body.referrer || request.headers.get("Referer") || "")
    .toString()
    .slice(0, 500);

  try {
    const result = await subscribeViaKit(
      email,
      apiKey,
      formId,
      referrer || null
    );
    if (!result.ok) {
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
