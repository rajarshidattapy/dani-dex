import { get } from "node:http";
import type { DaniDexModelSource } from "@dani-dex/contracts/online-services";
/** Attach a separately managed development proxy without turning it into a user custom endpoint. */
export async function developmentDaniFreeSource(
  origin: string,
  fetcher: typeof fetch = loopbackFetch,
): Promise<DaniDexModelSource | null> {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Development Dani Free must use a loopback HTTP origin.");
  const response = await fetcher(`${url.origin}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return null;
  const health = await response.json();
  if (!health || typeof health !== "object" || health.ok !== true) return null;
  return {
    id: "dani",
    name: "Dani Free",
    baseUrl: `${url.origin}/v1`,
    models: [{ id: "dani-free-auto", name: "Dani Free Auto", reasoningEffortLevels: [] }],
    headers: [],
  };
}

// Port4190 is on browser fetch's blocked-port list. Main-process loopback HTTP does not
// relax browser security and still has a bounded socket/request deadline.
const loopbackFetch: typeof fetch = async (input) =>
  new Promise<Response>((resolve, reject) => {
    const request = get(String(input), (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 65536) request.destroy(new Error("Dani health response too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })));
      response.on("error", reject);
    });
    const deadline = setTimeout(() => request.destroy(new Error("Dani health check timed out")), 5000);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject);
  });
