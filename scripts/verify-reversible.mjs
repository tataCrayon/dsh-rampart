/**
 * 真机验收：护栏的**可逆性**。
 *
 * 这是整个设计里风险最高的一点：护栏往宿主进程上装的是**全局状态**
 * （优先级类、亲和性掩码）。如果 `dispose()` 没恢复干净，DSH 会一直以低优先级
 * 运行，用户只会觉得「这东西变卡了」，很难联想到是护栏留下的。
 *
 * 所以这里在真进程上跑一遍：记录原值 → 装上 → 断言变了 → 拆掉 → 断言复原。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { ResourceGuardian } from '../lib/guardian.js'
import { WIN32, loadWin32 } from '../lib/win32.js'

const win32 = await loadWin32(process.env)
if (!win32.available) {
  console.log(`SKIP: Win32 不可用（${win32.error}）`)
  process.exit(0)
}

const baseline = {
  priority: win32.getPriority(),
  affinity: win32.getAffinity().process,
}
console.log(`基线：优先级 ${baseline.priority}，亲和性 0x${baseline.affinity.toString(16)}`)

const guardian = new ResourceGuardian({
  config: {
    enabled: true,
    warnFreeMemoryMb: 2048,
    criticalFreeMemoryMb: 1024,
    warnCommitMb: 3072,
    criticalCommitMb: 1536,
    escalateSamples: 2,
    recoverSamples: 3,
    sampleIntervalMs: 0,
    priority: 'below-normal',
    limitCores: 2,
    warnDelayMs: 0,
    criticalDelayMs: 0,
    denyHeavyOnWarn: false,
    denyHeavyOnCritical: true,
    heavyTools: ['pwsh'],
    heavyPatterns: ['job_*'],
  },
  log: (level, message) => console.log(`  [${level}] ${message}`),
})

win32.available = true
guardian.win32 = win32
await guardian.start()

const applied = {
  priority: win32.getPriority(),
  affinity: win32.getAffinity().process,
}
console.log(`装上限后：优先级 ${applied.priority}，亲和性 0x${applied.affinity.toString(16)}`)
assert.equal(applied.priority, WIN32.BELOW_NORMAL_PRIORITY_CLASS, '优先级应降到 BELOW_NORMAL')
assert.equal(applied.affinity.toString(2).split('1').length - 1, 2, '应当只留 2 个核')

// 加压：让它在 critical 下拦一次，顺带验证 gate 走的是真读数
const decision = await guardian.gate('pwsh')
console.log(`gate(pwsh) => ${decision.action}`)

await guardian.dispose()
const restored = {
  priority: win32.getPriority(),
  affinity: win32.getAffinity().process,
}
console.log(`拆掉后：优先级 ${restored.priority}，亲和性 0x${restored.affinity.toString(16)}`)
assert.equal(restored.priority, baseline.priority, '优先级必须恢复')
assert.equal(restored.affinity, baseline.affinity, '亲和性必须恢复')

// 冻结/恢复：用一个真实子进程验证
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
await new Promise((resolve) => setTimeout(resolve, 300))
const frozen = guardian.freeze(child.pid)
console.log(`freeze(${child.pid}) => ${frozen}`)
const thawed = guardian.thaw(child.pid)
console.log(`thaw(${child.pid}) => ${thawed}`)
child.kill()

// 子进程继承优先级：这是「降优先级」真正有价值的地方
console.log('RESULT: PASS — 优先级与亲和性装上后能完整恢复')
