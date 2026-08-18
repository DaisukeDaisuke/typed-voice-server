import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);

export class ServerSettingsStore {
  constructor(path) {
    this.path = path;
    this.value = { version: 1, modelProfile: "fp16" };
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (MODEL_PROFILES.has(parsed?.modelProfile)) this.value.modelProfile = parsed.modelProfile;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  get modelProfile() {
    return this.value.modelProfile;
  }

  async setModelProfile(modelProfile) {
    const normalized = String(modelProfile ?? "");
    if (!MODEL_PROFILES.has(normalized)) throw new Error("unsupported model profile");
    this.value = { ...this.value, version: 1, modelProfile: normalized };
    await this.#persist();
    return normalized;
  }

  async #persist() {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.value), "utf8");
    await rename(temporary, this.path);
  }
}
