import { appendFileSync, realpathSync } from "node:fs";
import { EOL } from "node:os";

const workspace = process.env.GITHUB_WORKSPACE;
if (!workspace) {
  throw new Error("GITHUB_WORKSPACE is required to resolve the CI workspace.");
}

const canonicalWorkspace = realpathSync.native(workspace);
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  appendFileSync(outputFile, `path=${canonicalWorkspace}${EOL}`, "utf8");
} else {
  process.stdout.write(`${canonicalWorkspace}${EOL}`);
}
