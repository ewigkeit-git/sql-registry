const ts = require("typescript");

export type TranspileBuilderScriptOptions = {
  throwOnDiagnostics?: boolean;
};

function formatDiagnostic(diagnostic: any) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

export function transpileBuilderScript(code: string, options: TranspileBuilderScriptOptions = {}) {
  if (!code || !code.trim()) return code;

  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      removeComments: false
    },
    reportDiagnostics: options.throwOnDiagnostics === true
  });

  if (options.throwOnDiagnostics && result.diagnostics && result.diagnostics.length > 0) {
    throw new Error(result.diagnostics.map(formatDiagnostic).join("; "));
  }

  return result.outputText;
}
