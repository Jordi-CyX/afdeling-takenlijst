(function () {
  if (!("serviceWorker" in navigator)) return;

  // Only reload when an existing worker is replaced (not on the very first install).
  var reloading = false;
  var hadController = Boolean(navigator.serviceWorker.controller);

  function activateWaiting(worker) {
    if (!worker) return;
    try { worker.postMessage({ type: "SKIP_WAITING" }); } catch (err) { /* ignore */ }
  }

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(function (reg) {
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) reg.update().catch(function () {});
    });
    // v20 will not auto-skipWaiting for zeiklijst-v19-onderhoud; activate it here.
    if (reg.waiting) activateWaiting(reg.waiting);
    reg.addEventListener("updatefound", function () {
      var installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", function () {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          activateWaiting(reg.waiting || installing);
        }
      });
    });
  }).catch(function () {});
})();
