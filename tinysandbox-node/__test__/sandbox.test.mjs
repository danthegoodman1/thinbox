import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox, runConformance } from '../index.js'
import { createMemoryVfs } from './helpers.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('sandbox lifecycle returns output, exit codes, and metrics', async () => {
  // Pins the basic async lifecycle and camelCase ExecResult shape.
  const sandbox = new Sandbox()
  const result = await sandbox.exec('echo hello && false')
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.exitCode, 1)
  assert.equal(typeof result.wallTimeMs, 'number')
  assert.equal(result.stdoutTruncated, false)
})

test('limits report wall-clock timeout and wasm memory failure', async () => {
  // Wall-clock timeout should use the same conventional 124 code as the Rust API.
  const impatient = new Sandbox({ limits: { wallTimeMs: 50 } })
  const timeout = await impatient.exec("js -e 'while (true) {}'")
  assert.equal(timeout.exitCode, 124)

  // A tight wasm heap should make large JS allocation fail without crashing Node.
  const constrained = new Sandbox({ limits: { wasmMemoryBytes: 4 * 1024 * 1024 } })
  const oom = await constrained.exec("js -e 'globalThis.x = new ArrayBuffer(64 * 1024 * 1024)'")
  assert.notEqual(oom.exitCode, 0)
  assert.match(oom.stderr, /memory|alloc/i)
})

test('wall-clock limit validation rejects invalid numbers without aborting Node', () => {
  // Constructor errors must cross N-API as exceptions, not Rust panics.
  assert.throws(() => new Sandbox({ limits: { wallTimeMs: -5 } }), /wallTimeMs/)
})

test('numeric validation rejects unsafe byte counts and VFS lengths', async () => {
  // Oversized lengths must fail before native code allocates a Vec for the read.
  const unsafeInteger = Number.MAX_SAFE_INTEGER + 1
  assert.throws(() => new Sandbox({ limits: { stdoutBytes: unsafeInteger } }), /EINVAL/)

  const sandbox = new Sandbox()
  await sandbox.fs.writeFile('/x', Buffer.from('abc'))
  const handle = await sandbox.fs.open('/x', { read: true })
  try {
    await assert.rejects(
      () => sandbox.fs.readAt(handle, 0, unsafeInteger),
      (err) => {
        assert.equal(err.code, 'EINVAL')
        return true
      }
    )
  } finally {
    await sandbox.fs.close(handle)
  }
})

test('direct VFS calls read, write, stat, readdir, and unlink', async () => {
  // Host-side VFS calls should work without shelling through exec.
  const sandbox = new Sandbox()
  assert.equal(sandbox.fs, sandbox.fs)
  await sandbox.fs.mkdir('/work')
  await sandbox.fs.writeFile('/work/a.txt', Buffer.from('alpha'))
  assert.equal(String(await sandbox.fs.readFile('/work/a.txt')), 'alpha')
  assert.deepEqual(await sandbox.fs.stat('/work/a.txt'), {
    fileType: 'file',
    len: 5,
    isFile: true,
    isDir: false
  })
  assert.deepEqual((await sandbox.fs.readdir('/work')).map((entry) => entry.name), ['a.txt'])
  await sandbox.fs.unlink('/work/a.txt')
  await assert.rejects(
    () => sandbox.fs.stat('/work/a.txt'),
    (err) => {
      assert.equal(err.code, 'ENOENT')
      assert.match(err.message, /\/work\/a\.txt/)
      return true
    }
  )
})

test('cached direct VFS calls use the current persistent session cwd', async () => {
  // The JS facade stays stable while native path resolution follows later cd calls.
  const sandbox = new Sandbox({ persistSession: true })
  const fs = sandbox.fs
  await fs.mkdir('/a')
  await sandbox.exec('cd /a')
  await fs.writeFile('y.txt', Buffer.from('cwd-aware'))
  assert.equal(String(await fs.readFile('/a/y.txt')), 'cwd-aware')
  await assert.rejects(() => fs.stat('/y.txt'), { code: 'ENOENT' })
})

test('custom JS command composes in a pipeline', async () => {
  // Custom commands are buffered at the JS boundary but still stream through Rust pipelines.
  const sandbox = new Sandbox({
    commands: {
      upper: async ({ stdin }) => {
        assert.equal(Buffer.isBuffer(stdin), true)
        return { stdout: Buffer.from(stdin.toString('utf8').toUpperCase()) }
      }
    }
  })
  const result = await sandbox.exec('echo make noise | upper | wc -w')
  assert.equal(result.stdout, '      2\n')
})

test('JS VFS conformance runner accepts callback implementations', async () => {
  // Third-party JS VFS implementations can self-certify the public VFS contract.
  const result = await runConformance((quota) => createMemoryVfs(quota))
  assert.deepEqual(result, { ok: true, snapshots: 'unsupported' })
})

test('Sandbox can execute against a JS VFS adapter', async () => {
  // Exercises the Rust sync Vfs trait backed by async JS callbacks through TSFN.
  const sandbox = new Sandbox({ vfs: createMemoryVfs() })
  await sandbox.fs.mkdir('/app')
  await sandbox.fs.writeFile('/app/input.txt', Buffer.from('one\ntwo\n'))
  const result = await sandbox.exec('cat /app/input.txt | wc -l')
  assert.equal(result.stdout, '      2\n')
})

test('Sandbox stats can call a JS VFS stats callback without deadlocking', async () => {
  // stats() is async because JS VFS callbacks need the main thread to keep pumping promises.
  const sandbox = new Sandbox({ vfs: createMemoryVfs() })
  await sandbox.fs.writeFile('/stats.txt', Buffer.from('abc'))
  const stats = await Promise.race([
    sandbox.stats(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 1000))
  ])
  assert.deepEqual(stats.vfs, { usedBytes: 3, fileCount: 1 })
})

test('Node e2e pipeline can cat into the sandboxed js command', async () => {
  // Direct host writes and the built-in Wasmtime QuickJS command share the same VFS.
  const sandbox = new Sandbox()
  await sandbox.fs.writeFile('/x', Buffer.from('abc'))
  await sandbox.fs.writeFile('/t.js', Buffer.from('const fs = require("fs")\nconsole.log(fs.readFileSync("/x", "utf8").toUpperCase())\n'))
  const result = await sandbox.exec('cat /x | js /t.js')
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'ABC\n')
})

test('direct VFS calls proceed while exec is in flight', async () => {
  // The command bridge must not monopolize the JS event loop while an exec awaits.
  const sandbox = new Sandbox({
    commands: {
      wait: async () => new Promise((resolve) => setTimeout(() => resolve({ stdout: Buffer.from('done\n') }), 50))
    }
  })
  const running = sandbox.exec('wait')
  await sandbox.fs.writeFile('/during.txt', Buffer.from('ok'))
  assert.equal(String(await sandbox.fs.readFile('/during.txt')), 'ok')
  assert.equal((await running).stdout, 'done\n')
})

test('JS VFS callbacks do not deadlock on the same event loop', async () => {
  // readAt yields back to the same JS loop that is awaiting exec; a synchronous main-thread call would hang here.
  const vfs = createMemoryVfs()
  const originalReadAt = vfs.readAt
  vfs.readAt = async (request) => {
    await Promise.resolve()
    return originalReadAt(request)
  }
  const sandbox = new Sandbox({ vfs })
  await sandbox.fs.writeFile('/x', Buffer.from('deadlock-free'))
  const result = await Promise.race([
    sandbox.exec('cat /x'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked')), 1000))
  ])
  assert.equal(result.stdout, 'deadlock-free')
})

test('unknown JS VFS error text collapses to EINVAL instead of substring matching', async () => {
  const vfs = createMemoryVfs()
  vfs.stat = async () => {
    throw new Error('file ENOENT-ish not really')
  }
  const sandbox = new Sandbox({ vfs })
  await assert.rejects(
    () => sandbox.fs.stat('/x'),
    (err) => {
      assert.equal(err.code, 'EINVAL')
      return true
    }
  )
})

test('JS VFS request data is delivered as a Buffer', async () => {
  const vfs = createMemoryVfs()
  const originalWriteAt = vfs.writeAt
  vfs.writeAt = async (request) => {
    assert.equal(Buffer.isBuffer(request.data), true)
    return originalWriteAt(request)
  }
  const sandbox = new Sandbox({ vfs })
  await sandbox.fs.writeFile('/buffer.txt', Buffer.from('buffered'))
  assert.equal(String(await sandbox.fs.readFile('/buffer.txt')), 'buffered')
})

test('JS VFS adapters do not keep child processes alive', async () => {
  const script = `
    import { Sandbox } from './index.js'
    import { createMemoryVfs } from './__test__/helpers.mjs'
    const sandbox = new Sandbox({ vfs: createMemoryVfs() })
    await sandbox.fs.writeFile('/x', Buffer.from('ok'))
    const result = await sandbox.exec('cat /x')
    if (result.stdout !== 'ok') process.exit(2)
  `

  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const result = await waitForChild(child, 2000)
  assert.equal(result.code, 0, result.stderr)
})

function waitForChild(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('child process did not exit naturally'))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      resolvePromise({ code, stdout, stderr })
    })
  })
}
