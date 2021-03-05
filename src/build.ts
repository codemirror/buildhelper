import * as ts from "typescript"
import {join, dirname, basename, resolve} from "path"
import * as fs from "fs"
import {rollup, RollupBuild} from "rollup"
import dts from "rollup-plugin-dts"

const pkgCache = Object.create(null)

function tsFiles(dir: string) {
  return fs.readdirSync(dir).filter(f => /(?<!\.d)\.ts$/.test(f)).map(f => join(dir, f))
}

class Package {
  readonly root: string
  readonly files: readonly string[]
  readonly tests: readonly string[]
  readonly json: any

  constructor(readonly main: string) {
    let parent = dirname(main), root = dirname(parent), tests = join(root, "test")
    this.root = root
    this.tests = fs.existsSync(tests) ? tsFiles(tests) : []
    this.files = tsFiles(parent).concat(this.tests)
    this.json = JSON.parse(fs.readFileSync(join(this.root, "package.json"), "utf8"))
  }

  static get(main: string) {
    return pkgCache[main] || (pkgCache[main] = new Package(main))
  }
}

const tsOptions: ts.CompilerOptions = {
  lib: ["lib.es6.d.ts", "lib.scripthost.d.ts", "lib.dom.d.ts"],
  types: ["mocha"],
  stripInternal: true,
  noUnusedLocals: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ES2020,
  newLine: ts.NewLineKind.LineFeed,
  declaration: true,
  moduleResolution: ts.ModuleResolutionKind.NodeJs
}

function optionsWithPaths(pkgs: readonly Package[]): ts.CompilerOptions {
  let paths: ts.MapLike<string[]> = {}
  for (let pkg of pkgs) paths[pkg.json.name] = [pkg.main]
  return {paths, ...tsOptions}
}

class Output {
  files: {[name: string]: string} = Object.create(null)
  changed: string[] = []
  watchers: ((changed: readonly string[]) => void)[] = []
  watchTimeout: any = null

  constructor() { this.write = this.write.bind(this) }

  write(path: string, content: string) {
    if (this.files[path] == content) return
    this.files[path] = content
    if (!this.changed.includes(path)) this.changed.push(path)
    if (this.watchTimeout) clearTimeout(this.watchTimeout)
    if (this.watchers.length) this.watchTimeout = setTimeout(() => {
      this.watchers.forEach(w => w(this.changed))
      this.changed = []
    }, 100)
  }
}

function readAndMangleComments(files: readonly string[]) {
  let fileMap = Object.create(null)
  for (let f of files) fileMap[f] = true
  return (name: string) => {
    let file = ts.sys.readFile(name)
    if (file && fileMap[name])
      return file.replace(/(?:([ \t]*)\/\/\/.*\n)+/g, (comment, space) => {
        comment = comment.replace(/\]\(#/g, "](https://codemirror.net/6/docs/ref/#")
        return `${space}/**\n${space}${comment.slice(space.length).replace(/\/\/\/ ?/g, "")}${space}*/\n`
      })
    return file
  }
}

function runTS(files: readonly string[], options = tsOptions) {
  let host = Object.assign({}, ts.createCompilerHost(options), {readFile: readAndMangleComments(files)})
  let program = ts.createProgram({rootNames: files, options: options, host})
  let out = new Output, result = program.emit(undefined, out.write)
  return result.emitSkipped ? null : out
}

const tsFormatHost = {
  getCanonicalFileName: (path: string) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n"
}

function watchTS(files: readonly string[], options = tsOptions) {
  let out = new Output, sys = Object.assign({}, ts.sys, {
    writeFile: out.write,
    readFile: readAndMangleComments(files)
  })
  ts.createWatchProgram(ts.createWatchCompilerHost(
    files as string[], options, sys, 
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    diag => console.error(ts.formatDiagnostic(diag, tsFormatHost)),
    diag => console.info(ts.flattenDiagnosticMessageText(diag.messageText, "\n"))
  ))
  return out
}

function external(id: string) { return id != "tslib" && !/^(\.?\/|\w:)/.test(id) }

function resolveOutput(output: Output, ext: string) {
  return {
    name: "resolve-ts-output",
    resolveId(source: string, base: string | undefined) {
      let full = base && source[0] == "." ? resolve(dirname(base), source) : source
      if (!/\.\w+$/.test(full)) full += ext
      if (output.files[full]) return full
    }
  }
}

function loadOutput(output: Output) {
  return {
    name: "load-ts-output",
    load(file: string) { return output.files[file] }
  }
}

async function emit(bundle: RollupBuild, conf: any) {
  let result = await bundle.generate(conf)
  let dir = dirname(conf.file)
  await fs.promises.mkdir(dir, {recursive: true}).catch(() => null)
  for (let file of result.output)
    await fs.promises.writeFile(join(dir, file.fileName), (file as any).code || (file as any).source)
}

async function bundle(pkg: Package, compiled: Output) {
  let plugins = [resolveOutput(compiled, ".js"), loadOutput(compiled)]
  if ((pkg.json.devDependencies || {})["lezer-generator"])
    // @ts-ignore
    plugins.push((await import("lezer-generator/rollup")).lezer())
  let bundle = await rollup({
    input: pkg.main.replace(/\.ts$/, ".js"),
    external,
    plugins
  })
  let dist = join(pkg.root, "dist")
  await emit(bundle, {
    format: "esm",
    file: join(dist, "index.js"),
    externalLiveBindings: false
  })
  await emit(bundle, {
    format: "cjs",
    file: join(dist, "index.cjs")
  })

  // This is an awful kludge to get rollup-plugin-dts to read our
  // magic nonexistent files.
  let oldReadFile = ts.sys.readFile
  ts.sys.readFile = (file: string) => compiled.files[file] || oldReadFile(file)
  let tscBundle = await rollup({
    input: pkg.main.replace(/\.ts$/, ".d.ts"),
    plugins: [resolveOutput(compiled, ".d.ts"), dts()],
    onwarn(warning, warn) {
      if (warning.code != "CIRCULAR_DEPENDENCY" && warning.code != "UNUSED_EXTERNAL_IMPORT")
        warn(warning)
    }
  })
  ts.sys.readFile = oldReadFile
  await emit(tscBundle, {
    format: "esm",
    file: join(dist, "index.d.ts")
  })
}

export async function build(main: string) {
  let pkg = Package.get(main), compiled = runTS(pkg.files, optionsWithPaths([pkg]))
  if (!compiled) return false
  await bundle(pkg, compiled)
  return true
}

export function watch(mains: readonly string[], extra: readonly string[] = []) {
  let pkgs = mains.map(Package.get)
  let allFiles = pkgs.reduce((a, p) => a.concat(p.files), []).concat(extra)
  let out = watchTS(allFiles, optionsWithPaths(pkgs))
  let bundleAll = async (pkgs: readonly Package[]) => {
    console.log("Bundling " + pkgs.map(p => basename(p.root)).join(", "))
    await Promise.all(pkgs.map(p => bundle(p, out)))
    console.log("Bundling done.")
  }
  out.watchers.push(changed => {
    let changedPkgs: Package[] = [], changedFiles: string[] = []
    for (let file of changed) {
      if (extra.includes(file)) {
        changedFiles.push(file)
      } else {
        let root = dirname(dirname(file))
        let pkg = pkgs.find(p => p.root = root)
        if (!pkg) throw new Error("No package found for " + file)
        if (pkg.tests.includes(file)) changedFiles.push(file)
        else if (!changedPkgs.includes(pkg)) changedPkgs.push(pkg)
      }
    }
    for (let file of changedFiles) fs.writeFileSync(file, out.files[file])
    bundleAll(changedPkgs)
  })
  bundleAll(pkgs)
}
