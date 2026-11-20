/**
 * card_preview 工具：把批次 / 计划 / noteId 的卡渲染成离线 HTML，可再出 PNG 与 PDF。
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadBatch } from '../batch.js'
import { getScheme } from '../scheme.js'
import { loadPlan } from '../write.js'
import { buildCardsHtml, buildPrintHtml, fieldsToHtml, measureOverflow, openFile, renderPdf, renderPng, renderTemplate, splitFields } from '../preview.js'

export function register(runtime) {
  const { store, anki, boot, text, assets: ASSETS } = runtime

  runtime.ctx.tools.register(runtime.defineTool({
    name: 'card_preview',
    description:
      '把批次 / 计划 / 指定 noteId 的卡渲染成离线 HTML（正面、背面、模型自带 CSS），返回文件路径；'
      + 'open=true 时用默认浏览器打开。只读 Anki，不写卡。',
    parameters: {
      batch: { type: 'string', description: '批次 id' },
      plan: { type: 'string', description: '计划 id（缺批次时按其批次预览）' },
      notes: { type: 'array', items: { type: 'integer' }, description: '指定 noteId，优先于批次' },
      scheme: { type: 'string', description: '直接渲染方案样卡（不需要批次）' },
      schemeVersion: { type: 'integer', description: 'scheme 的版本，默认 active' },
      sample: { type: 'string', description: '样卡名，默认 pass（samples/<sample>.json）' },
      png: { type: 'boolean', description: '再截一张 PNG（用本机 Edge 无头渲染；没有 Edge 时只出 HTML）' },
      mathjax: { type: 'boolean', description: '加载 MathJax 排版公式（默认开；mathjax=false 关闭）' },
      ankiBase: { type: 'boolean', description: '叠加近似版 Anki 基础样式（默认开）' },
      split: { type: 'boolean', description: '逐张另存 PNG，便于单张放大看（每张一次无头渲染，较慢）' },
      pdf: { type: 'boolean', description: '另出一份 A4 PDF，一张卡一页（正面、背面）' },
      measure: { type: 'boolean', description: '量横向溢出并回报（png 时默认开启）' },
      pdfStyle: { type: 'string', enum: ['qa', 'question', 'answer'], description: 'PDF 版式：qa 正反同页（默认）、question 只看正面、answer 只看背面' },
      pdfCss: { type: 'string', description: '自定义打印 CSS：文件路径，或 assets/print 下的文件名' },
      open: { type: 'boolean', description: '生成后用默认浏览器打开' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          png: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          cards: { type: 'integer' },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        return text(value.text)
      },
    },
    async execute(args) {
      await boot()
      let fieldsList = []
      let scheme = null
      let model = null
      let title = 'Anki 预览'

      if (args.scheme) {
        scheme = await getScheme(store.root, args.scheme, args.schemeVersion)
        if (!scheme) throw new Error(`没有方案 ${args.scheme}`)
        const sampleName = args.sample ?? 'pass'
        const sampleFile = join(store.root, 'schemes', scheme.id, 'samples', `${sampleName}.json`)
        if (!existsSync(sampleFile)) {
          throw new Error(`方案 ${scheme.id} 没有样卡 samples/${sampleName}.json`)
        }
        let sample
        try {
          sample = JSON.parse(readFileSync(sampleFile, 'utf8'))
        } catch (error) {
          throw new Error(`样卡解析失败：${error.message}`)
        }
        const fields = sample.fields ?? sample
        fieldsList = [Object.fromEntries(
          scheme.output.fields.map((field) => [field.name, fields[field.name] ?? '']),
        )]
        model = scheme.output.model
        title = `${scheme.title}｜样卡 ${sampleName}`
      } else if (args.notes?.length) {
        const info = (await anki.notesInfo(args.notes)) ?? []
        const present = info.filter(Boolean)
        for (const note of present) {
          fieldsList.push(Object.fromEntries(
            Object.entries(note.fields ?? {}).map(([name, value]) => [name, value?.value ?? '']),
          ))
        }
        model = present[0]?.modelName ?? null
        title = `预览 ${args.notes.length} 张`
        if (present.length < args.notes.length) title += `（缺 ${args.notes.length - present.length} 张）`
      } else {
        const plan = args.plan ? await loadPlan(store.root, args.plan) : null
        const batch = args.batch
          ? await loadBatch(store.root, args.batch)
          : (plan ? await loadBatch(store.root, plan.batchId) : null)
        if (!batch) throw new Error('preview 需要 batch、plan 或 notes')
        const ref = plan?.scheme ?? batch.scheme
        scheme = await getScheme(store.root, ref.id, ref.version)
        if (!scheme) throw new Error(`读不到方案 ${ref.id}@${ref.version}`)
        model = plan?.model ?? batch.target.model
        fieldsList = batch.items.map((item) => Object.fromEntries(
          scheme.output.fields.map((field) => [field.name, item.fields?.[field.name] ?? '']),
        ))
        title = batch.title || batch.id
      }

      let css = ''
      let template = null
      if (model) {
        try {
          css = (await anki.modelStyling(model))?.css ?? ''
        } catch {
          css = ''
        }
        try {
          const templates = await anki.modelTemplates(model)
          template = templates ? Object.values(templates)[0] ?? null : null
        } catch {
          template = null
        }
      }

      // 有真实模板就按模板渲染；没有才退回字段角色兜底
      const cards = fieldsList.map((fields) => {
        if (template?.Front && template?.Back) {
          const frontHtml = renderTemplate(template.Front, fields, 'front')
          const backHtml = renderTemplate(template.Back, fields, 'back', frontHtml)
          return { frontHtml, backHtml }
        }
        const split = splitFields(scheme, fields)
        return { frontHtml: fieldsToHtml(split.front), backHtml: fieldsToHtml(split.back) }
      })

      const useMath = args.mathjax !== false
      const useBase = args.ankiBase !== false
      const html = buildCardsHtml({
        cards,
        css,
        title,
        mathjax: useMath,
        ankiBase: useBase,
        measure: Boolean(args.png) && args.measure !== false,
      })
      const dir = join(store.root, 'previews')
      await mkdir(dir, { recursive: true })
      const stamp = Date.now().toString(36)
      const file = join(dir, `preview-${stamp}.html`)
      await writeFile(file, html, 'utf8')

      const files = []
      const edgeOptions = useMath
        ? { timeoutMs: 60000, virtualTimeBudget: 15000 }
        : { timeoutMs: 20000, virtualTimeBudget: 0 }

      let pngFile = null
      let pngNote = ''
      if (args.png) {
        pngFile = await renderPng(file, join(dir, `preview-${stamp}.png`), {
          width: 1100,
          height: Math.min(300 + cards.length * 700, 16000),
          ...edgeOptions,
        })
        if (pngFile) files.push(pngFile)
        pngNote = pngFile ? `；PNG：${pngFile}` : '；PNG 未生成（没找到 Edge 或渲染超时）'
      }

      if (args.scheme) {
        const renderDir = join(store.root, 'schemes', scheme.id, 'samples', 'render')
        await mkdir(renderDir, { recursive: true })
        const sampleName = args.sample ?? 'pass'
        const copiedHtml = join(renderDir, `${sampleName}.html`)
        copyFileSync(file, copiedHtml)
        files.push(copiedHtml)
        if (pngFile) {
          const copiedPng = join(renderDir, `${sampleName}.png`)
          copyFileSync(pngFile, copiedPng)
          files.push(copiedPng)
        }
      }

      if (args.split) {
        for (let index = 0; index < cards.length; index += 1) {
          const singleHtml = join(dir, `preview-${stamp}-${String(index + 1).padStart(2, '0')}.html`)
          await writeFile(singleHtml, buildCardsHtml({
            cards: [cards[index]],
            css,
            title: `${title} #${index + 1}`,
            mathjax: useMath,
            ankiBase: useBase,
          }), 'utf8')
          const singlePng = await renderPng(singleHtml, singleHtml.replace(/\.html$/, '.png'), {
            width: 1100,
            height: 1400,
            ...edgeOptions,
          })
          if (singlePng) files.push(singlePng)
        }
      }

      let pdfFile = null
      let pdfNote = ''
      if (args.pdf) {
        const schemePrint = scheme?.output?.print ?? {}
        const layout = args.pdfStyle ?? schemePrint.style ?? 'qa'
        let cssPath = args.pdfCss ?? schemePrint.css
        if (!cssPath && scheme) {
          const own = join(store.root, 'schemes', scheme.id, 'print.css')
          if (existsSync(own)) cssPath = own
        }
        let extraCss = ''
        if (cssPath) {
          const candidates = existsSync(cssPath)
            ? [cssPath]
            : [join(ASSETS, 'print', cssPath), join(store.root, 'print', cssPath)]
          const found = candidates.find((path) => existsSync(path))
          if (found) {
            extraCss = readFileSync(found, 'utf8')
            pdfNote = `；打印样式 ${found.split(/[\\/]/).pop()}`
          } else {
            pdfNote = `；打印样式未找到：${cssPath}`
          }
        }
        const printHtml = join(dir, `print-${stamp}.html`)
        await writeFile(printHtml, buildPrintHtml({
          cards,
          css,
          title: `${title}（打印版）`,
          ankiBase: useBase,
          mathjax: useMath,
          layout,
          extraCss,
        }), 'utf8')
        pdfFile = await renderPdf(printHtml, join(dir, `print-${stamp}.pdf`), edgeOptions)
        if (pdfFile) files.push(pdfFile)
        pdfNote = `；版式 ${layout}${pdfNote}`
      }

      let layoutNote = ''
      if (args.png && args.measure !== false) {
        const measured = await measureOverflow(file, edgeOptions)
        if (measured) {
          const bad = measured.filter((entry) => entry.bad?.length)
          layoutNote = bad.length
            ? `；溢出：${bad.map((entry) => `#${entry.card} ${entry.bad.join('/')}`).join('，')}`
            : '；无横向溢出'
        } else {
          layoutNote = '；溢出检测未返回'
        }
      }

      if (args.open) openFile(file)
      const extraNote = files.length > 1 ? `；另存 ${files.length - (pngFile ? 1 : 0)} 个文件` : ''
      return {
        file,
        ...(pngFile ? { png: pngFile } : {}),
        ...(files.length ? { files } : {}),
        cards: cards.length,
        text: `已生成 ${cards.length} 张卡的预览：${file}${pngNote}${layoutNote}${pdfNote}${extraNote}${args.open ? '（已用浏览器打开）' : ''}`,
      }
    },
  }))
}
