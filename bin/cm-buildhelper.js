#!/usr/bin/env node

const {build} = require("@marijn/buildtool")
const {resolve} = require("path")
const {lezer} = require("@lezer/generator/rollup")

let args = process.argv.slice(2)

if (args.length != 1) {
  console.log("Usage: cm-buildhelper src/mainfile.ts")
  process.exit(1)
}

build(resolve(args[0]), {
  expandLink: "https://codemirror.net/6/docs/ref/#",
  pureTopCalls: true,
//  outputPlugin: () => lezer()
}).then(result => {
  if (!result) process.exit(1)
})
