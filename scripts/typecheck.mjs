#!/usr/bin/env node
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPiInstall } from "./host-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
try {
	const compiler = process.env.PI_TYPESCRIPT_PATH ?? require.resolve("typescript");
	const imported = await import(pathToFileURL(path.resolve(compiler)).href);
	const ts = imported.default ?? imported;
	const install = findPiInstall();
	const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, String.fromCharCode(10)));
	const hostTypes = path.join(install.root, "@earendil-works");
	config.config.compilerOptions = {
		...config.config.compilerOptions,
		noEmit: true,
		typeRoots: [path.join(root, "node_modules", "@types"), path.join(install.root, "@types")],
		paths: {
			"@earendil-works/pi-coding-agent": [path.join(hostTypes, "pi-coding-agent", "dist", "index.d.ts")],
			"@earendil-works/pi-tui": [path.join(hostTypes, "pi-tui", "dist", "index.d.ts")],
			"@earendil-works/pi-ai": [path.join(hostTypes, "pi-ai", "dist", "index.d.ts")],
			typebox: [path.join(install.root, "typebox", "build", "index.d.mts")],
		},
	};
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
	const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
	const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
	if (diagnostics.length) {
		process.stderr.write(ts.formatDiagnostics(diagnostics, {
			getCurrentDirectory: () => root,
			getCanonicalFileName: file => file,
			getNewLine: () => String.fromCharCode(10),
		}));
		process.exitCode = 1;
	} else {
		console.log("Typecheck passed (Pi " + install.versions.at(-1) + ", TypeScript " + ts.version + ")");
	}
} catch (error) {
	console.error("Typecheck failed: " + (error instanceof Error ? error.message : String(error)));
	console.error("Use the checkout's TypeScript dev dependency, or set PI_TYPESCRIPT_PATH to an existing typescript/lib/typescript.js.");
	process.exitCode = 1;
}
