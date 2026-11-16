sap.ui.define([
  "sap/ui/core/UIComponent",
  "./util/SessionGuard"
], function (UIComponent, SessionGuard) {
  "use strict";

  return UIComponent.extend("btp.toolkit.launcher.Component", {
    metadata: { manifest: "json", interfaces: ["sap.ui.core.IAsyncContentCreation"] },

    init() {
      UIComponent.prototype.init.apply(this, arguments);
      SessionGuard.configure({
        pingUrl: this.getManifestEntry("/sap.app/dataSources/features/uri"),
        bundle: this.getModel("i18n").getResourceBundle()
      });
    }
  });
});
