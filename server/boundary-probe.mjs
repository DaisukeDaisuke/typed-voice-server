import net from "node:net";

export async function assertLoopbackConnectDenied(port, { timeoutMs = 750 } = {}) {
  const targetPort = Number(port);
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error("probe port must be 1..65535");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("invalid probe timeout");
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
    let settled = false;
    const finishDenied = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise();
    };
    const finishConnected = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(new Error(`sandbox lateral loopback connection unexpectedly succeeded: 127.0.0.1:${targetPort}`));
    };
    const timer = setTimeout(finishDenied, timeoutMs);
    socket.once("connect", finishConnected);
    socket.once("error", finishDenied);
  });
  return true;
}
