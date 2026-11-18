import { readMaterial } from '../lib/materials.js'

const file = process.argv[2]
const page = process.argv[3] ?? '1'
const from = Number(process.argv[4] ?? 1)
const to = Number(process.argv[5] ?? 999)

const material = await readMaterial(file, { pages: page })
for (const p of material.pages) {
  for (let index = from - 1; index < Math.min(to, p.lines.length); index += 1) {
    console.log(`${String(index + 1).padStart(3)}| ${p.lines[index]}`)
  }
}
