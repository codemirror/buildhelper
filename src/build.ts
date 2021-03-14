import * as ts from "typescript"
import {join, dirname, basename, resolve} from "path"
import * as fs from "fs"
import {rollup, RollupBuild, Plugin} from "rollup"
import dts from "rollup-plugin-dts"

const pkgCache: {[main: string]: Package} = Object.create(null)

function tsFiles(dir: string) {
  return fs.readdirSync(dir).filter(f => /(?<!\.d)\.ts$/.test(f)).map(f => join(dir, f))
}

class Package {
  readonly root: string
  readonly dirs: readonly string[]
  readonly tests: readonly string[]
  readonly json: any
  readonly lezer: boolean

  constructor(readonly main: string) {
    let src = dirname(main), root = dirname(src), tests = join(root, "test")
    this.root = root
    let dirs = this.dirs = [src]
    if (fs.existsSync(tests)) {
      this.tests = tsFiles(tests)
      dirs.push(tests)
    } else {
      this.tests = []
    }
    this.lezer = fs.readdirSync(src).some(f => /\.grammar$/.test(f))
    this.json = JSON.parse(fs.readFileSync(join(this.root, "package.json"), "utf8"))
  }

  static get(main: string): Package {
    return pkgCache[main] || (pkgCache[main] = new Package(main))
  }
}

const tsOptions = {
  lib: ["es6", "scripthost", "dom"],
  types: ["mocha"],
  stripInternal: true,
  noUnusedLocals: true,
  strict: true,
  target: "es6",
  module: "es2020",
  newLine: "lf",
  declaration: true,
  declarationMap: true,
  moduleResolution: "node"
}

function configFor(pkgs: readonly Package[], extra: readonly string[] = []) {
  let paths: ts.MapLike<string[]> = {}
  for (let pkg of pkgs) paths[pkg.json.name] = [pkg.main]
  return {
    compilerOptions: {paths, ...tsOptions},
    include: pkgs.reduce((ds, p) => ds.concat(p.dirs.map(d => join(d, "*.ts"))), [] as string[])
      .concat(extra)
  }
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

function readAndMangleComments(dirs: readonly string[]) {
  return (name: string) => {
    let file = ts.sys.readFile(name)
    if (file && dirs.includes(dirname(name)))
      file = file.replace(/(?:([ \t]*)\/\/\/.*\n)+/g, (comment, space) => {
        comment = comment.replace(/\]\(#/g, "](https://codemirror.net/6/docs/ref/#")
        return `${space}/**\n${space}${comment.slice(space.length).replace(/\/\/\/ ?/g, "")}${space}*/\n`
      })
    return file
  }
}

function runTS(dirs: readonly string[], tsconfig: any) {
  let config = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dirname(dirs[0]))
  let host = ts.createCompilerHost(config.options)
  host.readFile = readAndMangleComments(dirs)
  let program = ts.createProgram({rootNames: config.fileNames, options: config.options, host})
  let out = new Output, result = program.emit(undefined, out.write)
  return result.emitSkipped ? null : out
}

const tsFormatHost = {
  getCanonicalFileName: (path: string) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n"
}

function watchTS(dirs: readonly string[], tsconfig: any) {
  let out = new Output, mangle = readAndMangleComments(dirs)
  let dummyConf = join(dirname(dirname(dirs[0])), "TSCONFIG.json")
  ts.createWatchProgram(ts.createWatchCompilerHost(
    dummyConf,
    undefined,
    Object.assign({}, ts.sys, {
      writeFile: out.write,
      readFile: (name: string) => {
        return name == dummyConf ? JSON.stringify(tsconfig) : mangle(name)
      }
    }),
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    diag => console.error(ts.formatDiagnostic(diag, tsFormatHost)),
    diag => console.info(ts.flattenDiagnosticMessageText(diag.messageText, "\n"))
  ))
  return out
}

function external(id: string) { return id != "tslib" && !/^(\.?\/|\w:)/.test(id) }

function outputPlugin(output: Output, ext: string, base: Plugin) {
  let {resolveId, load} = base
  return {
    ...base,
    resolveId(source: string, base: string | undefined, options: any) {
      let full = base && source[0] == "." ? resolve(dirname(base), source) : source
      if (!/\.\w+$/.test(full)) full += ext
      if (output.files[full]) return full
      return resolveId ? resolveId.call(this, source, base, options) : undefined
    },
    load(file: string) {
      return output.files[file] || (load && load.call(this, file))
    }
  } as Plugin
}

async function emit(bundle: RollupBuild, conf: any) {
  let result = await bundle.generate(conf)
  let dir = dirname(conf.file)
  await fs.promises.mkdir(dir, {recursive: true}).catch(() => null)
  for (let file of result.output)
    await fs.promises.writeFile(join(dir, file.fileName), (file as any).code || (file as any).source)
}

async function bundle(pkg: Package, compiled: Output) {
  let bundle = await rollup({
    input: pkg.main.replace(/\.ts$/, ".js"),
    external,
    plugins: [
      // @ts-ignore
      outputPlugin(compiled, ".js", pkg.lezer ? (await import("lezer-generator/rollup")).lezer() : {name: "dummy"})
    ]
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

  let tscBundle = await rollup({
    input: pkg.main.replace(/\.ts$/, ".d.ts"),
    plugins: [outputPlugin(compiled, ".d.ts", {name: "dummy"}), dts()],
    onwarn(warning, warn) {
      if (warning.code != "CIRCULAR_DEPENDENCY" && warning.code != "UNUSED_EXTERNAL_IMPORT")
        warn(warning)
    }
  })
  await emit(tscBundle, {
    format: "esm",
    file: join(dist, "index.d.ts")
  })
}

function allDirs(pkgs: readonly Package[]) {
  return pkgs.reduce((a, p) => a.concat(p.dirs), [] as string[])
}

export async function build(main: string | readonly string[]) {
  let pkgs = typeof main == "string" ? [Package.get(main)] : main.map(Package.get)
  let compiled = runTS(allDirs(pkgs), configFor(pkgs))
  if (!compiled) return false
  for (let pkg of pkgs) {
    await bundle(pkg, compiled)
    for (let file of pkg.tests.map(f => f.replace(/\.ts$/, ".js")))
      fs.writeFileSync(file, compiled.files[file])
  }
  return true
}

export function watch(mains: readonly string[], extra: readonly string[] = []) {
  let pkgs = mains.map(Package.get)
  let out = watchTS(allDirs(pkgs), configFor(pkgs, extra))
  out.watchers.push(writeFor)
  writeFor(Object.keys(out.files))

  async function writeFor(files: readonly string[]) {
    let changedPkgs: Package[] = [], changedFiles: string[] = []
    for (let file of files) {
      let ts = file.replace(/\.d\.ts$|\.js$/, ".ts")
      if (extra.includes(ts)) {
        changedFiles.push(file)
      } else {
        let root = dirname(dirname(file))
        let pkg = pkgs.find(p => p.root == root)
        if (!pkg)
          throw new Error("No package found for " + file)
        if (pkg.tests.includes(ts)) changedFiles.push(file)
        else if (!changedPkgs.includes(pkg)) changedPkgs.push(pkg)
      }
    }
    for (let file of changedFiles) if (/\.js$/.test(file)) fs.writeFileSync(file, out.files[file])
    console.log("Bundling " + pkgs.map(p => basename(p.root)).join(", "))
    for (let pkg of changedPkgs) {
      try { await bundle(pkg, out) }
      catch(e) { console.error(`Failed to bundle ${basename(pkg.root)}:\n${e}`) }
    }
    console.log("Bundling done.")
  }
}
