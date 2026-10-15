sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "../model/formatter"
], function (Controller, JSONModel, Filter, FilterOperator, formatter) {
  "use strict";

  const emptyResult = () => ({ hasResult: false, summary: {}, rows: [], log: [], logCount: 0, tags: [], tab: "result" });

  // type-ahead: match anywhere in the ID or the name, not only at the start
  const containsFilter = (value, item) => {
    const needle = value.trim().toLowerCase();
    return `${item.getText()} ${item.getAdditionalText()}`.toLowerCase().includes(needle);
  };

  const escapeLiteral = (value) => encodeURIComponent(value.replace(/'/g, "''"));

  return Controller.extend("btp.toolkit.versioncomparator.controller.Main", {
    formatter,

    onInit() {
      this._model = new JSONModel({
        busy: false,
        error: "",
        packages: [],
        artifacts: [],
        packageId: "",
        artifactId: "",
        onlyDifferences: false,
        ...emptyResult()
      });
      this.getView().setModel(this._model, "view");
      this.byId("packageBox").setFilterFunction(containsFilter);
      this.byId("artifactBox").setFilterFunction(containsFilter);
      this._baseUrl = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/main/uri");
      this._loadPackages();
    },

    _text(key, ...args) {
      return this.getView().getModel("i18n").getResourceBundle().getText(key, args);
    },

    async _request(path, options) {
      let res;
      try {
        res = await fetch(`${this._baseUrl}${path}`, {
          ...options,
          headers: { Accept: "application/json", "Content-Type": "application/json" }
        });
      } catch (e) {
        throw new Error(e.message);
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

    async _run(fn) {
      this._model.setProperty("/busy", true);
      this._model.setProperty("/error", "");
      try {
        await fn();
      } catch (e) {
        this._model.setProperty("/error", this._text("requestFailed", e.message));
      } finally {
        this._model.setProperty("/busy", false);
      }
    },

    _loadPackages() {
      return this._run(async () => {
        this._model.setProperty("/packages", (await this._request("listPackages()")).value);
      });
    },

    onReload() {
      this._model.setProperty("/artifacts", []);
      this._model.setProperty("/artifactId", "");
      return this._loadPackages();
    },

    onPackageChange() {
      this._model.setProperty("/artifactId", "");
      this._model.setProperty("/artifacts", []);
      const packageId = this._model.getProperty("/packageId");
      if (!packageId) {
        return undefined;
      }
      return this._run(async () => {
        const result = await this._request(`listArtifacts(packageId='${escapeLiteral(packageId)}')`);
        if (this._model.getProperty("/packageId") === packageId) {
          this._model.setProperty("/artifacts", result.value);
        }
      });
    },

    onCompare() {
      const packageId = this._model.getProperty("/packageId");
      const artifactId = this._model.getProperty("/artifactId");
      if (!packageId) {
        return undefined;
      }
      return this._run(async () => {
        this._applyResult(emptyResult());
        const result = await this._request("compare", {
          method: "POST",
          body: JSON.stringify({ packageId, artifactId: artifactId || null })
        });
        this._applyResult(result);
        if (!result.success) {
          this._model.setProperty("/error", this._text("compareFailed"));
          this._model.setProperty("/tab", "log");
        }
      });
    },

    _applyResult(result) {
      const summary = result.summary || {};
      const rows = result.rows || [];
      const log = result.log || [];
      const tags = result.hasResult === false ? [] : [
        { state: "None", text: this._text("tagTotal", summary.total) },
        { state: "Success", text: this._text("tagMatch", summary.matching) },
        { state: "Warning", text: this._text("tagMismatch", summary.mismatching) },
        { state: "Error", text: this._text("tagMissingDev", summary.missingInDev) },
        { state: "Error", text: this._text("tagMissingProd", summary.missingInProd) }
      ];
      this._model.setProperty("/summary", summary);
      this._model.setProperty("/rows", rows);
      this._model.setProperty("/log", log);
      this._model.setProperty("/logCount", log.length);
      this._model.setProperty("/tags", tags);
      this._model.setProperty("/tab", "result");
      this._model.setProperty("/hasResult", result.hasResult !== false && (rows.length > 0 || log.length > 0));
      this._filterRows();
    },

    onFilterChange() {
      this._filterRows();
    },

    _filterRows() {
      const binding = this.byId("resultTable").getBinding("items");
      if (!binding) {
        return;
      }
      binding.filter(this._model.getProperty("/onlyDifferences") ? [new Filter("status", FilterOperator.NE, "MATCH")] : []);
    }
  });
});
