sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "../model/formatter"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, formatter) {
  "use strict";

  const literal = (value) => `'${encodeURIComponent(String(value).replace(/'/g, "''"))}'`;

  return Controller.extend("btp.toolkit.endpoints.controller.Main", {
    formatter,

    onInit() {
      this._model = new JSONModel({
        busy: false,
        error: "",
        loaded: false,
        endpoints: [],
        messages: [],
        countText: "",
        tenant: "ALL",
        query: "",
        selected: null,
        adapter: "",
        details: null,
        detailBusy: false,
        detailError: ""
      });
      this._model.setSizeLimit(10000);
      this.getView().setModel(this._model, "view");
      this._baseUrl = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/main/uri");
      this.onReload();
    },

    _text(key, ...args) {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key, args);
    },

    formatMessage(pattern, ...args) {
      return pattern ? pattern.replace(/\{(\d+)\}/g, (all, i) => (args[i] ?? "")) : "";
    },

    // functions are GETs: no CSRF token needed
    async _get(path) {
      const res = await fetch(`${this._baseUrl}${path}`, { headers: { Accept: "application/json" } });
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

    async onReload() {
      this._model.setProperty("/busy", true);
      this._model.setProperty("/error", "");
      try {
        const result = await this._get("listEndpoints()");
        this._model.setProperty("/endpoints", result.endpoints || []);
        this._model.setProperty("/messages", result.messages || []);
        this._model.setProperty("/loaded", true);
      } catch (e) {
        this._model.setProperty("/error", this._text("requestFailed", e.message));
      } finally {
        this._model.setProperty("/busy", false);
        this.onFilter();
      }
    },

    onFilter() {
      const binding = this.byId("endpointTable").getBinding("items");
      if (!binding) {
        return;
      }
      const filters = [];
      const tenant = this._model.getProperty("/tenant");
      if (tenant && tenant !== "ALL") {
        filters.push(new Filter("tenant", FilterOperator.EQ, tenant));
      }
      const query = (this._model.getProperty("/query") || "").trim();
      if (query) {
        filters.push(new Filter({
          filters: ["iflowName", "iflowId", "adapter", "url"].map((path) =>
            new Filter({ path, operator: FilterOperator.Contains, value1: query, caseSensitive: false })),
          and: false
        }));
      }
      binding.filter(filters.length ? new Filter({ filters, and: true }) : []);
      this._model.setProperty("/countText", this._text("count", binding.getLength()));
    },

    async onSelect(event) {
      const row = event.getSource().getBindingContext("view").getObject();
      this._model.setProperty("/selected", row);
      this._model.setProperty("/adapter", row.adapter);
      this._model.setProperty("/details", null);
      this._model.setProperty("/detailError", "");
      this.byId("nav").to(this.byId("detailPage"));
      this._model.setProperty("/detailBusy", true);
      try {
        const details = await this._get(
          `endpointDetails(tenant=${literal(row.tenant)},iflowId=${literal(row.iflowId)},url=${literal(row.url)})`);
        if (this._model.getProperty("/selected") !== row) {
          return; // another endpoint was opened meanwhile
        }
        this._model.setProperty("/details", details);
        const adapters = [...new Set((details.channels || []).map((c) => c.adapter).filter(Boolean))];
        if (details.matched && adapters.length) {
          this._model.setProperty("/adapter", adapters.join(", "));
        }
      } catch (e) {
        this._model.setProperty("/detailError", this._text("requestFailed", e.message));
      } finally {
        this._model.setProperty("/detailBusy", false);
      }
    },

    onBack() {
      this._model.setProperty("/selected", null);
      this.byId("nav").back();
    },

    async onCopyUrl() {
      try {
        await navigator.clipboard.writeText(this._model.getProperty("/selected/url"));
        MessageToast.show(this._text("urlCopied"));
      } catch (e) {
        // clipboard not available (e.g. non-secure context); the URL can still be selected
      }
    }
  });
});
