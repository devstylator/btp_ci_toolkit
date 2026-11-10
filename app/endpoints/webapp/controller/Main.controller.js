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
        // filter header
        tenant: "DEV",
        packages: [],
        packagesBusy: false,
        packageId: "",
        iflow: "",
        url: "",
        adapter: "",
        role: "",
        accessRoles: false,
        criteriaText: "",
        // result
        withRoles: false,
        endpoints: [],
        messages: [],
        query: "",
        countText: "",
        // detail
        selected: null,
        adapterText: "",
        details: null,
        detailBusy: false,
        detailError: ""
      });
      this._model.setSizeLimit(100000);
      this.getView().setModel(this._model, "view");
      this._baseUrl = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/main/uri");
      this.byId("package").setFilterFunction((term, item) => {
        const t = term.toLowerCase();
        return item.getText().toLowerCase().includes(t) || item.getKey().toLowerCase().includes(t);
      });
      this._updateCount();
      this.onLoadPackages();
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

    async onLoadPackages() {
      const tenant = this._model.getProperty("/tenant");
      this._model.setProperty("/packagesBusy", true);
      this._model.setProperty("/error", "");
      try {
        const result = await this._get(`listPackages(tenant=${literal(tenant)})`);
        if (this._model.getProperty("/tenant") === tenant) {
          this._model.setProperty("/packages", result.value || []);
        }
      } catch (e) {
        this._model.setProperty("/packages", []);
        this._model.setProperty("/error", this._text("requestFailed", e.message));
      } finally {
        this._model.setProperty("/packagesBusy", false);
      }
    },

    onTenantChange() {
      this._model.setProperty("/packageId", "");
      this.onLoadPackages();
    },

    async onGo() {
      const m = this._model;
      const tenant = m.getProperty("/tenant");
      // free text in the package box that does not match a package is ignored (all packages)
      const packageId = this.byId("package").getSelectedKey() || "";
      const iflow = (m.getProperty("/iflow") || "").trim();
      const url = (m.getProperty("/url") || "").trim();
      const adapter = m.getProperty("/adapter") || "";
      const role = (m.getProperty("/role") || "").trim();
      const accessRoles = !!m.getProperty("/accessRoles") || !!role;
      const params = [
        `tenant=${literal(tenant)}`,
        `packageId=${literal(packageId)}`,
        `iflow=${literal(iflow)}`,
        `url=${literal(url)}`,
        `adapter=${literal(adapter)}`,
        `role=${literal(role)}`,
        `accessRoles=${accessRoles}`
      ];
      m.setProperty("/error", "");
      m.setProperty("/busy", true);
      try {
        const result = await this._get(`listEndpoints(${params.join(",")})`);
        m.setProperty("/withRoles", accessRoles);
        m.setProperty("/endpoints", result.endpoints || []);
        m.setProperty("/messages", result.messages || []);
        m.setProperty("/loaded", true);
        m.setProperty("/criteriaText", [
          tenant,
          packageId,
          iflow && `${this._text("colIflow")}: ${iflow}`,
          url && `${this._text("colEndpoint")}: ${url}`,
          adapter,
          role && `${this._text("colRole")}: ${role}`
        ].filter(Boolean).join(" · "));
      } catch (e) {
        m.setProperty("/error", this._text("requestFailed", e.message));
      } finally {
        m.setProperty("/busy", false);
        this.onFilter();
      }
    },

    /** Quick filter in the table toolbar; combined with the column filters of the table. */
    onFilter() {
      const binding = this.byId("endpointTable").getBinding("rows");
      if (!binding) {
        return;
      }
      const query = (this._model.getProperty("/query") || "").trim();
      binding.filter(query ? new Filter({
        filters: ["iflowName", "iflowId", "adapter", "url", "authentication", "userRole"].map((path) =>
          new Filter({ path, operator: FilterOperator.Contains, value1: query, caseSensitive: false })),
        and: false
      }) : [], "Application");
      this._updateCount();
    },

    onClearFilters() {
      const table = this.byId("endpointTable");
      table.getColumns().forEach((column) => {
        if (column.getFiltered()) {
          table.filter(column, "");
        }
        column.setSortOrder("None");
      });
      table.getBinding("rows")?.sort([]);
      this._model.setProperty("/query", "");
      this.onFilter();
    },

    onRowsUpdated() {
      this._updateCount();
    },

    _updateCount() {
      const total = this._model.getProperty("/endpoints").length;
      const binding = this.byId("endpointTable").getBinding("rows");
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

    async _open(row) {
      this._model.setProperty("/selected", row);
      this._model.setProperty("/adapterText", row.adapter);
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
          this._model.setProperty("/adapterText", adapters.join(", "));
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
