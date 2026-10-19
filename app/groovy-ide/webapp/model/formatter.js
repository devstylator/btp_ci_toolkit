sap.ui.define([], function () {
  "use strict";

  const TEST_STATE = { PASSED: "Success", FAILED: "Error", ERROR: "Error", NO_EXPECTATION: "Information" };
  const TEST_ICON = {
    PASSED: "sap-icon://sys-enter-2",
    FAILED: "sap-icon://error",
    ERROR: "sap-icon://alert",
    NO_EXPECTATION: "sap-icon://hint"
  };

  return {
    /** Ace mode for a message body: XML, JSON or plain text. */
    bodyType(text) {
      const start = (text || "").trimStart().charAt(0);
      return start === "<" ? "xml" : start === "{" || start === "[" ? "json" : "text";
    },

    sourceText(script) {
      if (!script || !script.sourceType || script.sourceType === "LOCAL") {
        return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText("sourceLocal");
      }
      const name = script.sourceArtifactName || script.sourceArtifactId;
      const file = (script.sourcePath || "").split("/").pop();
      return `${script.sourceTenant || "DEV"}: ${name} ${script.sourceArtifactVersion || ""} / ${file}`;
    },

    sourceIcon(type) {
      return type === "IFLOW" ? "sap-icon://process" : type === "SCRIPT_COLLECTION" ? "sap-icon://course-book" : "sap-icon://document-text";
    },

    testState: (status) => TEST_STATE[status] || "None",
    testIcon: (status) => TEST_ICON[status] || "",

    testText(status) {
      return status ? this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(`test${status}`) : "";
    },

    dateTime(value) {
      return value ? new Date(value).toLocaleString() : "";
    }
  };
});
