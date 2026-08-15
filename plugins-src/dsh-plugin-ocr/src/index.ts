import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-plugin-ocr'

export const inject = ['tools']

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PYTHON_CANDIDATES = ['python', 'python3', 'py']

function findPython(): string {
  return process.env.DSH_OCR_PYTHON || PYTHON_CANDIDATES[0]
}

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'ocr_image',
    description:
      '使用本机 RapidOCR 对图片（PNG/JPEG/WebP/BMP/TIFF）做本地 OCR 文字识别（中英文），' +
      '返回按阅读顺序排列的文本行；适合截图、扫描件、论文图片、手写提示词图片的文字提取。' +
      '可选 --json 模式返回每行文本、置信度和坐标框。',
    parameters: {
      filePath: { type: 'string', required: true, description: '要识别的图片文件的绝对路径或相对路径' },
      json: { type: 'boolean', description: '可选：true 时返回结构化 JSON（文本/置信度/坐标框），缺省返回纯文本行' },
      outputFilePath: { type: 'string', description: '可选：将识别文本写入该文件并返回摘要，而非返回完整文本' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const script = path.join(__dirname, '..', 'scripts', 'ocr.py')
      const cliArgs = [script, args.filePath]
      if (args.json) cliArgs.push('--json')
      let stdout: string
      try {
        const { stdout: out } = await execFileAsync(findPython(), cliArgs, {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 300_000,
          windowsHide: true,
        })
        stdout = out
      } catch (error) {
        const detail = (error as { stderr?: string; message?: string })
        throw new Error(`OCR 识别 "${args.filePath}" 失败: ${detail.stderr?.trim() || detail.message || error}`)
      }

      if (!stdout.trim()) {
        throw new Error(`OCR 识别 "${args.filePath}" 未得到任何文本（可能是空白图片或无法识别的格式）`)
      }

      if (args.outputFilePath) {
        await fs.writeFile(args.outputFilePath, stdout, 'utf8')
        const lineCount = stdout.trim().split(/\r?\n/).length
        return `已完成 OCR 识别 "${args.filePath}"，文本已写入 "${args.outputFilePath}"（${lineCount} 行）。`
      }

      return stdout
    },
  }))
}
