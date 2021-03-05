import * as ts from "typescript"
import {join, dirname, basename, resolve} from "path"
import * as fs from "fs"
import {rollup, RollupBuild} from "rollup"
import dts from "rollup-plugin-dts"

const pkgCache = Object.create(null)

class Package {
  readonly root: string
  readonly files: readonly string[]
  readonly json: any

  constructor(readonly main: string) {
    let parent = dirname(main)
    this.root = dirname(parent)
    this.files = fs.readdirSync(parent).filter(f => /(?<!\.d)\.ts$/.test(f)).map(f => join(parent, f))
    this.json = JSON.parse(fs.readFileSync(join(this.root, "package.json"), "utf8"))
  }

  static get(main: string) {
    return pkgCache[main] || (pkgCache[main] = new Package(main))
  }
}

const tsOptions: ts.CompilerOptions = {
  lib: ["lib.es6.d.ts", "lib.dom.d.ts", "lib.scripthost.d.ts"],
  stripInternal: true,
  noUnusedLocals: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ES2020,
  newLine: ts.NewLineKind.LineFeed,
  declaration: true,
  moduleResolution: ts.ModuleResolutionKind.NodeJs
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
  return (name: string) => {
    let file = ts.sys.readFile(name)
    if (file && files.includes(name))
      return file.replace(/(?:([ \t]*)\/\/\/.*\n)+/g, (comment, space) => {
        comment = comment.replace(/\]\(#/g, "](https://codemirror.net/6/docs/ref/#")
        return `${space}/**\n${space}${comment.slice(space.length).replace(/\/\/\/ ?/g, "")}${space}*/\n`
      })
    return file
  }
}

export function runTS(main: string) {
  let pkg = Package.get(main)
  let host = Object.assign({}, ts.createCompilerHost(tsOptions), {readFile: readAndMangleComments(pkg.files)})
  let program = ts.createProgram({rootNames: pkg.files, options: tsOptions, host})
  let out = new Output, result = program.emit(undefined, out.write)
  return result.emitSkipped ? null : out
}

const tsFormatHost = {
  getCanonicalFileName: (path: string) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n"
}

export function watchTS(mains: readonly string[]) {
  let pkgs = mains.map(f => Package.get(f)), files = pkgs.reduce((f, p) => f.concat(p.files), [])
  let out = new Output, sys = Object.assign({}, ts.sys, {
    writeFile: out.write,
    readFile: readAndMangleComments(files)
  })
  ts.createWatchProgram(ts.createWatchCompilerHost(
    files, tsOptions, sys, 
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

export async function bundle(main: string, compiled: Output) {
  let pkg = Package.get(main), plugins = [resolveOutput(compiled, ".js"), loadOutput(compiled)]
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
    onwarn(warning, warn) { if (warning.code != "CIRCULAR_DEPENDENCY") warn(warning) }
  })
  ts.sys.readFile = oldReadFile
  await emit(tscBundle, {
    format: "esm",
    file: join(dist, "index.d.ts")
  })
}

export async function build(main: string) {
  let pkg = Package.get(main), compiled = runTS(pkg)
  if (!compiled) return false
  await bundle(pkg, compiled)
  return true
}

export function watchBuild(mains: readonly string[]) {
  let pkgs = mains.map(Package.get), out = watchTS(mains)
  let bundleAll = (pkgs: readonly Package[]) => {
    console.log("Bundling " + pkgs.map(p => basename(p.root)).join(", "))
    for (let pkg of pkgs) bundle(pkg.main, out)
    console.log("Bundling done.")
  }
  out.watchers.push(changed => {
    let changedPkgs: Package[] = []
    for (let file of changed) {
      let root = dirname(dirname(file))
      let pkg = pkgs.find(p => p.root = root)
      if (!pkg) throw new Error("No package found for " + file)
      if (!changedPkgs.includes(pkg)) changedPkgs.push(pkg)
    }
    bundleAll(changedPkgs)
  })
  bundleAll(pkgs)
}
