import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { apply } from '../index.js'

export function mountTools(config) {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error('duplicate tool ' + definition.name)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
      checkGuards() {},
    },
    skills: {
      registerProvider(factory) {
        ctx.skills.provider = factory({ signal: undefined, invalidate() {} })
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        ctx.systemPrompt.section = section
        return () => {}
      },
    },
    waterfall(_carrier, _event, ...args) { return args.at(-1)() },
    events: { dispatch() { return [] } },
  }
  apply(ctx, config)
  const pipeline = new ToolExecutionPipeline(ctx, { get: (name) => registered.get(name) })
  let callId = 0
  const tools = new Map([...registered].map(([name, definition]) => [name, {
    ...definition,
    async execute(args) {
      const prepared = await pipeline.prepare({
        name, arguments: args, callId: 'test-' + ++callId, signal: new AbortController().signal,
      })
      const dispatched = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
      const result = await pipeline.complete(prepared.exec, dispatched)
      if (result.isError) throw new Error(result.error.message)
      return result.value
    },
  }]))
  return { ctx, tools }
}
