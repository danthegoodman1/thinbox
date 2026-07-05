type Quota = {
  maxBytes: number
  maxFiles: number
  maxFileSize: number
}

type DirectoryNode = {
  type: 'directory'
  entries: Map<string, Node>
}

type FileNode = {
  type: 'file'
  data: Buffer
  links: number
}

type Node = DirectoryNode | FileNode

type HandleState = {
  node: FileNode
  read: boolean
  write: boolean
  append: boolean
}

type OpenMode = {
  read?: boolean
  write?: boolean
  create?: boolean
  createNew?: boolean
  truncate?: boolean
  append?: boolean
}

export function createMemoryVfs(quota: Quota = generousQuota()) {
  const root: DirectoryNode = { type: 'directory', entries: new Map() }
  const handles = new Map<number, HandleState>()
  let nextHandle = 1

  const liveFiles = () => collectLiveFiles(root, handles)
  const currentStats = () => stats(root, liveFiles())

  return {
    async stat({ path }: { path: string }) {
      return statOf(lookup(root, path))
    },
    async readdir({ path }: { path: string }) {
      const node = lookup(root, path)
      if (node.type !== 'directory') throw codeError('ENOTDIR')
      return [...node.entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) => ({ name, ...statOf(child) }))
    },
    async mkdir({ path }: { path: string }) {
      const normalized = normalizePath(path)
      if (lookupOptional(root, normalized)) throw codeError('EEXIST')
      const { parent, name } = parentDirectory(root, normalized)
      ensureFileSlot(currentStats(), quota)
      parent.entries.set(name, { type: 'directory', entries: new Map() })
      return {}
    },
    async rename({ from, to }: { from: string, to: string }) {
      const sourcePath = normalizePath(from)
      const targetPath = normalizePath(to)
      if (sourcePath === '/') throw codeError('EINVAL')
      if (isChildPath(targetPath, sourcePath)) throw codeError('EINVAL')
      const source = lookup(root, sourcePath)
      if (sourcePath === targetPath) return {}

      const sourceParent = parentDirectory(root, sourcePath)
      const targetParent = parentDirectory(root, targetPath)
      const target = targetParent.parent.entries.get(targetParent.name)
      if (target?.type === 'directory' && source.type === 'file') throw codeError('EISDIR')
      if (target?.type === 'file' && source.type === 'directory') throw codeError('ENOTDIR')
      if (target?.type === 'directory' && target.entries.size > 0) throw codeError('ENOTEMPTY')

      if (target) unlinkVisibleNode(targetParent.parent, targetParent.name)
      sourceParent.parent.entries.delete(sourceParent.name)
      targetParent.parent.entries.set(targetParent.name, source)
      return {}
    },
    async unlink({ path }: { path: string }) {
      const normalized = normalizePath(path)
      const node = lookup(root, normalized)
      if (node.type === 'directory') throw codeError('EISDIR')
      const { parent, name } = parentDirectory(root, normalized)
      unlinkVisibleNode(parent, name)
      return {}
    },
    async rmdir({ path }: { path: string }) {
      const normalized = normalizePath(path)
      if (normalized === '/') throw codeError('EBUSY')
      const node = lookup(root, normalized)
      if (node.type !== 'directory') throw codeError('ENOTDIR')
      if (node.entries.size > 0) throw codeError('ENOTEMPTY')
      const { parent, name } = parentDirectory(root, normalized)
      parent.entries.delete(name)
      return {}
    },
    async open({ path, mode }: { path: string, mode: OpenMode }) {
      const normalized = normalizePath(path)
      validateMode(mode)
      let node = lookupOptional(root, normalized)
      if (!node) {
        if (!mode?.create && !mode?.createNew) throw codeError('ENOENT')
        const { parent, name } = parentDirectory(root, normalized)
        ensureFileSlot(currentStats(), quota)
        node = { type: 'file', data: Buffer.alloc(0), links: 1 }
        parent.entries.set(name, node)
      } else {
        if (mode?.createNew) throw codeError('EEXIST')
        if (node.type === 'directory') throw codeError('EISDIR')
      }
      if (node.type !== 'file') throw codeError('EISDIR')
      if (mode?.truncate) resize(liveFiles(), quota, node, 0)
      const handle = nextHandle++
      handles.set(handle, {
        node,
        read: Boolean(mode?.read),
        write: Boolean(mode?.write),
        append: Boolean(mode?.append)
      })
      return { handle }
    },
    async readAt({ handle, offset, len }: { handle: number, offset: number, len: number }) {
      const state = requireHandle(handles, handle)
      if (!state.read) throw codeError('EBADF')
      return { data: state.node.data.subarray(offset, offset + len) }
    },
    async writeAt({ handle, offset, data }: { handle: number, offset: number, data: Buffer }) {
      const state = requireHandle(handles, handle)
      if (!state.write) throw codeError('EBADF')
      if (data.length === 0) return { bytesWritten: 0 }
      const writeOffset = state.append ? state.node.data.length : offset
      if (!Number.isSafeInteger(writeOffset) || writeOffset < 0) throw codeError('EINVAL')
      const nextLength = Math.max(state.node.data.length, writeOffset + data.length)
      if (!Number.isSafeInteger(nextLength)) throw codeError('EINVAL')
      resize(liveFiles(), quota, state.node, nextLength)
      data.copy(state.node.data, writeOffset)
      return { bytesWritten: data.length }
    },
    async truncate({ handle, len }: { handle: number, len: number }) {
      const state = requireHandle(handles, handle)
      if (!state.write) throw codeError('EINVAL')
      resize(liveFiles(), quota, state.node, len)
      return {}
    },
    async close({ handle }: { handle: number }) {
      if (!handles.delete(handle)) throw codeError('EBADF')
      return {}
    },
    async stats() {
      const { usedBytes, fileCount } = currentStats()
      return { usedBytes, fileCount }
    }
  }
}

function validateMode(mode: OpenMode) {
  if (!mode?.read && !mode?.write) throw codeError('EINVAL')
  if (mode?.truncate && !mode?.write) throw codeError('EINVAL')
  if (mode?.append && !mode?.write) throw codeError('EINVAL')
}

function lookup(root: DirectoryNode, path: string): Node {
  const node = lookupOptional(root, path)
  if (!node) throw codeError('ENOENT')
  return node
}

function lookupOptional(root: DirectoryNode, path: string): Node | undefined {
  const normalized = normalizePath(path)
  if (normalized === '/') return root
  let node: Node = root
  for (const part of normalized.slice(1).split('/')) {
    if (node.type !== 'directory') throw codeError('ENOTDIR')
    const child = node.entries.get(part)
    if (!child) return undefined
    node = child
  }
  return node
}

function parentDirectory(root: DirectoryNode, path: string) {
  const normalized = normalizePath(path)
  if (normalized === '/') throw codeError('EBUSY')
  const parts = normalized.slice(1).split('/')
  const name = parts.pop() ?? ''
  let parent: Node = root
  for (const part of parts) {
    if (parent.type !== 'directory') throw codeError('ENOTDIR')
    const child = parent.entries.get(part)
    if (!child) throw codeError('ENOENT')
    parent = child
  }
  if (parent.type !== 'directory') throw codeError('ENOTDIR')
  return { parent, name }
}

function unlinkVisibleNode(parent: DirectoryNode, name: string) {
  const node = parent.entries.get(name)
  if (!node) throw codeError('ENOENT')
  parent.entries.delete(name)
  if (node.type === 'file') node.links -= 1
}

function resize(files: Set<FileNode>, quota: Quota, node: FileNode, len: number) {
  if (!Number.isFinite(len) || len < 0 || len % 1 !== 0) throw codeError('EINVAL')
  if (len > quota.maxFileSize) throw codeError('ENOSPC')
  let total = len
  for (const file of files) {
    if (file !== node) total += file.data.length
  }
  if (total > quota.maxBytes) throw codeError('ENOSPC')
  const next = Buffer.alloc(len)
  node.data.copy(next, 0, 0, Math.min(node.data.length, len))
  node.data = next
}

function ensureFileSlot({ fileCount }: { fileCount: number }, quota: Quota) {
  if (fileCount >= quota.maxFiles) throw codeError('ENOSPC')
}

function stats(root: DirectoryNode, files: Set<FileNode>) {
  return {
    usedBytes: [...files].reduce((sum, file) => sum + file.data.length, 0),
    fileCount: countVisibleEntries(root) + countOpenUnlinkedFiles(files)
  }
}

function collectLiveFiles(root: DirectoryNode, handles: Map<number, HandleState>) {
  const files = new Set<FileNode>()
  collectVisibleFiles(root, files)
  for (const { node } of handles.values()) files.add(node)
  return files
}

function collectVisibleFiles(directory: DirectoryNode, files: Set<FileNode>) {
  for (const node of directory.entries.values()) {
    if (node.type === 'file') files.add(node)
    else collectVisibleFiles(node, files)
  }
}

function countVisibleEntries(directory: DirectoryNode): number {
  let count = 0
  for (const node of directory.entries.values()) {
    count += 1
    if (node.type === 'directory') count += countVisibleEntries(node)
  }
  return count
}

function countOpenUnlinkedFiles(files: Set<FileNode>) {
  let count = 0
  for (const file of files) {
    if (file.links === 0) count += 1
  }
  return count
}

function statOf(node: Node) {
  return {
    fileType: node.type === 'file' ? 'file' : 'directory',
    len: node.type === 'file' ? node.data.length : 0
  }
}

function requireHandle(handles: Map<number, HandleState>, handle: number) {
  const state = handles.get(handle)
  if (!state) throw codeError('EBADF')
  return state
}

function normalizePath(path: string) {
  if (!path.startsWith('/')) throw codeError('EINVAL')
  const parts: Array<string> = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function isChildPath(path: string, parent: string) {
  return parent !== '/' && path.startsWith(`${parent}/`)
}

function codeError(code: string) {
  const err = new Error(code)
  Object.assign(err, { code })
  return err
}

function generousQuota(): Quota {
  return {
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxFiles: Number.MAX_SAFE_INTEGER,
    maxFileSize: Number.MAX_SAFE_INTEGER
  }
}
