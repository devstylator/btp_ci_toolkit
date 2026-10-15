sap.ui.define([], function () {
  "use strict";

  const STATE = {
    MATCH: "Success",
    MISMATCH: "Warning",
    MISSING_IN_DEV: "Error",
    MISSING_IN_PROD: "Error"
  };

  const LEVEL_ICON = {
    INFO: "sap-icon://message-information",
    WARN: "sap-icon://message-warning",
    ERROR: "sap-icon://message-error"
  };

  const LEVEL_COLOR = { INFO: "Neutral", WARN: "Critical", ERROR: "Negative" };

  return {
    statusState: (status) => STATE[status] || "None",

    statusText(status) {
      return this.getView().getModel("i18n").getResourceBundle().getText(`status${status}`);
    },

    typeText(type) {
      const bundle = this.getView().getModel("i18n").getResourceBundle();
      return bundle.hasText(`type${type}`) ? bundle.getText(`type${type}`) : type;
    },

    version(value) {
      return value || this.getView().getModel("i18n").getResourceBundle().getText("notPresent");
    },

    levelIcon: (level) => LEVEL_ICON[level] || LEVEL_ICON.INFO,
    levelColor: (level) => LEVEL_COLOR[level] || "Neutral",

    time(iso) {
      return iso ? new Date(iso).toLocaleTimeString() : "";
    }
  };
});
