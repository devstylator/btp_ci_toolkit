sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "../model/formatter",
  "../model/diff"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, formatter, diff) {
  "use strict";

  const TEMPLATE = `import com.sap.gateway.ip.core.customdev.util.Message

Message processData(Message message) {
    def body = message.getBody(String)
    println "Body length: \${body?.length() ?: 0}"
    message.setBody(body)
    return message
}
`;

  const SCRIPT_COLUMNS = "ID,name,description,sourceType,sourceTenant,sourcePackageId,sourceArtifactId,sourceArtifactName,sourceArtifactVersion,sourcePath,modifiedAt,modifiedBy";

  const emptyOutput = () => ({ has: false, success: false, httpStatus: 0, body: "", headers: [], properties: [], console: "", error: "", durationMs: 0 });
  const emptyInput = () => ({ body: "", bodyType: "text", headers: [], properties: [] });
  const cleanList = (list) => (list || []).filter((r) => r.name && r.name.trim()).map((r) => ({ name: r.name.trim(), value: r.value || "" }));
  const parseList = (json) => {
    try {
      const list = JSON.parse(json || "[]");
      return Array.isArray(list) ? list.map((r) => ({ name: r.name, value: r.value })) : [];
    } catch (e) {
      return [];
    }
  };
  const escapeLiteral = (value) => encodeURIComponent(value.replace(/'/g, "''"));

  return Controller.extend("btp.toolkit.groovyide.controller.Main", {
    formatter,

    onInit() {
      this._model = new JSONModel({
        busy: false,
        error: "",
        canEdit: false,
        executorEnabled: false,
        statusLoaded: false,
        search: "",
        scripts: [],
        script: null,
        content: TEMPLATE,
        savedContent: TEMPLATE,
        dirty: false,
        input: emptyInput(),
        output: emptyOutput(),
        inputTab: "body",
        outputTab: "body",
        testCases: [],
        testSummary: "",
        loadedTestCaseId: null,
        testCase: {},
        versions: [],
        versionComment: "",
        details: {},
        diff: {},
        import: {}
      });
      this._model.setSizeLimit(10000);
      this.getView().setModel(this._model, "view");
      this._baseUrl = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/main/uri");

      // Ctrl+Enter runs, Ctrl+S saves (also while the code editor has the focus).
      this._onKeyDown = (event) => {
        if (!(event.ctrlKey || event.metaKey) || !this.getView().getDomRef() || this._openDialog()) {
          return;
        }
        if (event.key === "Enter" && this._model.getProperty("/canEdit") && this._model.getProperty("/executorEnabled")) {
          event.preventDefault();
          this.onRun();
        } else if (event.key.toLowerCase() === "s" && this._model.getProperty("/canEdit")) {
          event.preventDefault();
          this.onSave();
        }
      };
      document.addEventListener("keydown", this._onKeyDown, true);

      this._run(async () => {
        const status = await this._request("executorStatus()");
        this._model.setProperty("/canEdit", status.canRun);
        this._model.setProperty("/executorEnabled", status.enabled);
        this._model.setProperty("/statusLoaded", true);
        await this._loadScripts();
      });
    },

    onExit() {
      document.removeEventListener("keydown", this._onKeyDown, true);
      Object.values(this._timers || {}).forEach(clearTimeout);
    },

    _text(key, ...args) {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key, args);
    },

    _openDialog() {
      return ["detailsDialog", "importDialog", "versionsDialog", "diffDialog", "testCaseDialog"].some((id) => this.byId(id).isOpen());
    },

    // ---- HTTP -------------------------------------------------------------------------------------------

    // The approuter (CF) rejects modifying requests without a CSRF token; locally the header is simply absent.
    async _csrfToken() {
      if (this._token === undefined) {
        try {
          const res = await fetch(this._baseUrl, { method: "HEAD", headers: { "X-CSRF-Token": "Fetch" } });
          this._token = res.headers.get("X-CSRF-Token") || "";
        } catch (e) {
          this._token = "";
        }
      }
      return this._token;
    },

    async _request(path, method, data) {
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (method && method !== "GET") {
        const token = await this._csrfToken();
        if (token) {
          headers["X-CSRF-Token"] = token;
        }
      }
      const res = await fetch(`${this._baseUrl}${path}`, {
        method: method || "GET",
        headers,
        body: data === undefined ? undefined : JSON.stringify(data)
      });
      if (res.status === 403 && method && method !== "GET") {
        this._token = undefined; // token expired, fetch a new one on the next call
      }
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          message = (await res.json()).error.message || message;
        } catch (e) {
          // keep the HTTP status text
        }
        throw new Error(message);
      }
      return res.status === 204 ? undefined : res.json();
    },

    async _run(fn) {
      this._model.setProperty("/busy", true);
      this._model.setProperty("/error", "");
      try {
        return await fn();
      } catch (e) {
        this._model.setProperty("/error", this._text("requestFailed", e.message));
        return undefined;
      } finally {
        this._model.setProperty("/busy", false);
      }
    },

    onCloseError() {
      this._model.setProperty("/error", "");
    },

    onCloseDialog(event) {
      this.byId(event.getSource().data("dialog")).close();
    },

    // Code editors are bound one-way: writing the model from liveChange makes Ace re-render endlessly.
    // The live text is read from the editors; liveChange only updates flags (dirty, syntax mode).

    _content() {
      return this.byId("scriptEditor").getCurrentValue();
    },

    /** Puts text into the script editor; `saved` also sets the saved state (no unsaved changes). */
    _setContent(text, saved) {
      this._model.setProperty("/content", text);
      const editor = this.byId("scriptEditor");
      if (editor.getCurrentValue() !== text) {
        editor.setValue(text);
      }
      if (saved !== undefined) {
        this._model.setProperty("/savedContent", saved);
      }
      this._updateDirty(text);
    },

    _updateDirty(text) {
      const dirty = (text === undefined ? this._content() : text) !== this._model.getProperty("/savedContent");
      if (this._model.getProperty("/dirty") !== dirty) {
        this._model.setProperty("/dirty", dirty);
      }
    },

    _isDirty() {
      return this._content() !== this._model.getProperty("/savedContent");
    },

    _setInput(input) {
      this._model.setProperty("/input", { ...input, bodyType: formatter.bodyType(input.body) });
      const editor = this.byId("inputBodyEditor");
      if (editor.getCurrentValue() !== input.body) {
        editor.setValue(input.body);
      }
    },

    _setExpected(text) {
      this._model.setProperty("/testCase/expectedBody", text);
      this._model.setProperty("/testCase/expectedType", formatter.bodyType(text));
      const editor = this.byId("expectedEditor");
      if (editor.getCurrentValue() !== text) {
        editor.setValue(text);
      }
    },

    _setIfChanged(path, value) {
      if (this._model.getProperty(path) !== value) {
        this._model.setProperty(path, value);
      }
    },

    /** Resolves true when there are no unsaved changes or the user agrees to discard them. */
    _confirmDiscard() {
      if (!this._isDirty()) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        MessageBox.confirm(this._text("discardChanges"), {
          actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
          onClose: (action) => resolve(action === MessageBox.Action.OK)
        });
      });
    },

    // ---- scripts ----------------------------------------------------------------------------------------

    async _loadScripts() {
      const result = await this._request(`Scripts?$select=${SCRIPT_COLUMNS}&$orderby=name`);
      this._model.setProperty("/scripts", result.value);
      this._syncListSelection();
    },

    _syncListSelection() {
      const list = this.byId("scriptList");
      const id = this._model.getProperty("/script/ID");
      list.getItems().forEach((item) => {
        const selected = !!id && item.getBindingContext("view").getProperty("ID") === id;
        if (item.getSelected() !== selected) {
          list.setSelectedItem(item, selected);
        }
      });
    },

    onSearch(event) {
      const query = event.getParameter("newValue") || "";
      this.byId("scriptList").getBinding("items").filter(query ? [new Filter({
        filters: ["name", "description", "sourceArtifactName", "sourcePath"].map((path) => new Filter(path, FilterOperator.Contains, query)),
        and: false
      })] : []);
    },

    async onSelectScript(event) {
      const id = event.getParameter("listItem").getBindingContext("view").getProperty("ID");
      if (id === this._model.getProperty("/script/ID")) {
        return;
      }
      if (!(await this._confirmDiscard())) {
        this._syncListSelection();
        return;
      }
      await this._openScript(id);
    },

    _openScript(id) {
      return this._run(async () => {
        const script = await this._request(`Scripts(${id})?$expand=testCases($orderby=name)`);
        const testCases = (script.testCases || []).map((tc) => ({ ...tc, lastStatus: null, lastResult: null }));
        delete script.testCases;
        this._model.setProperty("/script", script);
        this._setContent(script.content || "", script.content || "");
        this._model.setProperty("/testCases", testCases);
        this._model.setProperty("/testSummary", "");
        this._model.setProperty("/loadedTestCaseId", null);
        this._model.setProperty("/output", emptyOutput());
        this._syncListSelection();
      });
    },

    // Ace also fires liveChange with intermediate values while (re-)rendering; react to the settled text only,
    // otherwise a type switch would invalidate the editor during its own rendering.
    _later(key, fn) {
      this._timers = this._timers || {};
      clearTimeout(this._timers[key]);
      this._timers[key] = setTimeout(fn, 250);
    },

    onScriptLiveChange() {
      this._later("dirty", () => this._updateDirty());
    },

    onInputBodyLiveChange() {
      this._later("input", () => this._setIfChanged("/input/bodyType", formatter.bodyType(this.byId("inputBodyEditor").getCurrentValue())));
    },

    async onNew() {
      if (!(await this._confirmDiscard())) {
        return;
      }
      this._model.setProperty("/details", { title: this._text("newScript"), mode: "create", name: "", description: "" });
      this.byId("detailsDialog").open();
    },

    onEditDetails() {
      const script = this._model.getProperty("/script");
      this._model.setProperty("/details", { title: this._text("editDetails"), mode: "update", name: script.name, description: script.description || "" });
      this.byId("detailsDialog").open();
    },

    onSaveDetails() {
      const details = this._model.getProperty("/details");
      if (!details.name || !details.name.trim()) {
        return undefined;
      }
      this.byId("detailsDialog").close();
      return this._run(async () => {
        if (details.mode === "create") {
          const fromScratchpad = !this._model.getProperty("/script");
          const created = await this._request("Scripts", "POST", {
            name: details.name.trim(),
            description: details.description || null,
            sourceType: "LOCAL",
            content: fromScratchpad ? this._content() : TEMPLATE
          });
          await this._loadScripts();
          await this._openScript(created.ID);
        } else {
          const id = this._model.getProperty("/script/ID");
          await this._request(`Scripts(${id})`, "PATCH", { name: details.name.trim(), description: details.description || null });
          this._model.setProperty("/script/name", details.name.trim());
          this._model.setProperty("/script/description", details.description || null);
          await this._loadScripts();
        }
        MessageToast.show(this._text("saved"));
      });
    },

    onSave() {
      if (!this._model.getProperty("/script")) {
        return this.onNew(); // scratchpad: ask for a name first
      }
      return this._run(async () => {
        const id = this._model.getProperty("/script/ID");
        const content = this._content();
        await this._request(`Scripts(${id})`, "PATCH", { content });
        this._setContent(content, content);
        await this._loadScripts();
        MessageToast.show(this._text("saved"));
      });
    },

    onDeleteScript() {
      const script = this._model.getProperty("/script");
      MessageBox.confirm(this._text("confirmDeleteScript", script.name), {
        emphasizedAction: MessageBox.Action.OK,
        onClose: (action) => {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          this._run(async () => {
            await this._request(`Scripts(${script.ID})`, "DELETE");
            this._model.setProperty("/script", null);
            this._setContent(TEMPLATE, TEMPLATE);
            this._model.setProperty("/testCases", []);
            this._model.setProperty("/loadedTestCaseId", null);
            await this._loadScripts();
            MessageToast.show(this._text("deleted"));
          });
        }
      });
    },

    // ---- run --------------------------------------------------------------------------------------------

    _showOutput(result) {
      this._model.setProperty("/output", {
        ...emptyOutput(),
        ...result,
        headers: result.headers || [],
        properties: result.properties || [],
        has: true
      });
      this._model.setProperty("/outputTab", result.success ? "body" : "error");
    },

    onRun() {
      const input = this._model.getProperty("/input");
      return this._run(async () => {
        const result = await this._request("run", "POST", {
          script: this._content(),
          payload: this.byId("inputBodyEditor").getCurrentValue(),
          headers: cleanList(input.headers),
          properties: cleanList(input.properties)
        });
        this._showOutput(result);
      });
    },

    onAddEntry(event) {
      const path = `/input/${event.getSource().data("list")}`;
      this._model.setProperty(path, [...this._model.getProperty(path), { name: "", value: "" }]);
    },

    onRemoveEntry(event) {
      const path = `/input/${event.getSource().data("list")}`;
      const row = event.getSource().getBindingContext("view").getObject();
      this._model.setProperty(path, this._model.getProperty(path).filter((r) => r !== row));
    },

    // ---- test cases -------------------------------------------------------------------------------------

    onLoadTestCase(event) {
      const tc = event.getSource().getBindingContext("view").getObject();
      this._setInput({ body: tc.payload || "", headers: parseList(tc.headers), properties: parseList(tc.properties) });
      this._model.setProperty("/loadedTestCaseId", tc.ID);
      this._model.setProperty("/inputTab", "body");
      MessageToast.show(this._text("testCaseLoaded", tc.name));
    },

    onOpenTestCaseDialog() {
      const loaded = this._model.getProperty("/testCases").find((tc) => tc.ID === this._model.getProperty("/loadedTestCaseId"));
      this._model.setProperty("/testCase", loaded
        ? { name: loaded.name, compareMode: loaded.compareMode || "TRIMMED" }
        : { name: "", compareMode: "TRIMMED" });
      this._setExpected(loaded ? loaded.expectedBody || "" : "");
      this.byId("testCaseDialog").open();
    },

    onUseLastOutput() {
      this._setExpected(this._model.getProperty("/output/body"));
    },

    onExpectedLiveChange() {
      this._later("expected", () => this._setIfChanged("/testCase/expectedType", formatter.bodyType(this.byId("expectedEditor").getCurrentValue())));
    },

    onSaveTestCase(event) {
      const mode = event.getSource().data("mode");
      const tc = this._model.getProperty("/testCase");
      const input = this._model.getProperty("/input");
      const data = {
        name: tc.name.trim(),
        compareMode: tc.compareMode,
        expectedBody: this.byId("expectedEditor").getCurrentValue() || null,
        payload: this.byId("inputBodyEditor").getCurrentValue() || null,
        headers: JSON.stringify(cleanList(input.headers)),
        properties: JSON.stringify(cleanList(input.properties))
      };
      this.byId("testCaseDialog").close();
      return this._run(async () => {
        const scriptId = this._model.getProperty("/script/ID");
        const loadedId = this._model.getProperty("/loadedTestCaseId");
        const saved = mode === "update"
          ? await this._request(`TestCases(${loadedId})`, "PATCH", data)
          : await this._request(`Scripts(${scriptId})/testCases`, "POST", data);
        await this._reloadTestCases();
        this._model.setProperty("/loadedTestCaseId", saved.ID);
        MessageToast.show(this._text("saved"));
      });
    },

    async _reloadTestCases() {
      const previous = new Map(this._model.getProperty("/testCases").map((tc) => [tc.ID, tc]));
      const scriptId = this._model.getProperty("/script/ID");
      const result = await this._request(`Scripts(${scriptId})/testCases?$orderby=name`);
      this._model.setProperty("/testCases", result.value.map((tc) => ({
        ...tc,
        lastStatus: previous.has(tc.ID) ? previous.get(tc.ID).lastStatus : null,
        lastResult: previous.has(tc.ID) ? previous.get(tc.ID).lastResult : null
      })));
    },

    onDeleteTestCase(event) {
      const tc = event.getSource().getBindingContext("view").getObject();
      MessageBox.confirm(this._text("confirmDeleteTestCase", tc.name), {
        onClose: (action) => {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          this._run(async () => {
            await this._request(`TestCases(${tc.ID})`, "DELETE");
            if (this._model.getProperty("/loadedTestCaseId") === tc.ID) {
              this._model.setProperty("/loadedTestCaseId", null);
            }
            await this._reloadTestCases();
          });
        }
      });
    },

    onRunTests() {
      return this._runTests([]);
    },

    onRunTestCase(event) {
      return this._runTests([event.getSource().getBindingContext("view").getProperty("ID")]);
    },

    _runTests(testCaseIds) {
      return this._run(async () => {
        const result = await this._request("runTests", "POST", {
          scriptId: this._model.getProperty("/script/ID"),
          script: this._content(),
          testCaseIds
        });
        const byId = new Map(result.value.map((r) => [r.testCaseId, r]));
        const testCases = this._model.getProperty("/testCases").map((tc) => byId.has(tc.ID)
          ? { ...tc, lastStatus: byId.get(tc.ID).status, lastResult: byId.get(tc.ID).result }
          : tc);
        this._model.setProperty("/testCases", testCases);
        const count = (status) => result.value.filter((r) => r.status === status).length;
        this._model.setProperty("/testSummary", this._text("testSummary",
          result.value.length, count("PASSED"), count("FAILED"), count("ERROR"), count("NO_EXPECTATION")));
        if (result.value.length === 1) {
          this._showOutput(result.value[0].result);
        }
      });
    },

    onShowTestResult(event) {
      const tc = event.getSource().getBindingContext("view").getObject();
      if (!tc.lastResult) {
        return;
      }
      this._showOutput(tc.lastResult);
      if (tc.lastStatus === "FAILED") {
        this._model.setProperty("/diff", {
          title: this._text("diffExpected", tc.name),
          html: diff.toHtml(diff.diffLines(tc.expectedBody || "", tc.lastResult.body || ""))
        });
        this.byId("diffDialog").open();
      }
    },

    // ---- versions ---------------------------------------------------------------------------------------

    async _loadVersions() {
      const id = this._model.getProperty("/script/ID");
      const result = await this._request(`Scripts(${id})/versions?$orderby=version desc`);
      this._model.setProperty("/versions", result.value);
    },

    onOpenVersions() {
      this._model.setProperty("/versionComment", "");
      return this._run(async () => {
        await this._loadVersions();
        this.byId("versionsDialog").open();
      });
    },

    onSaveVersion() {
      return this._run(async () => {
        const id = this._model.getProperty("/script/ID");
        const content = this._content();
        const version = await this._request(`Scripts(${id})/GroovyIdeService.saveVersion`, "POST", {
          comment: this._model.getProperty("/versionComment") || null,
          content
        });
        this._setContent(content, content);
        this._model.setProperty("/versionComment", "");
        await this._loadVersions();
        await this._loadScripts();
        MessageToast.show(this._text("versionSaved", version.version));
      });
    },

    onDiffVersion(event) {
      const version = event.getSource().getBindingContext("view").getObject();
      this._model.setProperty("/diff", {
        title: this._text("diffTitle", version.version),
        html: diff.toHtml(diff.diffLines(version.content || "", this._content()))
      });
      this.byId("diffDialog").open();
    },

    onRestoreVersion(event) {
      const version = event.getSource().getBindingContext("view").getObject();
      this._setContent(version.content || "");
      this.byId("versionsDialog").close();
      MessageToast.show(this._text("versionRestored", version.version));
    },

    onDeleteVersion(event) {
      const version = event.getSource().getBindingContext("view").getObject();
      MessageBox.confirm(this._text("confirmDeleteVersion", version.version), {
        onClose: (action) => {
          if (action === MessageBox.Action.OK) {
            this._run(async () => {
              await this._request(`ScriptVersions(${version.ID})`, "DELETE");
              await this._loadVersions();
            });
          }
        }
      });
    },

    // ---- download from CPI (DEV) ------------------------------------------------------------------------

    onOpenImport() {
      if (!this._model.getProperty("/import/packages")) {
        this._model.setProperty("/import", { packages: [], artifacts: [], files: [] });
        this._loadImportPackages();
      }
      this.byId("importDialog").open();
    },

    async _importRun(fn) {
      this._model.setProperty("/import/busy", true);
      this._model.setProperty("/import/error", "");
      try {
        await fn();
      } catch (e) {
        this._model.setProperty("/import/error", this._text("requestFailed", e.message));
      } finally {
        this._model.setProperty("/import/busy", false);
      }
    },

    _loadImportPackages() {
      return this._importRun(async () => {
        this._model.setProperty("/import/packages", (await this._request("listPackages()")).value);
      });
    },

    onImportReload() {
      this._model.setProperty("/import", { packages: [], artifacts: [], files: [] });
      return this._loadImportPackages();
    },

    onImportPackageChange() {
      const packageId = this._model.getProperty("/import/packageId");
      this._model.setProperty("/import/artifacts", []);
      this._model.setProperty("/import/artifactKey", "");
      this._model.setProperty("/import/files", []);
      this._model.setProperty("/import/selected", null);
      this._model.setProperty("/import/preview", "");
      if (!packageId) {
        return undefined;
      }
      return this._importRun(async () => {
        const result = await this._request(`listArtifacts(packageId='${escapeLiteral(packageId)}')`);
        this._model.setProperty("/import/artifacts", result.value.map((a) => ({
          ...a,
          key: `${a.type}:${a.id}`,
          typeText: this._text(`type${a.type}`)
        })));
      });
    },

    onImportArtifactChange() {
      const key = this._model.getProperty("/import/artifactKey");
      const artifact = this._model.getProperty("/import/artifacts").find((a) => a.key === key);
      this._model.setProperty("/import/files", []);
      this._model.setProperty("/import/selected", null);
      this._model.setProperty("/import/preview", "");
      if (!artifact) {
        return undefined;
      }
      return this._importRun(async () => {
        const packageId = this._model.getProperty("/import/packageId");
        const result = await this._request(`listArtifactScripts(packageId='${escapeLiteral(packageId)}',type='${artifact.type}',artifactId='${escapeLiteral(artifact.id)}')`);
        this._model.setProperty("/import/artifact", result);
        this._model.setProperty("/import/files", result.scripts.map((s) => {
          const parts = s.path.split("/");
          return { ...s, file: parts.pop(), folder: parts.join("/") };
        }));
      });
    },

    onImportFileSelect(event) {
      const file = event.getParameter("listItem").getBindingContext("view").getObject();
      this._model.setProperty("/import/selected", file);
      this._model.setProperty("/import/preview", file.content);
    },

    async onImport() {
      const file = this._model.getProperty("/import/selected");
      const artifact = this._model.getProperty("/import/artifact");
      if (!file || !(await this._confirmDiscard())) {
        return;
      }
      this.byId("importDialog").close();
      await this._run(async () => {
        const created = await this._request("Scripts", "POST", {
          name: `${file.file} (${artifact.artifactName})`.slice(0, 120),
          sourceType: artifact.type,
          sourceTenant: "DEV",
          sourcePackageId: artifact.packageId,
          sourceArtifactId: artifact.artifactId,
          sourceArtifactName: artifact.artifactName,
          sourceArtifactVersion: artifact.version,
          sourcePath: file.path,
          content: file.content
        });
        await this._loadScripts();
        await this._openScript(created.ID);
        MessageToast.show(this._text("imported", file.file));
      });
    }
  });
});
