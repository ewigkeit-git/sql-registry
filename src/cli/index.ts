#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { SqlRegistry, SqlRegistryValidationError } from "../lib/sql-registry";

type ValidateOptions = {
  dialect?: string;
  json: boolean;
  strict: boolean;
};

type ValidateResult = {
  ok: boolean;
  files: string[];
  queries: string[];
  errors: string[];
};

function usage() {
  return [
    "Usage:",
    "  sql-registry validate [options] <file-or-directory...>",
    "",
    "Options:",
    "  --dialect <name>  Validate with a dialect alias such as sqlite, mysql, or pg",
    "  --json            Print machine-readable JSON",
    "  --no-strict       Keep loading after validation errors when possible",
    "  -h, --help        Show help",
    "  -v, --version     Show version"
  ].join("\n");
}

function getVersion() {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
    );
    return String(packageJson.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function isMarkdownFile(filePath: string) {
  return [".md", ".markdown"].includes(path.extname(filePath).toLowerCase());
}

function collectMarkdownFiles(inputPath: string, errors: string[], files: string[] = []) {
  const fullPath = path.resolve(inputPath);

  if (!fs.existsSync(fullPath)) {
    errors.push(`path not found: ${fullPath}`);
    return files;
  }

  const stat = fs.statSync(fullPath);
  if (stat.isFile()) {
    files.push(fullPath);
    return files;
  }

  if (!stat.isDirectory()) {
    errors.push(`path is not a file or directory: ${fullPath}`);
    return files;
  }

  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    const entryPath = path.join(fullPath, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(entryPath, errors, files);
    } else if (entry.isFile() && isMarkdownFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

export function validate(paths: string[], options: ValidateOptions): ValidateResult {
  const errors: string[] = [];
  const files = paths.flatMap(inputPath => collectMarkdownFiles(inputPath, errors));
  const uniqueFiles = [...new Set(files)].sort();
  const registry = new SqlRegistry({
    dialect: options.dialect,
    strict: options.strict
  });

  if (uniqueFiles.length === 0) {
    errors.push("no markdown registry files found");
  }

  for (const filePath of uniqueFiles) {
    try {
      registry.loadFile(filePath);
    } catch (err: unknown) {
      if (err instanceof SqlRegistryValidationError) {
        errors.push(...err.errors);
      } else if (err instanceof Error) {
        errors.push(err.message);
      } else {
        errors.push(String(err));
      }
    }
  }

  return {
    ok: errors.length === 0,
    files: registry.files.length > 0 ? registry.files : uniqueFiles,
    queries: registry.list(),
    errors
  };
}

function parseArgs(argv: string[]) {
  const options: ValidateOptions = {
    json: false,
    strict: true
  };
  const paths: string[] = [];
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      return { help: true, version: false, command, paths, options };
    }

    if (arg === "-v" || arg === "--version") {
      return { help: false, version: true, command, paths, options };
    }

    if (!command) {
      command = arg;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--no-strict") {
      options.strict = false;
      continue;
    }

    if (arg === "--dialect") {
      const dialect = argv[++i];
      if (!dialect) {
        throw new Error("--dialect requires a value");
      }
      options.dialect = dialect;
      continue;
    }

    if (arg.startsWith("--dialect=")) {
      options.dialect = arg.slice("--dialect=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }

    paths.push(arg);
  }

  return { help: false, version: false, command, paths, options };
}

export function run(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  let parsed: ReturnType<typeof parseArgs>;

  try {
    parsed = parseArgs(argv);
  } catch (err: unknown) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}\n`);
    return 2;
  }

  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (parsed.version) {
    stdout.write(`${getVersion()}\n`);
    return 0;
  }

  if (parsed.command !== "validate" || parsed.paths.length === 0) {
    stderr.write(`${usage()}\n`);
    return 2;
  }

  const result = validate(parsed.paths, parsed.options);

  if (parsed.options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    stdout.write(`ok - ${result.files.length} file(s), ${result.queries.length} query(ies)\n`);
  } else {
    stderr.write("sql-registry validate failed\n");
    for (const error of result.errors) {
      stderr.write(`- ${error}\n`);
    }
  }

  return result.ok ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = run();
}
