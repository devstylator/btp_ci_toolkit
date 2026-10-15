sap.ui.define([
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Input",
  "sap/m/Label",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Dialog, Button, Input, Label, MessageToast, MessageBox) {
  "use strict";

  // The standard action-parameter dialog of Fiori elements cannot mask input, so the secret is entered here.
  function askForSecret() {
    return new Promise((resolve) => {
      const input = new Input({ type: "Password", width: "100%", placeholder: "OAuth client secret" });
      const dialog = new Dialog({
        title: "Set client secret",
        contentWidth: "24rem",
        content: [new Label({ text: "Client secret", labelFor: input }), input],
        beginButton: new Button({
          text: "Set client secret",
          type: "Emphasized",
          press() {
            const value = input.getValue();
            dialog.close();
            resolve(value);
          }
        }),
        endButton: new Button({ text: "Cancel", press: () => { dialog.close(); resolve(null); } }),
        afterClose: () => dialog.destroy()
      }).addStyleClass("sapUiContentPadding");
      dialog.open();
    });
  }

  return {
    async onSetSecret(contextOrEvent) {
      const context = contextOrEvent && contextOrEvent.getObject
        ? contextOrEvent
        : contextOrEvent && contextOrEvent.getSource && contextOrEvent.getSource().getBindingContext();
      if (!context) {
        return;
      }
      const secret = await askForSecret();
      if (!secret) {
        return;
      }
      try {
        const action = context.getModel().bindContext("ConfigService.setSecret(...)", context);
        action.setParameter("secret", secret);
        await action.execute();
        await context.requestSideEffects(["secretSet"]);
        MessageToast.show("Client secret saved");
      } catch (e) {
        MessageBox.error(e.message);
      }
    }
  };
});
