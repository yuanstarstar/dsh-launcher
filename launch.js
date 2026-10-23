// DSH启动器 · 通用进程启动器（不含游戏专用逻辑）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

export async function launchProcess({ spec, logPath, onLine = null }) {
  if (!spec || typeof spec !== 'object') throw new Error('启动失败：启动描述无效')
  const executable = spec.executable
  if (typeof executable !== 'string' || !executable.trim()) throw new Error('启动失败：适配器没有返回可执行文件')
  const args = Array.isArray(spec.args) ? spec.args.map((item) => String(item)) : []
  const env = { ...process.env, ...(spec.env && typeof spec.env === 'object' ? spec.env : {}) }
  await fsp.mkdir(path.dirname(logPath), { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  stream.write('\n# DSH启动器 启动记录 ' + new Date().toISOString() + '\n')
  stream.write('# 可执行文件: ' + executable + '\n')
  stream.write('# 参数: ' + JSON.stringify(args) + '\n')

  const proc = spawn(executable, args, {
    cwd: spec.cwd || undefined,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const forward = (chunk, channel) => {
    try {
      stream.write(chunk)
    } catch {
      /* 日志写入失败不影响游戏进程 */
    }
    if (!onLine) return
    const text = String(chunk)
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trimEnd()
      if (line) {
        try {
          onLine(line, channel)
        } catch {
          /* 忽略回调错误 */
        }
      }
    }
  }

  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk) => forward(chunk, 'stdout'))
  proc.stderr?.on('data', (chunk) => forward(chunk, 'stderr'))
  proc.on('error', (error) => {
    try {
      stream.write('# 启动错误: ' + errorMessage(error) + '\n')
    } catch {
      /* ignore */
    }
  })
  proc.on('exit', (code, signal) => {
    try {
      stream.write('# 进程退出: code=' + code + ' signal=' + signal + '\n')
      stream.end()
    } catch {
      /* ignore */
    }
  })

  return { proc, startedAt: Date.now() }
}

export async function stopProcess({ pid, proc = null, waitMs = 6000 }) {
  if (!pid && !proc) return { stopped: false }
  if (process.platform === 'win32' && pid) {
    const ok = await new Promise((resolve) => {
      try {
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        child.on('error', () => resolve(false))
        child.on('exit', (code) => resolve(code === 0))
      } catch {
        resolve(false)
      }
    })
    if (ok) return { stopped: true, pid }
  }
  if (proc && !proc.killed && proc.exitCode === null) {
    try {
      proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    const closed = await new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) resolve(false)
      }, waitMs)
      proc.once('exit', () => {
        done = true
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (closed) return { stopped: true, pid }
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    return { stopped: true, pid, forced: true }
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL')
      return { stopped: true, pid, forced: true }
    } catch {
      /* ignore */
    }
  }
  return { stopped: false }
}

export async function readLogTail(file, lines = 40) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const all = text.split(/\r?\n/).filter((line) => line.trim())
    return all.slice(Math.max(0, all.length - Math.max(1, lines))).join('\n')
  } catch {
    return ''
  }
}
