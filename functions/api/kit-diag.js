/**
 * Preview-only Kit read-back. Never logs email or KIT_API_KEY.
 * GET /api/kit-diag — *.pages.dev only.
 */
const TARGET = "chivearcade@gmail.com";
const FORM_ID = "10114495";
const BASE = "https://api.kit.com/v4";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

function redactSub(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: s.id ?? null,
    state: s.state ?? null,
    created_at: s.created_at ?? null,
    added_at: s.added_at ?? null,
    email_match: typeof s.email_address === "string"
      ? s.email_address.toLowerCase() === TARGET
      : false,
  };
}

async function kitGet(path, apiKey) {
  const res = await fetch(BASE + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Kit-Api-Key": apiKey,
    },
  });
  const http = res.status;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { http, data };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  let host = "";
  try {
    host = new URL(request.url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (!host.endsWith(".pages.dev")) {
    return json(404, { ok: false, error: "not_found" });
  }

  const apiKey =
    typeof env.KIT_API_KEY === "string" ? env.KIT_API_KEY.trim() : "";
  if (!apiKey) {
    return json(503, { ok: false, error: "not_configured" });
  }

  const out = {
    ok: true,
    account: null,
    forms: [],
    form_10114495: null,
    subscriber_by_email: {},
    form_subscribers: [],
    form_has_target: false,
  };

  // Account
  const acct = await kitGet("/account", apiKey);
  out.account_http = acct.http;
  if (acct.data && acct.data.account) {
    const a = acct.data.account;
    const u = acct.data.user || {};
    out.account = {
      id: a.id ?? null,
      name: a.name ?? null,
      plan_type: a.plan_type ?? null,
      primary_email_address: a.primary_email_address ?? null,
      user_email: u.email ?? null,
      sending_addresses: Array.isArray(a.sending_addresses)
        ? a.sending_addresses.map((s) => ({
            email_address: s.email_address ?? null,
            status: s.status ?? null,
            is_default: !!s.is_default,
            is_verified: !!s.is_verified,
          }))
        : [],
    };
  } else if (acct.data && acct.data.errors) {
    out.account_errors = acct.data.errors;
  }

  // Forms
  const forms = await kitGet("/forms?status=all&include=subscriber_count&per_page=100", apiKey);
  out.forms_http = forms.http;
  if (forms.data && Array.isArray(forms.data.forms)) {
    out.forms = forms.data.forms.map((f) => ({
      id: f.id,
      name: f.name,
      uid: f.uid,
      type: f.type,
      archived: !!f.archived,
      subscriber_count: f.subscriber_count ?? null,
      embed_js: f.embed_js || null,
    }));
    out.form_10114495 =
      out.forms.find((f) => String(f.id) === FORM_ID) || null;
  }

  // Subscriber lookup by email across statuses
  for (const status of ["all", "active", "inactive", "cancelled", "bounced", "complained"]) {
    const q =
      "/subscribers?email_address=" +
      encodeURIComponent(TARGET) +
      "&status=" +
      status +
      "&per_page=10&slim=true";
    const r = await kitGet(q, apiKey);
    out.subscriber_by_email[status] = {
      http: r.http,
      count: r.data && Array.isArray(r.data.subscribers) ? r.data.subscribers.length : null,
      subscribers: r.data && Array.isArray(r.data.subscribers)
        ? r.data.subscribers.map(redactSub)
        : [],
      errors: r.data && r.data.errors ? r.data.errors : null,
    };
  }

  // Form subscribers
  const fs = await kitGet(
    "/forms/" + FORM_ID + "/subscribers?per_page=50&status=all",
    apiKey
  );
  out.form_subscribers_http = fs.http;
  if (fs.data && Array.isArray(fs.data.subscribers)) {
    out.form_subscribers = fs.data.subscribers.map(redactSub);
    out.form_has_target = out.form_subscribers.some((s) => s && s.email_match);
    out.form_subscriber_count = out.form_subscribers.length;
  } else if (fs.data && fs.data.errors) {
    out.form_subscribers_errors = fs.data.errors;
  }

  return json(200, out);
}

export async function onRequest(context) {
  if (context.request.method === "GET") return onRequestGet(context);
  return json(405, { ok: false, error: "method_not_allowed" });
}
