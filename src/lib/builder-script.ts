const ts = require("typescript");

export function transpileBuilderScript(code: string) {
  if (!code || !code.trim()) return code;

  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      removeComments: false
    }
  }).outputText;
}
