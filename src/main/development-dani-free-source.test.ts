import { describe, expect, it, vi } from "vitest";
import { developmentDaniFreeSource } from "./development-dani-free-source";

describe("official development Dani Free source", () => {
  it("attaches healthy loopback anonymously as built-in Dani", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const source = await developmentDaniFreeSource("http://127.0.0.1:4190", fetcher);
    expect(source).toMatchObject({
      id: "dani",
      name: "Dani Free",
      baseUrl: "http://127.0.0.1:4190/v1",
      models: [{ id: "dani-free-auto" }],
      headers: [],
    });
    expect(source?.apiKey).toBeUndefined();
  });
  it("does not publish an unhealthy route", async () =>
    expect(
      await developmentDaniFreeSource(
        "http://127.0.0.1:4190",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }))),
      ),
    ).toBeNull());
  it("rejects remote/credential URLs", async () => {
    for (const url of ["https://example.com", "http://user@127.0.0.1:4190", "http://127.0.0.1:4190/x"])
      await expect(developmentDaniFreeSource(url)).rejects.toThrow();
  });
});
