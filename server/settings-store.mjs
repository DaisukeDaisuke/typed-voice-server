import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);
const CLIENT_HASH_RE = /^[0-9a-f]{64}$/;
const CLIENT_SALT_RE = /^[A-Za-z0-9_-]{43}$/;

export class ServerSettingsStore {
  constructor(path) {
    this.path = path;
    this.value = {
      version: 2,
      modelProfile: "fp16",
      clientBanSalt: null,
      clientBans: [],
    };
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true });
    let dirty = false;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (MODEL_PROFILES.has(parsed?.modelProfile)) this.value.modelProfile = parsed.modelProfile;
      if (CLIENT_SALT_RE.test(String(parsed?.clientBanSalt ?? ""))) {
        this.value.clientBanSalt = String(parsed.clientBanSalt);
      }
      if (Array.isArray(parsed?.clientBans)) {
        this.value.clientBans = [...new Set(parsed.clientBans
          .map((entry) => String(entry ?? "").toLowerCase())
          .filter((entry) => CLIENT_HASH_RE.test(entry)))];
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      dirty = true;
    }
    if (!this.value.clientBanSalt) {
      this.value.clientBanSalt = randomBytes(32).toString("base64url");
      dirty = true;
    }
    this.value.version = 2;
    if (dirty) await this.#persist();
    return this;
  }

  get modelProfile() {
    return this.value.modelProfile;
  }

  get clientBanSalt() {
    return this.value.clientBanSalt;
  }

  get clientBans() {
    return [...this.value.clientBans];
  }

  isClientBanned(clientHash) {
    const normalized = String(clientHash ?? "").toLowerCase();
    return CLIENT_HASH_RE.test(normalized) && this.value.clientBans.includes(normalized);
  }

  async setModelProfile(modelProfile) {
    const normalized = String(modelProfile ?? "");
    if (!MODEL_PROFILES.has(normalized)) throw new Error("unsupported model profile");
    this.value = { ...this.value, version: 2, modelProfile: normalized };
    await this.#persist();
    return normalized;
  }

  async setClientBanned(clientHash, banned) {
    const normalized = String(clientHash ?? "").toLowerCase();
    if (!CLIENT_HASH_RE.test(normalized)) throw new Error("invalid client hash");
    const bans = new Set(this.value.clientBans);
    if (banned) bans.add(normalized);
    else bans.delete(normalized);
    this.value = { ...this.value, version: 2, clientBans: [...bans].sort() };
    await this.#persist();
    return banned;
  }

  async #persist() {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.value), "utf8");
    await rename(temporary, this.path);
  }
}
