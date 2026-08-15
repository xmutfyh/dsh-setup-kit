# dsh-plugin-ocr

DSH（DeepSeek Harness）宿主插件：把本机 RapidOCR（ONNX CPU 推理，中英文）注册为 `ocr_image` 工具，
供 Agent 直接调用识别图片中的文字（截图、扫描件、论文图片、提示词图片等）。

- 离线本地识别，不上传图片；
- 需要本机 Python 环境已安装 `rapidocr_onnxruntime`（`pip install rapidocr_onnxruntime`）；
- 可用环境变量 `DSH_OCR_PYTHON` 指定 Python 可执行文件（默认 `python`）。

## 工具参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `filePath` | string | 是 | 图片文件绝对路径或相对路径 |
| `json` | boolean | 否 | true 时返回结构化 JSON（text/score/box），缺省返回纯文本行 |
| `outputFilePath` | string | 否 | 将识别文本写入该文件并返回摘要 |

## 安装

```sh
# 从源码构建
pnpm install
pnpm build

# 注册到 web profile（把 link 依赖加入 profiles/web/package.json 的 dependencies 与 bundles）
dsh plugin --profile web add link:C:/Users/fyh/Downloads/dsh-plugins-src/dsh-plugin-ocr
```

安装完成后重启 `dsh web` 生效。

## 开发

```sh
pnpm install   # 安装依赖
pnpm build     # 编译 TypeScript 到 lib/
```

单独测试 OCR 脚本：

```sh
python scripts/ocr.py <image> --json
```
