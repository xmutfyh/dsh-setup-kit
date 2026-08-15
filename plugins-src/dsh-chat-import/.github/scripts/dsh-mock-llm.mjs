// .github/scripts/dsh-mock-llm.mjs — CI smoke 用的离线 mock LLM（SSE /chat/completions）
// 由 ci.yml 的 smoke job 后台启动；无真实凭据、无外网依赖、结果确定。
import { createServer } from 'node:http'

const PORT = 8790

const sse = (id, delta, finish, usage) => {
  const chunk = { id, object: 'chat.completion.chunk', created: 1700000000, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }
  if (usage) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/chat/completions') {
    req.resume() // mock 不读请求体，丢弃即可
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(sse('chatcmpl-smoke', { role: 'assistant', content: 'smoke ok' }, null))
      res.write(sse('chatcmpl-smoke', {}, 'stop', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }))
      res.end('data: [DONE]\n\n')
    })
    return
  }
  res.writeHead(404)
  res.end('not found')
}).listen(PORT, '127.0.0.1')
