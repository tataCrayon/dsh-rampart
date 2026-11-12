/**
 * 预占额度用户层存储的单元测试。
 *
 * 这一层的失败模式都很安静：覆盖文件写坏、目录不可写、没有 profile 目录时
 * 静默回落 —— 界面看起来一切正常，设置却丢了。所以每条路径都要有断言。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  RESERVE_FILE_NAME,
  clearReserveOverride,
  loadReserveOverride,
  resolveReserveFile,
  saveReserveOverride,
} from '../lib/reserve-store.js'

/**
 * 造一个隔离的「profile 目录」。
 * @returns {{DSH_PROFILE_DIR: string}} 只含 profile 目录的环境。
 */
function profileEnv() {
  return { DSH_PROFILE_DIR: mkdtempSync(join(tmpdir(), 'rg-reserve-')) }
}

test('覆盖文件落在 profile 目录，文件名是固定的', () => {
  const env = profileEnv()
  assert.equal(resolveReserveFile(env), join(env.DSH_PROFILE_DIR, RESERVE_FILE_NAME))
})

test('没有 profile 目录时退到 $DSH_HOME/storages', () => {
  const home = mkdtempSync(join(tmpdir(), 'rg-home-'))
  assert.equal(resolveReserveFile({ DSH_HOME: home }), join(home, 'storages', RESERVE_FILE_NAME))
})

test('两个环境变量都没有时无处可写，调用方要如实报 persisted:false', () => {
  assert.equal(resolveReserveFile({}), undefined)
})

test('保存后能读回来，且写的是整洁的 JSON', () => {
  const env = profileEnv()
  const saved = saveReserveOverride(2048, env)
  assert.equal(saved.ok, true)
  assert.deepEqual(loadReserveOverride(env), { value: 2048, path: saved.path })
  const text = readFileSync(saved.path, 'utf8')
  assert.match(text, /"reserveMemoryMb": 2048/, '字段名是手工可读的')
})

test('保存时负数与小数的处理：夹到 0 / 向下取整', () => {
  const env = profileEnv()
  saveReserveOverride(-100, env)
  assert.equal(loadReserveOverride(env).value, 0)
  saveReserveOverride(1536.9, env)
  assert.equal(loadReserveOverride(env).value, 1536)
})

test('文件不存在时读不到覆盖（不是 0，是「没有」）', () => {
  const env = profileEnv()
  assert.equal(loadReserveOverride(env), undefined, '没有覆盖必须与「覆盖成 0」区分开')
})

test('写入是原子的：成功后不留下 .tmp', () => {
  const env = profileEnv()
  const saved = saveReserveOverride(512, env)
  assert.equal(existsSync(`${saved.path}.tmp`), false)
})

test('文件被写坏时静默回落，不抛错', () => {
  const env = profileEnv()
  const path = resolveReserveFile(env)
  writeFileSync(path, '{ not json', 'utf8')
  assert.equal(loadReserveOverride(env), undefined, '坏文件等于没有覆盖，插件仍要能起来')

  writeFileSync(path, JSON.stringify({ reserveMemoryMb: '1024' }), 'utf8')
  assert.equal(loadReserveOverride(env), undefined, '字符串不做隐式强转')
})

test('重置会删掉覆盖；本来没有覆盖也算成功', () => {
  const env = profileEnv()
  saveReserveOverride(1024, env)
  assert.equal(clearReserveOverride(env).ok, true)
  assert.equal(loadReserveOverride(env), undefined)
  assert.equal(clearReserveOverride(env).ok, true)
})

test('无处可写时保存/重置都返回失败而不是抛错', () => {
  const saved = saveReserveOverride(1024, {})
  assert.equal(saved.ok, false)
  assert.equal(saved.error, 'no-profile-dir')
  assert.equal(clearReserveOverride({}).ok, false)
})
