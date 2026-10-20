sap.ui.define([], function () {
  "use strict";

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

    dateTime(value) {
      return value ? new Date(value).toLocaleString() : "";
    }
  };
});
