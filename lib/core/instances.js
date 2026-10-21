// DSH启动器 · 实例记录持久化（通用）
import path from 'node:path'
import fsp from 'node:fs/promises'
import { readJson, writeJson, pathExists, removeDir, slugify, timestamp, readText } from './paths.js'

const STATUS = new Set(['new', 'installing', 'ready', 'error'])

export function normalizeInstance(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const status = STATUS.has(source.status) ? source.status : 'new'
  return {
    id: String(source.id || ''),
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '未命名实例',
    game: String(source.game || ''),
    versionId: String(source.versionId || source.mcVersion || ''),
    status,
    memoryMb: Number.isFinite(Number(source.memoryMb)) ? Number(source.memoryMb) : null,
    options: source.options && typeof source.options === 'object' ? source.options : {},
    content: Array.isArray(source.content) ? source.content : Array.isArray(source.mods) ? source.mods : [],
    metadata: source.metadata && typeof source.metadata === 'object' ? source.metadata : {},
    createdAt: String(source.createdAt || timestamp()),
    updatedAt: String(source.updatedAt || timestamp()),
    lastLaunchAt: source.lastLaunchAt ? String(source.lastLaunchAt) : null,
    lastExit: source.lastExit && typeof source.lastExit === 'object' ? source.lastExit : null,
    playCount: Number.isFinite(Number(source.playCount)) ? Number(source.playCount) : 0,
    installError: source.installError ? String(source.installError) : null,
  }
}

export function summarizeInstance(record) {
  return {
    id: record.id,
    name: record.name,
    game: record.game,
    versionId: record.versionId,
    status: record.status,
    memoryMb: record.memoryMb,
    contentCount: Array.isArray(record.content) ? record.content.length : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastLaunchAt: record.lastLaunchAt,
    lastExit: record.lastExit,
    playCount: record.playCount,
    installError: record.installError,
    running: false,
  }
}

export function instanceDirOf(paths, id) {
  return paths.instanceDir(id)
}

export function instanceFileOf(paths, id) {
  return path.join(paths.instanceDir(id), 'instance.json')
}

export async function listInstanceRecords(paths) {
  let names = []
  try {
    names = await fsp.readdir(paths.instances)
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort()) {
    const record = await readInstance(paths, name)
    if (record) out.push(record)
  }
  return out
}

export async function readInstance(paths, id) {
  const raw = await readJson(instanceFileOf(paths, id), null)
  if (!raw || typeof raw !== 'object') return null
  const record = normalizeInstance(raw)
  if (!record.id) record.id = String(id)
  return record
}

export async function writeInstance(paths, record) {
  const normalized = normalizeInstance(record)
  normalized.updatedAt = timestamp()
  await fsp.mkdir(paths.instanceDir(normalized.id), { recursive: true })
  await writeJson(instanceFileOf(paths, normalized.id), normalized)
  return normalized
}

export async function deleteInstanceDir(paths, id) {
  await removeDir(paths.instanceDir(id))
}

export async function uniqueInstanceId(paths, name) {
  const base = slugify(name || 'instance')
  let candidate = base
  let index = 2
  while (await pathExists(path.join(paths.instances, candidate, 'instance.json'))) {
    candidate = base + '-' + index
    index += 1
  }
  return candidate
}

export async function readInstanceLog(paths, id, lines = 120) {
  const dir = paths.instanceLogsDir(id)
  let files = []
  try {
    const names = await fsp.readdir(dir)
    files = names.filter((n) => n.endsWith('.log')).sort()
  } catch {
    return { file: null, lines: [] }
  }
  if (!files.length) return { file: null, lines: [] }
  const file = path.join(dir, files[files.length - 1])
  const text = await readText(file, '')
  const all = text.split(/\r?\n/)
  const tail = all.slice(Math.max(0, all.length - Math.max(1, Number(lines) || 120)))
  return { file, lines: tail }
}
