sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Component",
  "sap/ui/core/routing/HashChanger",
  "sap/ui/core/Theming",
  "sap/ui/model/json/JSONModel"
], function (Controller, Component, HashChanger, Theming, JSONModel) {
  "use strict";

  const FEATURE_PARAM = "feature";
  // also read by index.html before UI5 boots
  const THEME_KEY = "btp-ci-toolkit.theme";
  const LIGHT = "sap_horizon";
  const DARK = "sap_horizon_dark";

  return Controller.extend("btp.toolkit.launcher.controller.App", {
    onInit() {
      this._features = new Map();
      this.getView().setModel(new JSONModel({
        features: [], system: [], selected: "", error: "", crumbLinks: [], crumbCurrent: "",
        dark: Theming.getTheme() === DARK,
        // replace img/logo-light.svg / img/logo-dark.svg to use a custom logo
        logoLight: sap.ui.require.toUrl("btp/toolkit/launcher/img/logo-light.svg"),
        logoDark: sap.ui.require.toUrl("btp/toolkit/launcher/img/logo-dark.svg")
      }), "nav");
      // Fiori elements apps navigate through the URL hash; mirror it in the breadcrumbs.
      this._onHashChange = () => this._updateBreadcrumbs();
      window.addEventListener("hashchange", this._onHashChange);
      this._loadFeatures();
    },

    async _loadFeatures() {
      const nav = this.getView().getModel("nav");
      const text = (key, ...args) => this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key, args);
      try {
        const base = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/features/uri");
        const res = await fetch(`${base}Features`, { headers: { Accept: "application/json" } });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const features = (await res.json()).value;
        features.forEach((f) => this._features.set(f.ID, f));
        nav.setProperty("/features", features.filter((f) => f.group !== "SYSTEM"));
        nav.setProperty("/system", features.filter((f) => f.group === "SYSTEM"));

        const wanted = new URLSearchParams(window.location.search).get(FEATURE_PARAM);
        const initial = features.find((f) => f.route === wanted) || features.find((f) => f.group !== "SYSTEM") || features[0];
        if (initial) {
          await this._open(initial.ID, true);
        } else {
          nav.setProperty("/error", text("noFeatures"));
        }
      } catch (e) {
        nav.setProperty("/error", text("loadError", e.message));
      }
    },

    onExit() {
      window.removeEventListener("hashchange", this._onHashChange);
    },

    /** Light/dark switch; remembered in this browser only (localStorage), nothing is stored on the server. */
    onToggleTheme() {
      const nav = this.getView().getModel("nav");
      const dark = !nav.getProperty("/dark");
      Theming.setTheme(dark ? DARK : LIGHT);
      nav.setProperty("/dark", dark);
      try {
        localStorage.setItem(THEME_KEY, dark ? DARK : LIGHT);
      } catch (e) {
        // storage blocked (private mode): the switch still works for this page
      }
    },

    onToggleSideNav() {
      const toolPage = this.byId("toolPage");
      toolPage.setSideExpanded(!toolPage.getSideExpanded());
    },

    onItemSelect(event) {
      const id = event.getParameter("item").getKey();
      // /selected is two-way bound to the side navigation, so compare with the feature that is actually open
      if (id === this._openId) {
        // already open: go back to the start page of the feature instead of reloading it
        this._goTo("");
      } else {
        this._open(id);
      }
    },

    onCrumbPress(event) {
      this._goTo(event.getSource().getBindingContext("nav").getProperty("hash"));
    },

    _goTo(hash) {
      window.location.hash = hash ? `#/${hash}` : "#/";
    },

    /** Builds "Feature / Entity / key" crumbs from a hash like #/Connections(code='DEV',IsActiveEntity=true). */
    _updateBreadcrumbs() {
      const nav = this.getView().getModel("nav");
      const feature = this._features.get(nav.getProperty("/selected"));
      if (!feature) {
        return;
      }
      const crumbs = [{ text: feature.title, hash: "" }];
      const path = window.location.hash.replace(/^#\/?/, "").split("?")[0];
      const visited = [];
      path.split("/").filter(Boolean).forEach((segment) => {
        const match = /^([^(]+)(?:\((.*)\))?$/.exec(decodeURIComponent(segment));
        if (!match) {
          return;
        }
        crumbs.push({ text: match[1], hash: visited.join("/") });
        const key = match[2] && match[2].split(",").find((pair) => !/^IsActiveEntity=/.test(pair));
        if (key) {
          visited.push(segment);
          crumbs.push({ text: key.split("=").pop().replace(/^'|'$/g, ""), hash: visited.join("/") });
        }
      });
      const current = crumbs.pop();
      nav.setProperty("/crumbLinks", crumbs);
      nav.setProperty("/crumbCurrent", current.text);
    },

    async _open(id, keepHash) {
      const feature = this._features.get(id);
      const nav = this.getView().getModel("nav");
      const container = this.byId("container");
      nav.setProperty("/selected", id);
      nav.setProperty("/error", "");

      const url = new URL(window.location.href);
      url.searchParams.set(FEATURE_PARAM, feature.route);
      window.history.replaceState(null, "", url);

      if (!keepHash) {
        // a feature always starts on its start page: remove the previous feature first so it does not react,
        // then clear the hash through UI5 (it caches the last hash, a plain history.replaceState is not enough)
        const previous = container.getComponentInstance();
        if (previous) {
          container.setComponent(null);
          previous.destroy();
          this._openId = undefined;
        }
        HashChanger.getInstance().replaceHash("");
      }
      this._updateBreadcrumbs();

      try {
        sap.ui.loader.config({ paths: { [feature.component.replace(/\./g, "/")]: feature.componentUrl } });
        const component = await Component.create({ name: feature.component, id: `feature-${feature.ID}-${Date.now()}` });
        if (nav.getProperty("/selected") !== id) {
          component.destroy(); // user already picked another feature
          return;
        }
        const previous = container.getComponentInstance();
        container.setComponent(component);
        this._openId = id;
        if (previous) {
          previous.destroy();
        }
      } catch (e) {
        const bundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
        nav.setProperty("/error", bundle.getText("featureLoadError", [feature.title, e.message]));
      }
    }
  });
});
