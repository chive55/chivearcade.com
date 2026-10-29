/**
 * Lazy video load + pause/play control.
 * Respects prefers-reduced-motion. Prefers mobile trailer; HD only on wide screens
 * without Save-Data. Visible control text: "Pause video" / "Play video".
 */
(function () {
  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function saveDataOn() {
    try {
      if (navigator.connection && navigator.connection.saveData) return true;
    } catch (e) {}
    return false;
  }

  function heroSrc(video) {
    var mobile = video.getAttribute("data-src") || "";
    var hd = video.getAttribute("data-src-hd") || "";
    var wide =
      window.matchMedia && window.matchMedia("(min-width: 900px)").matches;
    if (wide && hd && !saveDataOn() && !reduceMotion) return hd;
    return mobile;
  }

  function setBtn(btn, playing) {
    if (!btn) return;
    btn.setAttribute("aria-pressed", playing ? "true" : "false");
    btn.textContent = playing ? "Pause video" : "Play video";
  }

  function ensureBtn(video) {
    var host = video.parentElement;
    if (!host) return null;
    var existing = host.querySelector(".vb-video-toggle");
    if (existing) return existing;
    host.classList.add("vb-media-ctrl");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vb-video-toggle";
    btn.setAttribute("aria-pressed", "false");
    btn.textContent = "Play video";
    host.appendChild(btn);
    return btn;
  }

  function wire(video, opts) {
    opts = opts || {};
    var btn = ensureBtn(video);
    var wantAuto = !reduceMotion && opts.autoplay !== false;

    function loadSrc() {
      if (video.getAttribute("src")) return;
      var src = opts.pickSrc ? opts.pickSrc(video) : video.getAttribute("data-src");
      if (!src) return;
      video.setAttribute("src", src);
      video.load();
    }

    function play() {
      loadSrc();
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      setBtn(btn, true);
    }

    function pause() {
      video.pause();
      setBtn(btn, false);
    }

    if (btn) {
      btn.addEventListener("click", function () {
        if (video.paused) play();
        else pause();
      });
    }

    video.addEventListener("play", function () {
      setBtn(btn, true);
    });
    video.addEventListener("pause", function () {
      setBtn(btn, false);
    });

    // Strip HTML autoplay; JS decides.
    video.removeAttribute("autoplay");

    if (!wantAuto) {
      setBtn(btn, false);
      return { play: play, pause: pause, loadSrc: loadSrc, auto: false };
    }

    return { play: play, pause: pause, loadSrc: loadSrc, auto: true };
  }

  function observeAndMaybePlay(video, ctrl, rootMargin) {
    function go() {
      if (ctrl.auto) ctrl.play();
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) {
              go();
              io.unobserve(e.target);
            }
          });
        },
        { rootMargin: rootMargin || "120px" }
      );
      io.observe(video);
    } else if (ctrl.auto) {
      go();
    }
  }

  var hero = document.querySelector("video.vb-trailer");
  if (hero) {
    var heroCtrl = wire(hero, { pickSrc: heroSrc, autoplay: true });
    observeAndMaybePlay(hero, heroCtrl, "80px");
  }

  var clips = document.querySelectorAll("video[data-lazy]");
  clips.forEach(function (v) {
    var ctrl = wire(v, { autoplay: true });
    observeAndMaybePlay(v, ctrl, "200px");
  });
})();
