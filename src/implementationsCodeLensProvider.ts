import * as vscode from "vscode";

const CONFIG_SECTION = "csharpImplementationsCodeLens";

/** How long a cached implementation lookup stays valid without an explicit
 * invalidation event (backstop for re-indexing, external git checkouts, etc.). */
const CACHE_TTL_MS = 60_000;

/** Upper bound on cache entries so a long session can't grow it without limit. */
const MAX_CACHE_ENTRIES = 500;

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

interface CacheEntry {
  locations: vscode.Location[];
  ts: number;
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

  /** Keyed by `${uri}#${line}:${char}`. Only non-empty results are stored, so a
   * lens that resolved to nothing during C# Dev Kit warmup is retried later. */
  private readonly cache = new Map<string, CacheEntry>();

  constructor() {
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          this.invalidateAll();
        }
      }),
      // A save anywhere in the solution can add or remove an implementer.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId === "csharp") {
          this.invalidateAll();
        }
      }),
      // Drop per-file entries when the editor closes to keep the map small.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.invalidateUri(doc.uri);
      }),
    );

    // New / deleted / renamed .cs files change the implementer set too.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.cs");
    watcher.onDidCreate(() => this.invalidateAll());
    watcher.onDidDelete(() => this.invalidateAll());
    this.disposables.push(watcher);
  }

  /** Re-fire lenses without clearing the cache (used for Dev Kit warmup retries). */
  refresh(): void {
    this.emitter.fire();
  }

  private invalidateAll(): void {
    this.cache.clear();
    this.emitter.fire();
  }

  private invalidateUri(uri: vscode.Uri): void {
    const prefix = `${uri.toString()}#`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private cacheKey(uri: vscode.Uri, position: vscode.Position): string {
    return `${uri.toString()}#${position.line}:${position.character}`;
  }

  private getCached(key: string): vscode.Location[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.locations;
  }

  private setCached(key: string, locations: vscode.Location[]): void {
    // Don't cache empty results — the language service may still be warming up.
    if (locations.length === 0) {
      return;
    }
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, { locations, ts: Date.now() });
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
      const key = this.cacheKey(codeLens.uri, codeLens.range.start);

      let locations = this.getCached(key);
      if (!locations) {
        const raw = await vscode.commands.executeCommand(
          "vscode.executeImplementationProvider",
          codeLens.uri,
          codeLens.range.start,
        );
        if (token.isCancellationRequested) {
          return this.blank(codeLens);
        }
        locations = toLocations(raw).filter(
          (loc) =>
            !(
              loc.uri.toString() === codeLens.uri.toString() &&
              loc.range.start.isEqual(codeLens.range.start)
            ),
        );
        this.setCached(key, locations);
      }

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
    this.cache.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
