import * as vscode from "vscode";
import { ImplementationsCodeLensProvider } from "./implementationsCodeLensProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ImplementationsCodeLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "csharp" }, provider),
    provider,
  );

  // C# Dev Kit's implementation provider returns nothing until the solution has
  // loaded. Re-fire the lenses a few times after activation so early "0" results
  // get retried once the language service is warm.
  const retries = [3000, 8000, 20000];
  for (const delay of retries) {
    const handle = setTimeout(() => provider.refresh(), delay);
    context.subscriptions.push(new vscode.Disposable(() => clearTimeout(handle)));
  }

  // Also refresh the first time C# diagnostics arrive (a decent "service is up" signal).
  const diagSub = vscode.languages.onDidChangeDiagnostics((e) => {
    if (e.uris.some((u) => u.path.endsWith(".cs"))) {
      provider.refresh();
      diagSub.dispose();
    }
  });
  context.subscriptions.push(diagSub);
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}
