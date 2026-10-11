import { createServer } from "node:http";
import { expect, it } from "vitest";
import { developmentDaniFreeSource } from "./development-dani-free-source";

it("uses real bounded Node HTTP rather than browser fetch for loopback health", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  try {
    expect((await developmentDaniFreeSource(`http://127.0.0.1:${address.port}`))?.id).toBe("dani");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
