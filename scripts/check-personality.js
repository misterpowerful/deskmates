// Usage: npm run check-personality [-- <name>]
import { listPersonalities, readConfig } from "../src/config.js";
import { runCoverageCheck } from "../src/personalityCoverage.js";

const { output, exitCode } = runCoverageCheck({
  names: process.argv.slice(2),
  all: listPersonalities(),
  active: readConfig().active_personality,
});
console.log(output);
process.exitCode = exitCode;
