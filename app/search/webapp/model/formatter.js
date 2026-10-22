sap.ui.define([], function () {
  "use strict";

  const LEVEL_TYPE = { INFO: "Information", WARN: "Warning", ERROR: "Error" };
  const LEVEL_ICON = { INFO: "sap-icon://information", WARN: "sap-icon://alert", ERROR: "sap-icon://error" };

  const text = (ctx, key, ...args) => ctx.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key, args);

  return {
    messageType: (level) => LEVEL_TYPE[level] || "Information",
    levelIcon: (level) => LEVEL_ICON[level] || LEVEL_ICON.INFO,
    objectIcon: (type) => (type === "SCRIPT" ? "sap-icon://source-code" : "sap-icon://process"),

    kind(kind) {
      return kind ? text(this, `kind${kind}`) : "";
    },

    objectType(type) {
      return type ? text(this, `type${type}`) : "";
    },

    /** "package / script.groovy:12" or just the package for iFlow parameters. */
    location(packageId, scriptPath, line) {
      return scriptPath ? `${packageId} / ${scriptPath}:${line}` : packageId || "";
    },

    value(v) {
      return v === undefined || v === null || v === "" ? text(this, "empty") : v;
    },

    time(iso) {
      return iso ? new Date(iso).toLocaleTimeString() : "";
    }
  };
});
