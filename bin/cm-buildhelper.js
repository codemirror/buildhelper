#!/usr/bin/env node

const {build, defaultBuildOptions} = require("../src/build.js")
const {resolve} = require("path")

let args = process.argv.slice(2)

if (args.length == 0) {
  console.log("Usage: cm-buildhelper src/mainfile.ts [--source-map] [--disable-pure-annotations]")
  process.exit(1)
}

const filePath = resolve(args[0])
const buildOptions = {...defaultBuildOptions}
for (const arg of args.slice(1)) {
  switch (arg) {
    case "--disable-pure-annotations":
      buildOptions.addPureAnnotations = false
      break
    case "--source-map":
      buildOptions.sourceMap = true
      break
  }
}

build(filePath, buildOptions).then(result => {
  if (!result) process.exit(1)
})
