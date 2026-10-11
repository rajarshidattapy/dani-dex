import type { IncomingMessage, ServerResponse } from "node:http";
import { isDynamicRecord } from "@dani-dex/contracts/runtime-values";
import { DEVICE_PAIRING_CLIENT, DEVICE_PAIRING_PAGE } from "../device-pairing-page";
import type { DevicePairingService } from "../device-pairing-service";
import { HttpError } from "./http-error";
import type { RouteOutcome } from "./request-context";
import { stringField } from "./request-helpers";

/** A separate device protocol, not a change to the released Team API codecs. */
export async function routeDevicePairing(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  pairing: DevicePairingService,
  checkRate: () => void,
): Promise<RouteOutcome> {
  if (
    request.method === "GET" &&
    (url.pathname === "/device-pairing" || url.pathname === "/device-pairing-client.js")
  ) {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    response.writeHead(200, {
      "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    });
    response.end(url.pathname.endsWith(".js") ? DEVICE_PAIRING_CLIENT : DEVICE_PAIRING_PAGE);
    return "handled";
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/v1/device-pairing/redeem" || url.pathname === "/v1/device-pairing/redeem-code")
  ) {
    checkRate();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 2048) throw new HttpError(413, "Device request is too large.");
      chunks.push(bytes);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "A valid JSON object is required.");
    }
    if (!isDynamicRecord(body)) throw new HttpError(400, "A valid JSON object is required.");
    if (url.pathname.endsWith("redeem-code")) {
      const result = await pairing.redeemCode(
        stringField(body, "code", false, 16),
        stringField(body, "deviceName", false, 80),
      );
      response.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
      return "handled";
    }
    const ticket = stringField(body, "ticket", false, 128),
      hostId = stringField(body, "hostId", false, 128),
      fingerprint = stringField(body, "fingerprint", false, 128),
      deviceName = stringField(body, "deviceName", false, 80);
    const result = await pairing.redeem(ticket, hostId, fingerprint, deviceName);
    response.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result));
    return "handled";
  }
  return "unmatched";
}
