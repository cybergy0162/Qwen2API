const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const config = require('../config')
const { logger } = require('./logger')
const { resolveRuntimePath } = require('./runtime-paths')
const accountManager = require('./account')
const { applyProxyToAxiosConfig } = require('./proxy-helper')

/**
 * 生成物本地持久化。
 *
 * 背景（debug 结论，2026-10-06）：t2i / image_edit / t2v 只是把提示词转发到
 * chat.qwen.ai 的 /api/v2/chat/completions，从 SSE/详情里正则抠出一个资源 URL
 * 再原样返回——服务端从不把生成物字节落到磁盘。上游 URL 是 Qwen OSS 的预签名
 * 链接，过期即 404，客户端拿到的引用最终是死的。
 *
 * 这里在返回给客户端之前把资源真正下载并写到本地 assets/generated/，让生成物
 * 在本机可复现、可审计、不受上游 URL 生命周期影响。任何失败只降级为日志，
 * 绝不影响生成流程本身。
 */

const GENERATED_ASSET_SUBDIR = path.join('assets', 'generated')
const DOWNLOAD_TIMEOUT_MS = 1000 * 120

const MIME_EXT_MAP = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/json': '.json'
}

const generatedAssetsDir = () => resolveRuntimePath('assets', 'generated')

/**
 * 由资源 URL 推导稳定文件名（内容寻址式的 URL 指纹 + 扩展名）。
 * 同一 URL 重复持久化会命中同一文件，天然去重。
 * @param {string} url
 * @returns {string} 例: a1b2c3d4e5f6.png
 */
const assetFileNameFor = (url) => {
    const digest = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20)
    let ext = ''
    try {
        ext = path.extname(new URL(String(url)).pathname).toLowerCase()
    } catch (e) {
        // 非法 URL 走下面的正则校验，落为 .bin
    }
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) {
        ext = ''
    }
    return `${digest}${ext || '.bin'}`
}

/**
 * 默认下载器：走账号级/全局代理，带浏览器 Referer 以兼容 OSS 防盗链。
 * @param {string} url
 * @returns {Promise<{ data: Buffer, contentType: string|null }>}
 */
const defaultFetcher = async (url) => {
    const requestConfig = {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers: {
            'Referer': 'https://chat.qwen.ai/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
        }
    }
    applyProxyToAxiosConfig(requestConfig, accountManager.getAccount())
    const response = await axios.get(url, requestConfig)
    return {
        data: Buffer.from(response.data),
        contentType: response.headers?.['content-type'] || null
    }
}

/**
 * 把生成物下载并写入本地 assets/generated/。
 * @param {string} contentUrl 上游返回的资源 URL
 * @param {string} kind 'image' | 'video'
 * @param {object} [options]
 * @param {(url: string) => Promise<{data: Buffer, contentType: string|null}>} [options.fetcher] 测试注入
 * @returns {Promise<{ localPath: string, localUrl: string, filePath: string, bytes: number }|null>}
 *          null = 未持久化（关闭 / 失败 / 非法 URL），调用方必须能原样降级。
 */
const persistGeneratedAsset = async (contentUrl, kind, options = {}) => {
    if (!config.assetLocalSave || !contentUrl || !/^https?:\/\//i.test(String(contentUrl))) {
        return null
    }

    const fetcher = options.fetcher || defaultFetcher

    try {
        let fileName = assetFileNameFor(contentUrl)
        const dir = generatedAssetsDir()
        fs.mkdirSync(dir, { recursive: true })
        const filePath = path.join(dir, fileName)

        // 已持久化过（同 URL 指纹）：直接复用，不重复下载
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
            return {
                localPath: path.join(GENERATED_ASSET_SUBDIR, fileName),
                localUrl: `/assets/generated/${fileName}`,
                filePath,
                bytes: fs.statSync(filePath).size
            }
        }

        const { data, contentType } = await fetcher(contentUrl)
        if (!Buffer.isBuffer(data) || data.length === 0) {
            throw new Error('下载内容为空')
        }

        // URL 不带扩展名时用 Content-Type 兜底，避免写出 .bin 导致客户端无法识别
        if (!path.extname(fileName)) {
            const extFromMime = contentType ? MIME_EXT_MAP[contentType.split(';')[0].trim().toLowerCase()] : null
            if (extFromMime) {
                fileName = `${path.basename(fileName, '.bin')}${extFromMime}`
            }
        }

        const targetPath = path.join(dir, fileName)
        // 先写临时文件再 rename：客户端可能同时拿到 localUrl 并立刻请求，
        // 半截文件比 404 更难排查。
        const tmpPath = `${targetPath}.tmp-${process.pid}`
        fs.writeFileSync(tmpPath, data)
        fs.renameSync(tmpPath, filePath)

        logger.info(`生成物已保存到本地: ${path.join(GENERATED_ASSET_SUBDIR, fileName)} (${data.length} bytes, ${kind})`, 'ASSET')

        return {
            localPath: path.join(GENERATED_ASSET_SUBDIR, fileName),
            localUrl: `/assets/generated/${fileName}`,
            filePath,
            bytes: data.length
        }
    } catch (error) {
        // 持久化失败不能把整次生成变成失败：降级回上游 URL 并留痕。
        logger.error('生成物本地保存失败', 'ASSET', '', {
            message: error?.message,
            code: error?.code,
            status: error?.response?.status,
            contentUrl
        })
        return null
    }
}

/**
 * 决定返回给客户端的 URL：默认仍用上游 URL（绝对地址，任何客户端都能取），
 * ASSET_REPLACE_URL=true 时改写为本地 /assets/... 地址，实现完全本地闭环。
 * @param {string} originalUrl
 * @param {object|null} persisted persistGeneratedAsset 的返回值
 * @returns {string}
 */
const chooseAssetUrl = (originalUrl, persisted) => {
    if (config.assetReplaceUrl && persisted?.localUrl) {
        return persisted.localUrl
    }
    return originalUrl
}

module.exports = {
    persistGeneratedAsset,
    chooseAssetUrl,
    assetFileNameFor,
    generatedAssetsDir,
    GENERATED_ASSET_SUBDIR
}
