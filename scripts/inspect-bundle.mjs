// 检查生成的 bundle 里的 require 与导出清单。
import { readFileSync } from 'node:fs'

const text = readFileSync('lib/client.js', 'utf8')
const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
console.log('require 的模块：', [...new Set(requires)].join(', '))
const exportsList = [...text.matchAll(/^\t\texports\.(\w+) =/gm)].map((m) => m[1])
console.log('导出：', exportsList.join(', '))
const hasInject = /const inject = \[/.test(text)
console.log('有 inject 声明：', hasInject)
console.log('有 apply：', /^\t\tfunction apply\(/m.test(text))
