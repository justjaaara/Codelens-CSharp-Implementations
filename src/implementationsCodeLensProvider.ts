import * as vscode from "vscode";

const CONFIG_SECTION = "csharpImplementationsCodeLens";

const CANDIDATE_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Property,
]);

/** CodeLens that remembers the document it was produced for, so `resolveCodeLens`
 * can query providers without a second symbol lookup. */
class ImplLens extends vscode.CodeLens {
  constructor(range: vscode.Range, public readonly uri: vscode.Uri) {
    super(range);
  }
}

interface Settings {
  enabled: boolean;
  minCount: number;
  maxFileLines: number;
}

function readSettings(uri: vscode.Uri): Settings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
  return {
    enabled: cfg.get<boolean>("enabled", true),
    minCount: cfg.get<number>("minCount", 1),
    maxFileLines: cfg.get<number>("maxFileLines", 2000),
  };
}

function flattenSymbols(symbols: vscode.DocumentSymbol[], out: vscode.DocumentSymbol[]): void {
  for (const symbol of symbols) {
    if (CANDIDATE_KINDS.has(symbol.kind)) {
      out.push(symbol);
    }
    if (symbol.children?.length) {
      flattenSymbols(symbol.children, out);
    }
  }
}

function toLocations(raw: unknown): vscode.Location[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: vscode.Location[] = [];
  for (const item of raw) {
    if (item instanceof vscode.Location) {
      result.push(item);
    } else if (item && typeof item === "object" && "targetUri" in item) {
      const link = item as vscode.LocationLink;
      result.push(new vscode.Location(link.targetUri, link.targetSelectionRange ?? link.targetRange));
    }
  }
  return result;
}

export class ImplementationsCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          this.emitter.fire();
        }
      }),
    );
  }

  /** Call once C# Dev Kit has warmed up so lenses that resolved to nothing get retried. */
  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const settings = readSettings(document.uri);
    if (!settings.enabled || document.lineCount > settings.maxFileLines) {
      return [];
    }

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      document.uri,
    );
    if (token.isCancellationRequested || !symbols?.length) {
      return [];
    }

    const flat: vscode.DocumentSymbol[] = [];
    flattenSymbols(symbols, flat);

    return flat.map((symbol) => new ImplLens(symbol.selectionRange, document.uri));
  }

  async resolveCodeLens(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens> {
    if (!(codeLens instanceof ImplLens)) {
      return this.blank(codeLens);
    }

    try {
      const settings = readSettings(codeLens.uri);
      const raw = await vscode.commands.executeCommand(
        "vscode.executeImplementationProvider",
        codeLens.uri,
        codeLens.range.start,
      );
      if (token.isCancellationRequested) {
        return this.blank(codeLens);
      }

      const locations = toLocations(raw).filter(
        (loc) =>
          !(
            loc.uri.toString() === codeLens.uri.toString() &&
            loc.range.start.isEqual(codeLens.range.start)
          ),
      );

      const count = locations.length;
      if (count < settings.minCount) {
        return this.blank(codeLens);
      }

      codeLens.command = {
        title: `${count} implementation${count === 1 ? "" : "s"}`,
        command: "editor.action.peekLocations",
        arguments: [codeLens.uri, codeLens.range.start, locations, "peek"],
      };
      return codeLens;
    } catch (err) {
      console.error("[csharp-implementations-codelens] resolve failed", err);
      return this.blank(codeLens);
    }
  }

  private blank(codeLens: vscode.CodeLens): vscode.CodeLens {
    codeLens.command = { title: "", command: "" };
    return codeLens;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
