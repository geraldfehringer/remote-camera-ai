import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const fixturesDir = path.join(process.cwd(), 'e2e', 'fixtures')
const outputPath = path.join(fixturesDir, 'motion.y4m')

const width = 320
const height = 240
const frames = 90

function frameBuffer(frameIndex) {
  const yPlane = Buffer.alloc(width * height, 22)
  const uPlane = Buffer.alloc((width / 2) * (height / 2), 128)
  const vPlane = Buffer.alloc((width / 2) * (height / 2), 128)

  const squareSize = 72
  const maxLeft = width - squareSize - 1
  const left = Math.floor((frameIndex / (frames - 1)) * maxLeft)
  const top = 84

  for (let y = top; y < top + squareSize; y += 1) {
    for (let x = left; x < left + squareSize; x += 1) {
      yPlane[y * width + x] = 235
    }
  }

  return Buffer.concat([Buffer.from('FRAME\n'), yPlane, uPlane, vPlane])
}

await mkdir(fixturesDir, { recursive: true })

const header = `YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg XYSCSS=420JPEG\n`
const content = [Buffer.from(header)]

for (let index = 0; index < frames; index += 1) {
  content.push(frameBuffer(index))
}

await writeFile(outputPath, Buffer.concat(content))
