import { randomInt } from "node:crypto";

export const HIGH_PORT_MIN = 49152;
export const HIGH_PORT_MAX = 65535;

export async function listenOnRandomHighPort(server, host = "127.0.0.1", { attempts = 64 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = randomInt(HIGH_PORT_MIN, HIGH_PORT_MAX + 1);
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error(`no loopback port was available in ${HIGH_PORT_MIN}-${HIGH_PORT_MAX}`);
}
