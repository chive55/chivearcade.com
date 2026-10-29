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

  function bindForm(form) {
    if (!form || form.dataset.nlBound) return;
    form.dataset.nlBound = "1";

    var email = qs(form, 'input[type="email"]');
    var btn = qs(form, 'button[type="submit"]');
    var msg = qs(form, ".nl-msg");
    var mount = qs(form, ".nl-turnstile");

    if (mount && window.turnstile && !form.dataset.widgetId) {
      var wid = window.turnstile.render(mount, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "dark",
      });
      form.dataset.widgetId = wid;
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!email) return;
      var value = (email.value || "").trim();
      if (!value) {
        setMsg(msg, "err", "Enter your email.");
        email.focus();
        return;
      }

      var honey = qs(form, 'input[name="website"]');
      var payload = {
        email: value,
        website: honey ? honey.value : "",
        "cf-turnstile-response": getToken(form),
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
          return res.json().then(function (data) {
            return { res: res, data: data || {} };
          });
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
          if (err === "not_configured") {
            setMsg(msg, "err", "Signup is not live yet. Try again soon.");
          } else if (err === "invalid_email") {
            setMsg(msg, "err", "That email does not look right.");
          } else if (err === "rate_limited") {
            setMsg(msg, "err", "Too many tries. Wait a minute.");
          } else if (err === "turnstile_required" || err === "turnstile_failed") {
            setMsg(msg, "err", "Please complete the check and try again.");
            resetTurnstile(form);
          } else if (err === "provider_error") {
            var ks = data.kit_status || "";
            if (ks === "quarantined") {
              setMsg(msg, "err", "Kit blocked this signup as automated. Try again from the form, or email us.");
            } else {
              setMsg(msg, "err", "Signup did not go through. Try again.");
            }
            resetTurnstile(form);
          } else {
            setMsg(msg, "err", "Something went wrong. Try again.");
            resetTurnstile(form);
          }
        })
        .catch(function () {
          setMsg(msg, "err", "Network error. Try again.");
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    });
  }

  function initAll() {
    document.querySelectorAll("form.nl-form").forEach(bindForm);
  }

  window.onNewsletterTurnstileLoad = function () {
    initAll();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }
})();
