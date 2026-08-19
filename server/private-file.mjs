import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const POSIX_PRIVATE_FILE_MODE = 0o600;

export function privateFileWriteOptions(platform = process.platform, encoding = null) {
  const options = {};
  if (encoding) options.encoding = encoding;
  // Windowsのアクセス制御はPOSIX modeではなくACLなので、modeを渡さず
  // 実行ユーザーで作成して親ディレクトリのWindows ACLを継承させる。
  if (platform !== "win32") options.mode = POSIX_PRIVATE_FILE_MODE;
  return options;
}

export async function writePrivateFileAtomic(path, data, { encoding = null, platform = process.platform } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  try {
    await writeFile(temporary, data, privateFileWriteOptions(platform, encoding));
    if (platform !== "win32") await chmod(temporary, POSIX_PRIVATE_FILE_MODE);
    await rename(temporary, path);
    if (platform !== "win32") await chmod(path, POSIX_PRIVATE_FILE_MODE);
    return realpath(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
