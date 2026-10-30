// 测试用「吃内存」脚本：分块真实写入，逼系统提交物理页。
// 用于验证启动壳的整树硬顶真的会拦住它。
const targetMb = Number(process.argv[2] ?? 1200)
const chunks = []
try {
  for (let index = 0; index < targetMb; index += 1) chunks.push(Buffer.alloc(1024 * 1024, 1))
  console.log(`ALLOC_OK ${chunks.length}`)
} catch (error) {
  console.log(`ALLOC_FAIL ${error.code ?? error.name}`)
  process.exit(3)
}
