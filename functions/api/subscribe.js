/**
 * POST /api/subscribe
 * Newsletter signup: rate limit, honeypot, Turnstile, then Kit v4 API.
 * No database. Emails and KIT_API_KEY are never logged.
 *
 * Kit v4 (authenticated with X-Kit-Api-Key):
 *   0. GET /v4/account — require a verified sending address (else 503
 *      sending_not_ready). Unverified "from" addresses cannot deliver DOI.
 *   1. POST /v4/subscribers { email_address, state: "inactive" } — upsert.
 *   2. POST /v4/forms/{KIT_FORM_ID}/subscribers { email_address } — add-by-email.
 *      Step 2 is what triggers the form's double opt-in incentive email.
 * Success only when both write calls return HTTP 2xx AND sending is verified.
 * Missing key → 503 not_configured.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const DEFAULT_KIT_FORM_ID = "10114495";
const KIT_API_BASE = "https://api.kit.com/v4";
const SENDING_CACHE_MS = 5 * 60 * 1000;

/** Per-isolate cache for Kit sending-address readiness (no addresses stored). */
let sendingReadyCache = null;

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

/**
 * Resolve Turnstile secret from env only. Missing key → fail closed (503).
 * No hostname-based test-secret fallback.
 */
function resolveTurnstileSecret(env) {
  const key =
    typeof env.TURNSTILE_SECRET_KEY === "string"
      ? env.TURNSTILE_SECRET_KEY.trim()
      : "";
  return key || null;
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
 * Kit v4: create/upsert subscriber as inactive, then add to form by email.
 * Never logs request/response bodies (may include email) or the API key.
 */
/** Parse Kit JSON; return only non-secret fields (never subscriber email). */
async function readKitSafe(res) {
  const httpStatus = res.status;
  let state = null;
  let id = null;
  try {
    const data = await res.json();
    const sub = data && data.subscriber;
    if (sub && typeof sub.state === "string") state = sub.state;
    if (sub && typeof sub.id === "number") id = sub.id;
  } catch {
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
  }
  return { httpStatus, state, id };
}

/**
 * Kit cannot deliver DOI / incentive email without a verified sending address.
 * Cached per isolate ~5 minutes. Never logs; never returns address list to callers
 * that would echo it publicly.
 */
async function checkKitSendingReady(apiKey) {
  const now = Date.now();
  if (
    sendingReadyCache &&
    now - sendingReadyCache.at < SENDING_CACHE_MS
  ) {
    return sendingReadyCache.result;
  }

  const res = await fetch(KIT_API_BASE + "/account", {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Kit-Api-Key": apiKey,
    },
  });
  const httpStatus = res.status;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  let result;
  if (httpStatus < 200 || httpStatus >= 300 || !data || !data.account) {
    result = {
      ok: false,
      httpStatus,
      verified: false,
      error: "account_lookup_failed",
    };
  } else {
    const raw = Array.isArray(data.account.sending_addresses)
      ? data.account.sending_addresses
      : [];
    const verified = raw.some((s) => s && s.is_verified);
    result = { ok: true, httpStatus, verified };
  }

  // Cache successes and "not verified" so we don't hammer Kit; do not cache
  // hard lookup failures (brief outage should retry sooner).
  if (result.ok) {
    sendingReadyCache = { at: now, result };
  }
  return result;
}

/**
 * Kit v4 DOI flow (docs):
 *   POST /v4/subscribers { email_address, state: "inactive" }  — upsert
 *   POST /v4/forms/{id}/subscribers { email_address }         — add-by-email
 * The form add is what triggers the double opt-in incentive email when the
 * form has DOI enabled. Create alone does not send it. Already-on-form (HTTP
 * 200) does not resend. Never logs email or the API key.
 */
async function subscribeViaKitV4(email, formId, apiKey, referrer) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Kit-Api-Key": apiKey,
  };

  // 1) Upsert subscriber — inactive so double opt-in is not skipped.
  //    Existing subscribers: state is not updated by this endpoint.
  const createRes = await fetch(KIT_API_BASE + "/subscribers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email_address: email,
      state: "inactive",
    }),
  });

  const create = await readKitSafe(createRes);
  if (create.httpStatus < 200 || create.httpStatus >= 300) {
    return {
      ok: false,
      step: "create_subscriber",
      httpStatus: create.httpStatus,
      subscriberState: create.state,
      subscriberId: create.id,
    };
  }

  // 2) Add to form by email — THIS call triggers the form's DOI incentive email.
  const formBody = { email_address: email };
  if (referrer) formBody.referrer = referrer;

  const formRes = await fetch(
    KIT_API_BASE + "/forms/" + encodeURIComponent(formId) + "/subscribers",
    {
      method: "POST",
      headers,
      body: JSON.stringify(formBody),
    }
  );

  const form = await readKitSafe(formRes);
  if (form.httpStatus < 200 || form.httpStatus >= 300) {
    return {
      ok: false,
      step: "add_to_form",
      httpStatus: form.httpStatus,
      subscriberState: form.state || create.state,
      subscriberId: form.id || create.id,
      createHttp: create.httpStatus,
    };
  }

  // 201 = newly added (DOI should fire). 200 = already on form (no resend).
  const doiTriggered = form.httpStatus === 201;

  return {
    ok: true,
    httpStatus: form.httpStatus,
    createHttp: create.httpStatus,
    subscriberState: form.state || create.state,
    subscriberId: form.id || create.id,
    doiTriggered,
  };
}

const MAX_BODY_BYTES = 8_192;

function contentLengthTooLarge(request) {
  const raw = request.headers.get("Content-Length");
  if (raw == null || raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > MAX_BODY_BYTES;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (contentLengthTooLarge(request)) {
    return json(413, { ok: false, error: "bad_request" });
  }

  const ip = clientIp(request);
  if (await rateLimited(ip)) {
    return json(429, { ok: false, error: "rate_limited" });
  }

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

  const turnstileSecret = resolveTurnstileSecret(env);
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

  const apiKey =
    typeof env.KIT_API_KEY === "string" ? env.KIT_API_KEY.trim() : "";
  if (!apiKey) {
    return json(503, { ok: false, error: "not_configured" });
  }

  const formId = (env.KIT_FORM_ID || DEFAULT_KIT_FORM_ID).toString().trim();
  if (!formId) {
    return json(503, { ok: false, error: "not_configured" });
  }

  // DOI / incentive email cannot send without a verified Kit sending address.
  let sending;
  try {
    sending = await checkKitSendingReady(apiKey);
  } catch {
    return json(502, { ok: false, error: "provider_error" });
  }
  if (!sending.ok) {
    return json(502, { ok: false, error: "provider_error" });
  }
  if (!sending.verified) {
    // Do not create/add subscribers when Kit cannot deliver the confirm email.
    // Do not echo sending_addresses — that leaks account config.
    return json(503, { ok: false, error: "sending_not_ready" });
  }

  const referrer = (body.referrer || request.headers.get("Referer") || "")
    .toString()
    .slice(0, 500);

  try {
    const result = await subscribeViaKitV4(
      email,
      formId,
      apiKey,
      referrer || null
    );
    if (!result.ok) {
      // 502; never include email, key, Kit codes, or subscriber state.
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
