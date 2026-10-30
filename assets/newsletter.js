/**
 * Newsletter signup client.
 * Cloudflare Turnstile managed widget site key (chivearcade newsletter).
 */
(function () {
  var TURNSTILE_SITE_KEY = "0x4AAAAAAFruQoFefM6gIyaK";

  function qs(el, sel) {
    return el.querySelector(sel);
  }

  function setMsg(el, state, text) {
    if (!el) return;
    el.dataset.state = state || "";
    el.textContent = text || "";
  }

  function getToken(form) {
    var input = form.querySelector('[name="cf-turnstile-response"]');
    return input && input.value ? input.value : "";
  }

  function resetTurnstile(form) {
    try {
      if (window.turnstile && form.dataset.widgetId) {
        window.turnstile.reset(form.dataset.widgetId);
      }
    } catch (e) {}
  }

  function ensureTurnstile(form) {
    if (!form || !window.turnstile || form.dataset.widgetId) return;
    var mount = qs(form, ".nl-turnstile");
    if (!mount) return;
    var wid = window.turnstile.render(mount, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: "dark",
      size: "flexible",
      "expired-callback": function () {
        resetTurnstile(form);
      },
      "timeout-callback": function () {
        resetTurnstile(form);
      },
      "error-callback": function () {
        resetTurnstile(form);
      },
    });
    form.dataset.widgetId = wid;
  }

  function bindForm(form) {
    if (!form || form.dataset.nlBound) return;
    form.dataset.nlBound = "1";

    var email = qs(form, 'input[type="email"]');
    var btn = qs(form, 'button[type="submit"]');
    var msg = qs(form, ".nl-msg");

    ensureTurnstile(form);

    function kickTurnstileEarly() {
      loadTurnstileScript();
      ensureTurnstile(form);
    }
    if (email) {
      email.addEventListener("focus", kickTurnstileEarly, { once: true });
    }
    form.addEventListener("pointerdown", kickTurnstileEarly, { once: true });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!email) return;
      var value = (email.value || "").trim();
      if (!value) {
        setMsg(msg, "err", "Enter your email.");
        email.focus();
        return;
      }

      kickTurnstileEarly();
      var token = getToken(form);
      if (!token) {
        setMsg(msg, "err", "Please complete the check and try again.");
        return;
      }

      var honey = qs(form, 'input[name="website"]');
      var payload = {
        email: value,
        website: honey ? honey.value : "",
        "cf-turnstile-response": token,
        referrer: location.href,
      };

      if (btn) btn.disabled = true;
      setMsg(msg, "", "Sending…");

      fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().then(
            function (data) {
              return { res: res, data: data || {} };
            },
            function () {
              return { res: res, data: {} };
            }
          );
        })
        .then(function (_ref) {
          var res = _ref.res;
          var data = _ref.data;
          if (res.ok && data.ok) {
            setMsg(msg, "ok", "Check your inbox to confirm.");
            form.reset();
            resetTurnstile(form);
            return;
          }
          var err = data.error || "";
          if (err === "not_configured" || err === "turnstile_not_configured" || err === "sending_not_ready") {
            setMsg(msg, "err", "Signup is not live yet. Try again soon.");
          } else if (err === "invalid_email") {
            setMsg(msg, "err", "That email does not look right.");
          } else if (err === "rate_limited") {
            setMsg(msg, "err", "Too many tries. Wait a minute.");
          } else if (err === "turnstile_required" || err === "turnstile_failed") {
            setMsg(msg, "err", "Please complete the check and try again.");
            resetTurnstile(form);
          } else if (err === "provider_error") {
            setMsg(msg, "err", "Signup did not go through. Try again.");
            resetTurnstile(form);
          } else {
            setMsg(msg, "err", "Something went wrong. Try again.");
            resetTurnstile(form);
          }
        })
        .catch(function () {
          setMsg(msg, "err", "Network error. Try again.");
          resetTurnstile(form);
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    });
  }

  function initAll() {
    document.querySelectorAll("form.nl-form").forEach(function (form) {
      bindForm(form);
      ensureTurnstile(form);
    });
  }

  window.onNewsletterTurnstileLoad = function () {
    initAll();
  };

  function loadTurnstileScript() {
    if (window.turnstile) {
      initAll();
      return;
    }
    if (document.querySelector('script[data-nl-turnstile]')) return;
    var s = document.createElement("script");
    s.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onNewsletterTurnstileLoad";
    s.async = true;
    s.defer = true;
    s.setAttribute("data-nl-turnstile", "1");
    s.onerror = function () {
      document.querySelectorAll("form.nl-form .nl-msg").forEach(function (el) {
        setMsg(el, "err", "Security check failed to load. Refresh and try again.");
      });
    };
    document.head.appendChild(s);
  }

  /** Load Turnstile after load so it does not contend with LCP (fonts/images). */
  function scheduleTurnstile() {
    function kick() {
      var run = function () {
        setTimeout(loadTurnstileScript, 1500);
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(run, { timeout: 2000 });
      } else {
        run();
      }
    }
    if (document.readyState === "complete") kick();
    else window.addEventListener("load", kick, { once: true });
  }

  // Bind forms early (submit works once Turnstile arrives); widget mounts on load.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      document.querySelectorAll("form.nl-form").forEach(bindForm);
      scheduleTurnstile();
    });
  } else {
    document.querySelectorAll("form.nl-form").forEach(bindForm);
    scheduleTurnstile();
  }
})();
