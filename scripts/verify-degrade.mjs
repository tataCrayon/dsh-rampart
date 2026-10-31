/**
 * 降级路径验证：Win32 不可用时插件必须「退化为纯观测」，不能崩、不能误拦。
 * 这在非 Windows 或 koffi/绑定缺失时是真实场景（市场用户会碰到）。
 */

import { ResourceGuardian } from '../lib/guardian.js'
import { Config } from '../lib/config.js'
import { loadWin32 } from '../lib/win32.js'

let failures = 0
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`)
  if (!ok) failures += 1
}

const config = Config['~standard'].validate({}).value

// 1) 强制走 fallback：给一个平台谎报的 env 也不行，直接构造不带 win32 的守护者
{
  const guardian = new ResourceGuardian({ config })
  // 不调 init()，win32 保持 undefined → sampleOnce 走 fallbackMemoryStatus
  const state = guardian.tick()
  check(typeof state.grade === 'string', `无能力层时仍能定级（${state.grade}）`)
  const snapshot = guardian.state().snapshot
  check(Number.isFinite(snapshot.totalMb), `快照仍是数字（total ${snapshot.totalMb} MB）`)
  check(guardian.state().capabilities.win32 === false, '能力位如实报告 win32=false')
}

// 2) 无能力层时 gate 不能抛
{
  const guardian = new ResourceGuardian({ config })
  let threw = null
  let decision
  try {
    decision = await guardian.gate('pwsh')
  } catch (error) {
    threw = error.message
  }
  check(threw === null, `无能力层时 gate 不抛（${threw ?? '正常'}）`)
  check(decision?.action === 'allow' || decision?.action === 'deny', `gate 仍返回合法决策（${decision?.action}）`)
}

// 3) 无能力层时 start/dispose 不能抛
{
  const guardian = new ResourceGuardian({ config: { ...config, priority: 'below-normal', limitCores: 2 } })
  let threw = null
  try {
    await guardian.start()
    await guardian.dispose()
  } catch (error) {
    threw = error.message
  }
  check(threw === null, `无能力层时 start/dispose 不抛（${threw ?? '正常'}）`)
}

// 4) 本机真实能力层可用性
{
  const win32 = await loadWin32(process.env)
  check(win32.available === true, `本机 Win32 能力层可用${win32.available ? '' : `（${win32.error}）`}`)
}

console.log(failures === 0 ? '\n结果：PASS — 降级安全' : `\n结果：FAIL（${failures} 项）`)
process.exitCode = failures === 0 ? 0 : 1
