import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function pathsFor(root, versions) {
	return {
		root, versions,
		jiti: path.join(root, "jiti", "lib", "jiti.mjs"),
		typebox: path.join(root, "typebox", "build", "index.mjs"),
		piCodingAgent: path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
		piTui: path.join(root, "@earendil-works", "pi-tui", "dist", "index.js"),
		piAiValidation: path.join(root, "@earendil-works", "pi-ai", "dist", "utils", "validation.js"),
		piSchema: path.join(root, "@earendil-works", "pi-schema", "dist", "index.js"),
	};
}

/** Locate local peer dependencies, or the selected/latest installed Pi release. */
export function findPiInstall() {
	const override = process.env.PI_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	if (!override) {
		try {
			const entry = require.resolve("@earendil-works/pi-coding-agent");
			const root = path.resolve(path.dirname(entry), "..", "..", "..");
			const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry), "..", "package.json"), "utf8"));
			const install = pathsFor(root, [manifest.version]);
			if (fs.existsSync(install.jiti) && fs.existsSync(install.typebox) && fs.existsSync(install.piTui)) return install;
		} catch {
			// A checkout without installed peer dependencies can use Pi's release.
		}
	}
	const agentDir = override ?? path.join(os.homedir(), ".pi", "agent");
	const releases = path.join(agentDir, "install", "releases");
	const versions = (fs.existsSync(releases) ? fs.readdirSync(releases) : [])
		.filter(name => fs.existsSync(path.join(releases, name, "node_modules", "jiti", "lib", "jiti.mjs")))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	if (!versions.length) throw new Error("No Pi installation found. Install the project peer dependencies or set PI_AGENT_DIR to the agent directory containing install/releases.");
	return pathsFor(path.join(releases, versions.at(-1), "node_modules"), versions);
}
