const native = require('./native.cjs')

class Sandbox extends native.NativeSandbox {
  constructor(options = undefined) {
    super(normalizeOptions(options))
    this._fs = undefined
  }

  get fs() {
    this._fs ??= new SandboxFs(super.fs)
    return this._fs
  }
}

async function runConformance(vfsFactory) {
  return native.runConformance(async (quota) => native.createJsVfs(wrapVfs(await vfsFactory(firstArgument(quota)))))
}

function normalizeOptions(options) {
  if (!options) return options
  const normalized = { ...options }
  if (options.commands) normalized.commands = wrapCommands(options.commands)
  else delete normalized.commands
  if (options.vfs) normalized.vfs = wrapVfs(options.vfs)
  else delete normalized.vfs
  return normalized
}

function wrapCommands(commands) {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      async (call) => {
        try {
          const payload = firstArgument(call)
          return normalizeCommandOutput(await command(payload))
        } catch (err) {
          return {
            exitCode: 1,
            stderr: Buffer.from(`${err?.message ?? err}\n`)
          }
        }
      }
    ])
  )
}

function wrapVfs(vfs) {
  return Object.fromEntries(
    vfsOperations.map((name) => [
      name,
      async (request) => {
        try {
          return normalizeVfsResponse(name, await vfs[name](normalizeVfsRequest(request)))
        } catch (err) {
          return { error: errorPayload(err) }
        }
      }
    ]).concat(
      typeof vfs.stats === 'function'
        ? [[
            'stats',
            async (request) => {
              try {
                return normalizeVfsResponse('stats', await vfs.stats(normalizeVfsRequest(request)))
              } catch (err) {
                return { error: errorPayload(err) }
              }
            }
          ]]
        : []
    )
  )
}

function normalizeVfsRequest(request) {
  return firstArgument(request)
}

function firstArgument(value) {
  // napi-rs TSFN callbacks marshal tuple arguments as an object with numeric
  // keys, while direct wrapper calls already pass the request object.
  return value && typeof value === 'object' && Object.hasOwn(value, '0') ? value[0] : value
}

function normalizeCommandOutput(output = {}) {
  return {
    exitCode: output.exitCode ?? 0,
    stdout: output.stdout ? Buffer.from(output.stdout) : undefined,
    stderr: output.stderr ? Buffer.from(output.stderr) : undefined
  }
}

function normalizeVfsResponse(name, response) {
  if (response === undefined || response === null) return {}
  if (response.error) return response
  if (Buffer.isBuffer(response)) return { data: response, bytesRead: response.length }
  if (Array.isArray(response)) return { entries: response }
  if (typeof response === 'number') {
    if (name === 'open') return { handle: response }
    if (name === 'writeAt') return { bytesWritten: response }
  }
  return response
}

function errorPayload(err) {
  return {
    code: normalizeErrnoCode(err?.code),
    message: err?.message ?? String(err)
  }
}

function normalizeErrnoCode(code) {
  return errnos.includes(code) ? code : 'EINVAL'
}

const vfsOperations = [
  'stat',
  'readdir',
  'mkdir',
  'rename',
  'unlink',
  'rmdir',
  'open',
  'readAt',
  'writeAt',
  'truncate',
  'close'
]

const errnos = [
  'EBADF',
  'EBUSY',
  'EACCES',
  'EEXIST',
  'EINVAL',
  'EISDIR',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY'
]

class SandboxFs {
  constructor(inner) {
    this.inner = inner
  }

  stat(path) {
    return decorateFsPromise(this.inner.stat(path))
  }

  readdir(path) {
    return decorateFsPromise(this.inner.readdir(path))
  }

  mkdir(path) {
    return decorateFsPromise(this.inner.mkdir(path))
  }

  rename(from, to) {
    return decorateFsPromise(this.inner.rename(from, to))
  }

  unlink(path) {
    return decorateFsPromise(this.inner.unlink(path))
  }

  rmdir(path) {
    return decorateFsPromise(this.inner.rmdir(path))
  }

  readFile(path) {
    return decorateFsPromise(this.inner.readFile(path))
  }

  writeFile(path, data) {
    return decorateFsPromise(this.inner.writeFile(path, data))
  }

  appendFile(path, data) {
    return decorateFsPromise(this.inner.appendFile(path, data))
  }

  open(path, mode) {
    return decorateFsPromise(this.inner.open(path, mode))
  }

  readAt(handle, offset, len) {
    return decorateFsPromise(this.inner.readAt(handle, offset, len))
  }

  writeAt(handle, offset, data) {
    return decorateFsPromise(this.inner.writeAt(handle, offset, data))
  }

  truncate(handle, len) {
    return decorateFsPromise(this.inner.truncate(handle, len))
  }

  close(handle) {
    return decorateFsPromise(this.inner.close(handle))
  }
}

async function decorateFsPromise(promise) {
  try {
    return await promise
  } catch (err) {
    if (!err || typeof err !== 'object') throw err
    err.code = normalizeNativeErrno(err)
    throw err
  }
}

function normalizeNativeErrno(err) {
  if (errnos.includes(err.code)) return err.code
  const [prefix] = String(err.message ?? '').split(':', 1)
  return errnos.includes(prefix) ? prefix : 'EINVAL'
}

exports.NativeSandbox = native.NativeSandbox
exports.SandboxFs = SandboxFs
exports.Sandbox = Sandbox
exports.runConformance = runConformance
