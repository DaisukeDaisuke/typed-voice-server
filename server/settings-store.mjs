import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);

export class ServerSettingsStore {
  constructor(path) {
    this.path = path;
    this.value = { version: 1, modelProfile: "fp16", adminPort: null };
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (MODEL_PROFILES.has(parsed?.modelProfile)) this.value.modelProfile = parsed.modelProfile;
      if (Number.isSafeInteger(parsed?.adminPort) && parsed.adminPort >= 49152 && parsed.adminPort <= 65535) {
        this.value.adminPort = parsed.adminPort;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  get modelProfile() {
    return this.value.modelProfile;
  }

  get adminPort() {
    return this.value.adminPort;
  }

  async setModelProfile(modelProfile) {
    const normalized = String(modelProfile ?? "");
    if (!MODEL_PROFILES.has(normalized)) throw new Error("unsupported model profile");
    this.value = { ...this.value, version: 1, modelProfile: normalized };
    await this.#persist();
    return normalized;
  }

  async setAdminPort(adminPort) {
    if (!Number.isSafeInteger(adminPort) || adminPort < 49152 || adminPort > 65535) throw new Error("adminPort must be 49152..65535");
    this.value = { ...this.value, version: 1, adminPort };
    await this.#persist();
    return adminPort;
  }

  async #persist() {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.value), "utf8");
    await rename(temporary, this.path);
  }
}
