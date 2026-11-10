sap.ui.define([], function () {
  "use strict";

  const TENANT_STATE = { DEV: "Information", PROD: "Warning" };
  const STATUS_STATE = { STARTED: "Success", STARTING: "Information", ERROR: "Error", STOPPING: "Warning" };
  const LEVEL_TYPE = { INFO: "Information", WARN: "Warning", ERROR: "Error" };

  return {
    tenantState: (tenant) => TENANT_STATE[tenant] || "None",
    statusState: (status) => STATUS_STATE[String(status || "").toUpperCase()] || "None",
    messageType: (level) => LEVEL_TYPE[level] || "Information",

    value(text) {
      return text || this.getOwnerComponent().getModel("i18n").getResourceBundle().getText("empty");
    },

    dateTime(iso) {
      return iso ? new Date(iso).toLocaleString() : "-";
    },

    /** Access role cell: role, `-` when the channel has none, a hint when the iFlow could not be read. */
    role(role, source) {
      const bundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      if (source === "NONE") {
        return bundle.getText("roleUnknown");
      }
      return role || bundle.getText("empty");
    },

    roleState: (source) => (source === "NONE" ? "Warning" : source === "DESIGNTIME" ? "Information" : "None"),

    contentSource(source) {
      return source ? this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(`source${source}`) : "-";
    }
  };
});
