const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const config = require('../src/config/index.js')
const {
  persistGeneratedAsset,
  chooseAssetUrl,
  assetFileNameFor
} = require('../src/utils/asset-persist.js')

test('assetFileNameFor derives a stable name with extension', () => {
  const url = 'https://qwen-image.oss-example.com/gen/a/b/cat.png?x-oss-expires=300'
  const name = assetFileNameFor(url)
  assert.equal(name, assetFileNameFor(url))
  assert.match(name, /^[0-9a-f]{20}\.png$/)
  // 没有扩展名也不能产出 `.bin` 之外的怪名字，且必须保持稳定
  assert.match(assetFileNameFor('https://example.com/x'), /^[0-9a-f]{20}\.bin$/)
})

test('persistGeneratedAsset writes bytes locally and reuses on same URL', async (t) => {
  const originalSave = config.assetLocalSave
  config.assetLocalSave = true

  const url = 'https://example.com/gen/persist-test/result.jpg'
  const calls = { n: 0 }

  const fetcher = async () => {
    calls.n += 1
    return { data: Buffer.from('fake-image-bytes'), contentType: 'image/jpeg' }
  }

  const first = await persistGeneratedAsset(url, 't2i', { fetcher })
  assert.ok(first, '持久化成功应返回本地路径信息')
  assert.ok(fs.existsSync(first.filePath), '文件必须真正落到磁盘')
  assert.equal(fs.readFileSync(first.filePath, 'utf-8'), 'fake-image-bytes')
  assert.match(first.localUrl, /^\/assets\/generated\/[0-9a-f]{20}/)

  // 同 URL 再次持久化必须命中已有文件，不再下载
  const second = await persistGeneratedAsset(url, 't2i', { fetcher })
  assert.equal(calls.n, 1, '重复 URL 不应重复下载')
  assert.equal(second.filePath, first.filePath)

  // 清理测试产物
  t.after(() => {
    try { fs.unlinkSync(first.filePath) } catch { /* 已删除 */ }
    config.assetLocalSave = originalSave
  })
})

test('persistGeneratedAsset degrades to null on fetch failure (never throws)', async (t) => {
  const originalSave = config.assetLocalSave
  config.assetLocalSave = true
  t.after(() => { config.assetLocalSave = originalSave })

  const failingFetcher = async () => {
    throw new Error('上游 URL 已过期 404')
  }

  const result = await persistGeneratedAsset('https://example.com/dead-url.png', 't2i', {
    fetcher: failingFetcher
  })
  assert.equal(result, null, '下载失败必须返回 null 而不是抛异常')
})

test('persistGeneratedAsset is a no-op when ASSET_LOCAL_SAVE=false or URL invalid', async () => {
  const originalSave = config.assetLocalSave
  config.assetLocalSave = false
  assert.equal(await persistGeneratedAsset('https://example.com/a.png', 't2i'), null)
  config.assetLocalSave = true
  // 非法 URL 不应触发网络请求
  assert.equal(await persistGeneratedAsset('data:image/png;base64,xxx', 't2i', {
    fetcher: async () => { throw new Error('不应被调用') }
  }), null)
  config.assetLocalSave = originalSave
})

test('chooseAssetUrl respects ASSET_REPLACE_URL flag', () => {
  const originalReplace = config.assetReplaceUrl
  const persisted = { localUrl: '/assets/generated/abc.png', localFilePath: 'x', filePath: 'x', bytes: 1 }
  const upstream = 'https://example.com/upstream.png'

  config.assetReplaceUrl = false
  assert.equal(chooseAssetUrl(upstream, persisted), upstream, '默认仍返回上游 URL')
  assert.equal(chooseAssetUrl(upstream, null), upstream, '未持久化时必须回退上游 URL')

  config.assetReplaceUrl = true
  assert.equal(chooseAssetUrl(upstream, persisted), '/assets/generated/abc.png')
  assert.equal(chooseAssetUrl(upstream, null), upstream, '无本地文件时不能改写成不存在的地址')

  config.assetReplaceUrl = originalReplace
})

test('generated assets directory resolves under the runtime dir', () => {
  const { generatedAssetsDir, GENERATED_ASSET_SUBDIR } = require('../src/utils/asset-persist.js')
  const dir = generatedAssetsDir()
  assert.ok(path.isAbsolute(dir))
  assert.ok(dir.endsWith(GENERATED_ASSET_SUBDIR))
  // 不应把生成物写进系统临时目录（脱离部署目录会导致重启后丢失）
  assert.ok(!dir.startsWith(os.tmpdir()))
})
