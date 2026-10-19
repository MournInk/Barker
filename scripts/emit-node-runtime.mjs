import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const outputDir = ".barker-node";
const files = ["auth", "bark", "cron", "db", "http", "scheduler", "types", "validation"];
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "package.json"), '{ "type": "module", "private": true }\n');

function emit(sourcePath, outputName) {
  const source = readFileSync(sourcePath, "utf8")
    .replaceAll('from "../lib/', 'from "./')
    .replaceAll('from "./lib/', 'from "./')
    .replaceAll(/from "(\.\/[^"]+)"/g, 'from "$1.js"');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, "\n"));
  writeFileSync(join(outputDir, outputName), outputText);
}

for (const file of files) emit(join("lib", `${file}.ts`), `${file}.js`);
emit("instrumentation.node.ts", "register.js");
