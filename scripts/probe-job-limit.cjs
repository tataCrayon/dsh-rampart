// 校正 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 偏移后重测。
//
// x64 布局（与 dsh-win32-process 的 EXTENDED_LIMIT_SIZE=144 一致）：
//   JOBOBJECT_BASIC_LIMIT_INFORMATION = 64 字节
//     PerProcessUserTimeLimit  0
//     PerJobUserTimeLimit      8
//     LimitFlags              16
//     MinimumWorkingSetSize   24
//     MaximumWorkingSetSize   32
//     ActiveProcessLimit      40
//     Affinity                48
//     PriorityClass           56
//     SchedulingClass         60
//   IO_COUNTERS              64..112（48 字节）
//   ProcessMemoryLimit     112
//   JobMemoryLimit         120
//   PeakProcessMemoryUsed  128
//   PeakJobMemoryUsed      136
const koffi = require('koffi')
const kernel32 = koffi.load('kernel32.dll')

const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *attr, const char16_t *name)')
const SetInformationJobObject = kernel32.func('int SetInformationJobObject(void *job, int cls, void *info, uint32 len)')
const QueryInformationJobObject = kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)')
const CloseHandle = kernel32.func('int CloseHandle(void *h)')
const GetLastError = kernel32.func('uint32 GetLastError()')

const KILL_ON_CLOSE = 0x2000
const PROCESS_MEMORY = 0x0100
const JOB_MEMORY = 0x0200
const EXTENDED_CLASS = 9
const ACCOUNTING_CLASS = 1

const LIMIT_FLAGS = 16
const PROCESS_MEMORY_LIMIT = 112
const JOB_MEMORY_LIMIT = 120

function attempt(label, fill) {
  const job = CreateJobObjectW(null, null)
  const info = Buffer.alloc(144)
  fill(info)
  const ok = SetInformationJobObject(job, EXTENDED_CLASS, info, 144)
  const lastErr = GetLastError()
  const readback = Buffer.alloc(144)
  QueryInformationJobObject(job, EXTENDED_CLASS, readback, 144, null)
  console.log(
    label, '=> set:', ok, 'lastError:', lastErr,
    'flags:0x' + readback.readUInt32LE(LIMIT_FLAGS).toString(16),
    'procMb:', Number(readback.readBigUInt64LE(PROCESS_MEMORY_LIMIT)) / 1048576,
    'jobMb:', Number(readback.readBigUInt64LE(JOB_MEMORY_LIMIT)) / 1048576,
  )
  CloseHandle(job)
  return ok
}

const a = attempt('kill-on-close only       ', (b) => b.writeUInt32LE(KILL_ON_CLOSE, LIMIT_FLAGS))
const b = attempt('kill + procMem 256MB     ', (x) => {
  x.writeUInt32LE(KILL_ON_CLOSE | PROCESS_MEMORY, LIMIT_FLAGS)
  x.writeBigUInt64LE(256n * 1024n * 1024n, PROCESS_MEMORY_LIMIT)
})
const c = attempt('procMem only 256MB       ', (x) => {
  x.writeUInt32LE(PROCESS_MEMORY, LIMIT_FLAGS)
  x.writeBigUInt64LE(256n * 1024n * 1024n, PROCESS_MEMORY_LIMIT)
})
const d = attempt('jobMem only 512MB        ', (x) => {
  x.writeUInt32LE(JOB_MEMORY, LIMIT_FLAGS)
  x.writeBigUInt64LE(512n * 1024n * 1024n, JOB_MEMORY_LIMIT)
})

console.log('RESULT:', (a && b && c && d) ? 'ALL OK — offsets 112/120 accepted' : 'SOME FAILED')
