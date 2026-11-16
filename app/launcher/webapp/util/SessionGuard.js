/**
 * Detects an expired approuter session and asks the user to sign in again (FR-NAV-9).
 *
 * After SESSION_TIMEOUT minutes of inactivity the approuter answers a plain GET with a redirect to the XSUAA login
 * page (HTML), which surfaces as "module could not be loaded", "Failed to fetch" or JSON parse errors. Requests that
 * carry `X-Requested-With: XMLHttpRequest` get a clean 401 instead. This module therefore
 * - adds that header to every same-origin `fetch` and `XMLHttpRequest` (feature apps included, they run in this page),
 * - shows one blocking "session expired" dialog on any 401; its button reloads the page, which goes through the login
 *   and comes back to the same feature (`?feature=` and hash are kept),
 * - offers `check()` (a HEAD on the feature service) for places where no status is available, e.g. before loading a
 *   feature component (UI5 loads JS through <script> tags) or after a failed `fetch`,
 * - checks the session when the tab becomes visible again after a while (laptop sleep, other tab).
 *
 * The patching runs when this module is loaded (the launcher Component depends on it), before any feature exists.
 * The dialog controls are required up front: once the session is gone no further module can be loaded.
 */
sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Text",
  "sap/m/library",
  "sap/ui/core/library"
], function (Dialog, Button, Text, mLibrary, coreLibrary) {
  "use strict";

  const HEADER = "X-Requested-With";
  const HEADER_VALUE = "XMLHttpRequest";
  // re-check the session when the tab becomes visible after at least this long without requests
  const RECHECK_AFTER_MS = 60 * 1000;

  const originalFetch = window.fetch.bind(window);
  let pingUrl = "/odata/v4/features/";
  let texts = {
    title: "Session expired",
    message: "Your session has expired, most likely because the app was idle. Sign in again to continue.",
    button: "Sign in again"
  };
  let lastActivity = Date.now();
  let expired = false;
  let dialog;

  function isSameOrigin(url) {
    try {
      return new URL(url, window.location.href).origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function showExpired() {
    if (expired) {
      return;
    }
    expired = true;
    dialog = new Dialog({
      type: mLibrary.DialogType.Message,
      state: coreLibrary.ValueState.Warning,
      title: texts.title,
      content: new Text({ text: texts.message }),
      beginButton: new Button({
        type: mLibrary.ButtonType.Emphasized,
        text: texts.button,
        press: () => window.location.reload()
      }),
      // not closable: the page cannot do anything useful without a session
      escapeHandler: (promise) => promise.reject()
    });
    dialog.open();
  }

  /** @returns {Promise<boolean>} false if the session has expired (the dialog is then shown); true otherwise. */
  async function check() {
    if (expired) {
      return false;
    }
    try {
      const res = await originalFetch(pingUrl, { method: "HEAD", headers: { [HEADER]: HEADER_VALUE } });
      if (res.status === 401) {
        showExpired();
        return false;
      }
      lastActivity = Date.now();
    } catch (e) {
      // network problem, not a session problem: let the caller report its own error
    }
    return true;
  }

  // fetch: add the header, report 401, check the session when the request fails without a response
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    if (!isSameOrigin(url)) {
      return originalFetch(input, init);
    }
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    if (!headers.has(HEADER)) {
      headers.set(HEADER, HEADER_VALUE);
    }
    let res;
    try {
      res = await originalFetch(input, { ...init, headers });
    } catch (e) {
      await check();
      throw e;
    }
    if (res.status === 401) {
      showExpired();
    } else {
      lastActivity = Date.now();
    }
    return res;
  };

  // XMLHttpRequest (UI5 models, views, i18n): same as fetch
  const xhrProto = window.XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;
  const originalSetRequestHeader = xhrProto.setRequestHeader;
  const originalSend = xhrProto.send;
  xhrProto.open = function (method, url, ...rest) {
    this._sessionGuard = { sameOrigin: isSameOrigin(url), headerSet: false };
    return originalOpen.call(this, method, url, ...rest);
  };
  xhrProto.setRequestHeader = function (name, value) {
    if (this._sessionGuard && String(name).toLowerCase() === HEADER.toLowerCase()) {
      this._sessionGuard.headerSet = true;
    }
    return originalSetRequestHeader.call(this, name, value);
  };
  xhrProto.send = function (body) {
    const guard = this._sessionGuard;
    if (guard && guard.sameOrigin) {
      if (!guard.headerSet) {
        originalSetRequestHeader.call(this, HEADER, HEADER_VALUE);
      }
      this.addEventListener("loadend", () => {
        if (this.status === 401) {
          showExpired();
        } else if (this.status) {
          lastActivity = Date.now();
        }
      });
    }
    return originalSend.call(this, body);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastActivity > RECHECK_AFTER_MS) {
      check();
    }
  });

  return {
    /**
     * @param {object} settings
     * @param {string} [settings.pingUrl] same-origin URL answering HEAD for a valid session (feature service root)
     * @param {sap.base.i18n.ResourceBundle} [settings.bundle] texts sessionExpiredTitle/-Message/-Button
     */
    configure(settings) {
      if (settings.pingUrl) {
        pingUrl = settings.pingUrl;
      }
      if (settings.bundle) {
        texts = {
          title: settings.bundle.getText("sessionExpiredTitle"),
          message: settings.bundle.getText("sessionExpiredMessage"),
          button: settings.bundle.getText("sessionExpiredButton")
        };
      }
    },
    check,
    isExpired: () => expired
  };
});
