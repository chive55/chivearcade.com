/**
 * Lazy video load + pause/play control.
 * Hero autoplay is deferred until after load so the poster can be LCP.
 * Respects prefers-reduced-motion. Mobile trailer by default; HD only on wide
 * screens without Save-Data. Control labels: "Pause video" / "Play video".
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

  function videoName(video) {
    return (video && video.getAttribute("aria-label")) || "video";
  }

  function setBtn(btn, playing, video) {
    if (!btn) return;
    btn.removeAttribute("aria-pressed");
    btn.textContent = playing ? "Pause video" : "Play video";
    var name = videoName(video);
    btn.setAttribute(
      "aria-label",
      playing ? "Pause " + name : "Play " + name
    );
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
    btn.textContent = "Play video";
    btn.setAttribute("aria-label", "Play " + videoName(video));
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
      setBtn(btn, true, video);
      if (p && p.catch) {
        p.catch(function () {
          setBtn(btn, false, video);
        });
      }
    }

    function pause() {
      video.pause();
      setBtn(btn, false, video);
    }

    if (btn) {
      btn.addEventListener("click", function () {
        if (video.paused) play();
        else pause();
      });
    }

    video.addEventListener("play", function () {
      setBtn(btn, true, video);
    });
    video.addEventListener("pause", function () {
      setBtn(btn, false, video);
    });

    video.removeAttribute("autoplay");

    if (!wantAuto) {
      setBtn(btn, false, video);
      return { play: play, pause: pause, loadSrc: loadSrc, auto: false };
    }

    return { play: play, pause: pause, loadSrc: loadSrc, auto: true };
  }

  function afterLoad(fn) {
    if (document.readyState === "complete") fn();
    else window.addEventListener("load", fn, { once: true });
  }

  /** Defer past typical mobile LCP so poster/image wins, not the video frame. */
  function afterLcpQuiet(fn) {
    afterLoad(function () {
      var run = function () {
        setTimeout(fn, 2000);
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(run, { timeout: 2500 });
      } else {
        run();
      }
    });
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
    // Hero is above the fold: do not start until after LCP quiet period.
    if (heroCtrl.auto) {
      afterLcpQuiet(function () {
        heroCtrl.play();
      });
    }
  }

  var clips = document.querySelectorAll("video[data-lazy]");
  clips.forEach(function (v) {
    var ctrl = wire(v, { autoplay: true });
    // Below-fold clips: wait for LCP quiet, then IO.
    afterLcpQuiet(function () {
      observeAndMaybePlay(v, ctrl, "200px");
    });
  });
})();
