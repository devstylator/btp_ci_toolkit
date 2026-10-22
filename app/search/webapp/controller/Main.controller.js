sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/Dialog",
  "sap/m/List",
  "sap/m/StandardListItem",
  "sap/m/Button",
  "../model/formatter"
], function (Controller, JSONModel, Filter, FilterOperator, Dialog, List, StandardListItem, Button, formatter) {
  "use strict";

  const literal = (value) => `'${encodeURIComponent(String(value).replace(/'/g, "''"))}'`;

  return Controller.extend("btp.toolkit.search.controller.Main", {
    formatter,

    onInit() {
      this._model = new JSONModel({
        busy: false,
        error: "",
        tenant: "DEV",
        packages: [],
        packagesBusy: false,
        packageId: "",
        name: "",
        value: "",
        iflows: true,
        scripts: true,
        caseSensitive: false,
        criteriaText: "",
        result: null,
        failedText: "",
        findings: [],
        query: "",
        countText: ""
      });
      this._model.setSizeLimit(10000);
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

    async onSearch() {
      const m = this._model;
      const name = (m.getProperty("/name") || "").trim();
      const value = (m.getProperty("/value") || "").trim();
      const iflows = !!m.getProperty("/iflows");
      const scripts = !!m.getProperty("/scripts");
      // free text in the package box that does not match a package is ignored (all packages)
      const packageId = this.byId("package").getSelectedKey() || "";
      if (!name && !value) {
        m.setProperty("/error", this._text("patternRequired"));
        return;
      }
      if (!iflows && !scripts) {
        m.setProperty("/error", this._text("typeRequired"));
        return;
      }
      const tenant = m.getProperty("/tenant");
      const params = [
        `tenant=${literal(tenant)}`,
        `packageId=${literal(packageId)}`,
        `name=${literal(name)}`,
        `value=${literal(value)}`,
        `caseSensitive=${!!m.getProperty("/caseSensitive")}`,
        `iflows=${iflows}`,
        `scripts=${scripts}`
      ];
      m.setProperty("/error", "");
      m.setProperty("/busy", true);
      try {
        const result = await this._get(`search(${params.join(",")})`);
        m.setProperty("/result", result);
        m.setProperty("/findings", result.findings || []);
        m.setProperty("/failedText", (result.log || []).filter((e) => e.level === "ERROR").map((e) => e.message).join(" "));
        m.setProperty("/criteriaText", [tenant, packageId, name && `${this._text("name")}: ${name}`, value && `${this._text("value")}: ${value}`]
          .filter(Boolean).join(" · "));
      } catch (e) {
        m.setProperty("/error", this._text("requestFailed", e.message));
      } finally {
        m.setProperty("/busy", false);
        this.onFilter();
      }
    },

    onFilter() {
      const binding = this.byId("findingTable").getBinding("items");
      if (!binding) {
        return;
      }
      const query = (this._model.getProperty("/query") || "").trim();
      binding.filter(query ? new Filter({
        filters: ["name", "value", "artifactName", "artifactId", "packageId", "scriptPath"].map((path) =>
          new Filter({ path, operator: FilterOperator.Contains, value1: query, caseSensitive: false })),
        and: false
      }) : []);
      this._updateCount();
    },

    _updateCount() {
      const total = this._model.getProperty("/findings").length;
      const binding = this.byId("findingTable").getBinding("items");
      const shown = binding ? binding.getLength() : total;
      this._model.setProperty("/countText", shown === total ? this._text("count", total) : this._text("countFiltered", shown, total));
    },

    onShowLog() {
      if (!this._logDialog) {
        this._logDialog = new Dialog({
          title: this._text("logTitle"),
          contentWidth: "48rem",
          contentHeight: "60%",
          resizable: true,
          draggable: true,
          content: new List({
            items: {
              path: "view>/result/log",
              template: new StandardListItem({
                title: "{view>message}",
                info: { path: "view>timestamp", formatter: formatter.time },
                icon: { path: "view>level", formatter: formatter.levelIcon },
                infoState: { path: "view>level", formatter: formatter.messageType },
                wrapping: true
              })
            }
          }),
          endButton: new Button({ text: this._text("close"), press: () => this._logDialog.close() })
        });
        this.getView().addDependent(this._logDialog);
      }
      this._logDialog.open();
    }
  });
});
