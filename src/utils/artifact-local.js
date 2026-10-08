// Local artifact capture for the CHAT path — the "deliverables stay local" feature.
//
// Qwen2API's ASSET_LOCAL_SAVE only persists media (images/videos) from the
// image/video controllers, where upstream returns a signed OSS URL. HTML / code
// deliverables go through the plain chat path and arrive as TEXT (fenced code
// blocks) or as hosted links on Qwen's CDN — neither of which is ever captured.
//
// This module closes that gap. It scans the assistant text that the chat path is
// about to deliver and writes any generated file to a local directory:
//   1. INLINE: a fenced code block (```html, ```python, ```svg ...) -> saved as-is
//   2. LINKED: a markdown link to a Qwen-hosted / PDF file -> downloaded best-effort
//
// Usage:
//   const { artifactStore } = require('./artifact-local')   // singleton w/ configured dir
//   const saved = await artifactStore.capture(text)
//   // saved: [{ name, path, kind: 'code'|'file', lang, ext, size }]
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('../config')
const { logger } = require('./logger')
const { resolveRuntimePath } = require('./runtime-paths')

// Language -> file extension for inline fenced blocks.
const EXT = {
  html: 'html', htm: 'html', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx',
  jsx: 'jsx', css: 'css', json: 'json', py: 'py', python: 'py', sh: 'sh', bash: 'sh', zsh: 'sh',
  md: 'md', markdown: 'md', txt: 'txt', xml: 'xml', svg: 'svg', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', env: 'env', java: 'java',
  go: 'go', rs: 'rs', rb: 'rb', php: 'php', c: 'c', cpp: 'cpp', h: 'h', cs: 'cs',
  swift: 'swift', kt: 'kt', scala: 'scala', lua: 'lua', r: 'r', dart: 'dart',
}

// Hosts that host Qwen-generated artifact / media files (temporary / signed).
const ARTIFACT_HOST_RE = /(cdn\.qwenlm\.ai|qwenlm\.ai|chat\.qwen\.ai|qwen\.cn)/i

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10)
}

function defaultDir() {
  const explicit = config.artifactDir
  return explicit || resolveRuntimePath('artifacts')
}

class ArtifactStore {
  constructor(dir) {
    this.dir = dir || defaultDir()
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      logger.warn(`[artifact-local] 无法创建输出目录 ${this.dir}: ${err.message}`, 'ARTIFACT', '⚠️')
    }
  }

  /**
   * Scan assistant text for deliverables and save them locally.
   * @param {string} text full assistant content (reasoning + content)
   * @returns {Promise<Array<{name,path,kind,lang,ext,size}>>}
   */
  async capture(text) {
    if (!text || typeof text !== 'string') return []
    const found = []
    found.push(...this.saveCodeBlocks(text))
    found.push(...(await this.downloadLinks(text)))
    return found
  }

  saveCodeBlocks(text) {
    const out = []
    const re = /```([\w+-]*)\s*\r?\n([\s\S]*?)```/g
    let idx = 0
    let m
    while ((m = re.exec(text)) !== null) {
      idx++
      const lang = (m[1] || 'txt').toLowerCase().trim()
      const body = m[2]
      const ext = EXT[lang] || 'txt'
      const name = `artifact-${Date.now()}-${idx}.${ext}`
      const p = path.join(this.dir, name)
      try {
        fs.writeFileSync(p, body, 'utf8')
        out.push({ name, path: p, kind: 'code', lang, ext, size: Buffer.byteLength(body, 'utf8') })
      } catch (err) {
        logger.warn(`[artifact-local] 保存代码块失败 ${name}: ${err.message}`, 'ARTIFACT', '⚠️')
      }
    }
    return out
  }

  async downloadLinks(text) {
    const out = []
    const re = /\[[^\]]*\]\(([^)]+)\)/g
    let m
    let idx = 0
    const seen = new Set()
    while ((m = re.exec(text)) !== null) {
      const url = m[1].trim()
      const isPdf = /\.pdf($|\?)/i.test(url)
      const isHosted = ARTIFACT_HOST_RE.test(url)
      if (!isPdf && !isHosted) continue // only grab Qwen-hosted / pdf deliverables
      if (seen.has(url)) continue
      seen.add(url)
      idx++
      try {
        const ctrl = new AbortController()
        setTimeout(() => ctrl.abort(), 30000)
        const resp = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
        if (!resp.ok) continue
        const buf = Buffer.from(await resp.arrayBuffer())
        const isPdfUrl = /\.pdf($|\?)/i.test(url)
        const ext = isPdfUrl
          ? 'pdf'
          : (path.extname(new URL(url).pathname).replace('.', '') || 'bin')
        const name = `artifact-${Date.now()}-${idx}.${ext}`
        const p = path.join(this.dir, name)
        fs.writeFileSync(p, buf)
        out.push({ name, path: p, kind: 'file', url, ext, size: buf.length })
      } catch {
        /* best-effort: skip undownloadable / expired links */
      }
    }
    return out
  }
}

// Singleton used by the chat path. Its directory comes from config (ARTIFACT_DIR
// env) or defaults to <runtime>/artifacts.
let singleton = null
function artifactStore() {
  if (!singleton) singleton = new ArtifactStore()
  return singleton
}

async function captureArtifacts(text, contextLabel) {
  try {
    const saved = await artifactStore().capture(text)
    if (saved.length) {
      logger.info(`[artifact-local] 已本地保存 ${saved.length} 个交付物 → ${artifactStore().dir} (${contextLabel})`, 'ARTIFACT', '📄')
    }
    return saved
  } catch (err) {
    logger.warn(`[artifact-local] 捕获失败 (${contextLabel}): ${err.message}`, 'ARTIFACT', '⚠️')
    return []
  }
}

module.exports = {
  ArtifactStore,
  artifactStore,
  captureArtifacts,
}
