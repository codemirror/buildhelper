#!/usr/bin/env node

const {resolve} = require("path")
const {gatherTests, runTests} = require("../src/runtests")

function help(exit = 1) {
  console.log("Usage: cm-runtests [--chrome] [--firefox] [... dirs]")
  process.exit(exit)
}

let dirs = [], browsers = [], grep = null
for (let i = 2, arg; (arg = process.argv[i]) != null; i++) {
  if (arg == "--chrome") browsers.push("chrome")
  else if (arg == "--firefox") browsers.push("firefox")
  else if (arg == "--help") exit(0)
  else if (arg == "--grep") grep = process.argv[++i]
  else if (arg[0] == "-") help()
  else dirs.push(resolve(arg))
}
if (!dirs.length) dirs.push(".")
if (!browsers.length) browsers.push("chrome")

let {tests, browserTests} = gatherTests(dirs)

if (!tests.length && !browserTests.length) {
  console.log("No tests")
  process.exit(0)
}

runTests({tests, browserTests, grep, browsers}).then(failed => process.exit(failed ? 1 : 0))
