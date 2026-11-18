import { readMaterial, findLines } from '../lib/materials.js'

const file = process.argv[2]
const page = process.argv[3] ?? '31'
const keyword = process.argv[4]

const material = await readMaterial(file, { pages: page })
console.log(`kind=${material.kind} totalPages=${material.totalPages} pages=${material.pages.length}`)
for (const p of material.pages) {
  console.log(`--- p${p.page} lines=${p.lines.length}`)
  for (const line of p.lines.slice(0, 8)) console.log(`  |${line.slice(0, 90)}`)
}
if (keyword) {
  const hits = findLines(material, keyword)
  console.log(`命中 ${hits.length} 行：`)
  for (const hit of hits.slice(0, 5)) console.log(`  p${hit.page}:L${hit.line} ${hit.text.slice(0, 80)}`)
}
