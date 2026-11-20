import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export async function readLocalFile(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error('Expected a regular file within the size limit')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    if (bytesRead > stat.size) throw new Error('File changed while being read')
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await file.close()
  }
}
