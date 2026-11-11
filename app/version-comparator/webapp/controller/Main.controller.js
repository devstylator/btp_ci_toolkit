sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "../model/formatter"
], function (Controller, JSONModel, Filter, FilterOperator, formatter) {
  "use strict";

  const emptyResult = () => ({
    hasResult: false, summary: {}, rows: [], log: [], logCount: 0, tags: [], tab: "result", artifactCountText: ""
  });

  const contains = (paths, query) => new Filter({
    filters: paths.map((path) => new Filter({ path, operator: FilterOperator.Contains, value1: query, caseSensitive: false })),
    and: false
  });

  return Controller.extend("btp.toolkit.versioncomparator.controller.Main", {
    formatter,

    onInit() {
      this._model = new JSONModel({
        busy: false,
        error: "",
        // list
        packages: [],
        query: "",
        countText: "",
        // detail
        package: null,
        detailBusy: false,
        detailError: "",
        resultQuery: "",
        onlyDifferences: false,
        ...emptyResult()
      });
      this._model.setSizeLimit(100000);
      this.getView().setModel(this._model, "view");
      this._baseUrl = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/main/uri");
      this._updateCount();
      this.onReload();
    },

    _text(key, ...args) {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key, args);
    },

    // The approuter (CF) rejects POSTs without a CSRF token; locally the header is simply absent.
    async _csrfToken() {
      if (this._token === undefined) {
        try {
          const res = await fetch(this._baseUrl, { method: "HEAD", headers: { "X-CSRF-Token": "Fetch" } });
          this._token = res.headers.get("X-CSRF-Token") || "";
        } catch (e) {
          this._token = "";
        }
      }
      return this._token;
    },

    async _request(path, options) {
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (options && options.method === "POST") {
        const token = await this._csrfToken();
        if (token) {
          headers["X-CSRF-Token"] = token;
        }
      }
      const res = await fetch(`${this._baseUrl}${path}`, { ...options, headers });
      if (res.status === 403 && options && options.method === "POST") {
        this._token = undefined; // token expired, fetch a new one on the next call
      }
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          message = (await res.json()).error.message || message;
        } catch (e) {
          // keep the HTTP status text
        }
        throw new Error(message);
      }
      return res.json();
    },

    // ---- list ----

    async onReload() {
      const m = this._model;
      m.setProperty("/busy", true);
      m.setProperty("/error", "");
      try {
        m.setProperty("/packages", (await this._request("listPackages()")).value || []);
      } catch (e) {
        m.setProperty("/packages", []);
        m.setProperty("/error", this._text("requestFailed", e.message));
      } finally {
        m.setProperty("/busy", false);
        this.onFilterPackages();
      }
    },

    onFilterPackages() {
      const binding = this.byId("packageTable").getBinding("rows");
      if (!binding) {
        return;
      }
      const query = (this._model.getProperty("/query") || "").trim();
      binding.filter(query ? contains(["name", "id"], query) : [], "Application");
      this._updateCount();
    },

    onRowsUpdated() {
      this._updateCount();
    },

    _updateCount() {
      const total = this._model.getProperty("/packages").length;
      const binding = this.byId("packageTable").getBinding("rows");
      const shown = binding ? binding.getLength() : total;
      this._model.setProperty("/countText", shown === total ? this._text("count", total) : this._text("countFiltered", shown, total));
    },

    onCellClick(event) {
      const context = event.getParameter("rowBindingContext");
      if (context) {
        this._open(context.getObject());
      }
    },

    onRowAction(event) {
      this._open(event.getParameter("row").getBindingContext("view").getObject());
    },

    // ---- detail ----

    _open(pkg) {
      const m = this._model;
      m.setProperty("/package", { ...pkg, inDev: true, inProd: false });
      m.setProperty("/resultQuery", "");
      m.setProperty("/onlyDifferences", false);
      this.byId("nav").to(this.byId("detailPage"));
      return this._compare();
    },

    onRecompare() {
      return this._compare();
    },

    async _compare() {
      const m = this._model;
      const pkg = m.getProperty("/package");
      this._applyResult(emptyResult());
      m.setProperty("/detailError", "");
      m.setProperty("/detailBusy", true);
      try {
        const result = await this._request("compare", { method: "POST", body: JSON.stringify({ packageId: pkg.id }) });
        if (m.getProperty("/package") !== pkg) {
          return; // another package was opened meanwhile
        }
        m.setProperty("/package", { ...pkg, ...result.package, name: (result.package && result.package.name) || pkg.name });
        this._applyResult(result);
        if (!result.success) {
          m.setProperty("/detailError", this._text("compareFailed"));
          m.setProperty("/tab", "log");
        }
      } catch (e) {
        if (m.getProperty("/package") === pkg) {
          m.setProperty("/detailError", this._text("requestFailed", e.message));
        }
      } finally {
        m.setProperty("/detailBusy", false);
      }
    },

    _applyResult(result) {
      const m = this._model;
      const summary = result.summary || {};
      // translated type text, so the display filter matches what is shown
      const rows = (result.rows || []).map((r) => ({ ...r, typeText: formatter.typeText.call(this, r.artifactType) }));
      const log = result.log || [];
      const tags = result.hasResult === false ? [] : [
        { state: "None", text: this._text("tagTotal", summary.total) },
        { state: "Success", text: this._text("tagMatch", summary.matching) },
        { state: "Warning", text: this._text("tagMismatch", summary.mismatching) },
        { state: "Error", text: this._text("tagMissingDev", summary.missingInDev) },
        { state: "Error", text: this._text("tagMissingProd", summary.missingInProd) }
      ];
      m.setProperty("/summary", summary);
      m.setProperty("/rows", rows);
      m.setProperty("/log", log);
      m.setProperty("/logCount", log.length);
      m.setProperty("/tags", tags);
      m.setProperty("/tab", "result");
      m.setProperty("/hasResult", result.hasResult !== false && (rows.length > 0 || log.length > 0));
      this.onFilterResults();
    },

    /** Display-only filter over the compared rows (no new comparison). */
    onFilterResults() {
      const binding = this.byId("resultTable").getBinding("items");
      if (!binding) {
        return;
      }
      const filters = [];
      const query = (this._model.getProperty("/resultQuery") || "").trim();
      if (query) {
        filters.push(contains(["artifactId", "artifactName", "artifactType", "typeText"], query));
      }
      if (this._model.getProperty("/onlyDifferences")) {
        filters.push(new Filter("status", FilterOperator.NE, "MATCH"));
      }
      binding.filter(filters.length ? new Filter({ filters, and: true }) : [], "Application");
      this._updateArtifactCount();
    },

    onResultUpdated() {
      this._updateArtifactCount();
    },

    _updateArtifactCount() {
      const total = this._model.getProperty("/rows").length;
      const binding = this.byId("resultTable").getBinding("items");
      const shown = binding ? binding.getLength() : total;
      this._model.setProperty("/artifactCountText",
        shown === total ? this._text("artifactCount", total) : this._text("artifactCountFiltered", shown, total));
    },

    onBack() {
      this._model.setProperty("/package", null);
      this.byId("nav").back();
    }
  });
});
