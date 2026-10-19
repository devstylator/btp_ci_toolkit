# Groovy IDE

An editor for SAP Cloud Integration Groovy scripts, modelled on groovyide.com/cpi. Scripts run on a real CPI
runtime through a small **script-runner iFlow**. The design follows the blog
[CI based Script tester & ABAP Groovy IDE](https://community.sap.com/t5/technology-blog-posts-by-members/ci-based-script-tester-amp-abap-groovy-ide/ba-p/14317804).

| What | How |
|------|-----|
| Edit | Groovy editor (UI5 CodeEditor), input body / headers / properties, output body / headers / properties / console / error |
| Run | `Run` (Ctrl+Enter) posts the script and input to the runner iFlow; nothing is stored |
| Save | Scripts are stored in the app DB and shared by all users (`createdBy`/`modifiedBy` shown). `Save` (Ctrl+S) overwrites the working copy |
| Versions | `Versions` > `Save version`: immutable numbered snapshot with comment; compare with the editor (line diff), load into the editor, delete |
| Test cases | Input body/headers/properties plus an optional expected body (compare: trimmed, exact, JSON, XML). `Run all` runs the editor's script against them: passed / failed / error / ran |
| Download | `Download from CPI`: DEV package > iFlow or Script Collection > `.groovy` file, saved as a new script that records the artifact, version and path. **Read only: nothing is ever uploaded to CPI** |

Roles: `CiToolkitViewer` can open the IDE read only (browse, view, preview downloads). `CiToolkitDeveloper` can
create/edit/delete scripts, versions and test cases, download into the IDE and run scripts. `CiToolkitAdmin` configures the
executor but does not include Developer.

## 1. Deploy the script-runner iFlow (once)

> Security: the runner executes **any** Groovy code it receives with the runtime permissions of Cloud Integration
> (no sandbox). Deploy it only to an isolated development/trial tenant, never to production, and restrict access to it.

Build an iFlow with an HTTPS sender (address e.g. `/groovy/execute`, **CSRF protection off**, role
`ESBMessaging.send`) and these steps, as described in the blog:

1. **Decoder** (Groovy): parses the JSON request, sets headers and properties from `Name=Value;...`, puts the decoded
   payload into the body and keeps the Base64 script in property `inputScript`.
2. **Execute** (Groovy): decodes `inputScript`, runs it with `GroovyShell` and a `Binding` whose `out` is a `PrintWriter`
   (so `println` is captured), stores the output in property `consoleLog`.
3. **Wrapper** (Groovy): responds with JSON `{properties, headers, payload, console}`, each Base64 encoded,
   properties/headers as `name = value;`.
4. **Exception subprocess** (Groovy error handler): responds with HTTP **400** and `{properties, headers, payload, error}`.

The scripts are printed in the blog; the ABAP repository it links (github.com/devstylator/abapGroovyEditor) has the
complete solution. The toolkit uses this contract unchanged.

## 2. Configure the executor (Admin)

Create a service key for the Process Integration Runtime with plan **`integration-flow`** (role `ESBMessaging.send`)
in the subaccount of that tenant. Then, in the app: **Configuration** > tab **Script executor (Groovy IDE)** > `DEFAULT`
> *Edit*:

| Mode | Fields |
|------|--------|
| Direct credentials | **Endpoint URL** = full runtime URL of the iFlow, e.g. `https://<tenant>.it-cpi0xx-rt.cfapps.<region>.hana.ondemand.com/http/groovy/execute`; **Token URL** and **Client ID** from the service key; *Save*; *Set client secret* |
| BTP Destination | Destination name; the destination (HTTP, Internet, `OAuth2ClientCredentials`) has the **full endpoint URL** as its URL |

Switch on **Script execution enabled**, *Save*, then *Test executor*. The test runs a fixed one-line script and
expects its body back. Developers can run scripts only while the executor is enabled.

Downloads use the **DEV** connection (Management API, read only); configure DEV as described in the README.

## Runner contract and limitations

Request (POST, JSON, all values Base64): `inputScript`, `inputPayload`, `inputParams` (`Name=Value;...`),
`inputHdrs` (`Name=Value;...`). The app implements it in `srv/features/groovy-ide/contract.ts`.

- Header/property names and values must not contain `;` or `=`: the runner's decoder splits on them. The app rejects
  such input with a clear message instead of sending a truncated value.
- With an **empty input body**, the runner leaves the request JSON as the message body (the decoder only sets a
  non-empty payload). Enter a body when the script reads it.
- The response property list hides the runner's own `inputScript`/`consoleLog`; everything else the script (or CPI)
  set is shown.
- HTTP 400 with an `error` field is a Groovy error (shown in the *Error* tab, the run counts as failed). Other
  statuses (401/403 credentials or role, 404 wrong URL / iFlow not deployed, 5xx) are reported as runner errors.
- Run time limit: 60 s per call. Test cases run one after another.
