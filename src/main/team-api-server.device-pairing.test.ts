import { DeviceTeamClient, parseDeviceInvitation, redeemDeviceInvitation } from "../../packages/team-client/src/device-client";
import { afterEach, expect, it } from "vitest";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);
it("serves an account-free phone page and only redeems a host-generated one-use link", async()=>{
 const f=await createTeamApiFixture("device-pairing");await f.store.configure("Dani-Dex","owner","secure-password");const {api,port}=await f.start({now:Date.now});
 const origin=`http://127.0.0.1:${port}`;
 const page=await fetch(`${origin}/device-pairing`);expect(page.status).toBe(200);expect(page.headers.get("referrer-policy")).toBe("no-referrer");expect(await page.text()).toContain("No account or app install needed");
 const link=api.createDevicePairingLink("https://host.example");const params=new URLSearchParams(new URL(link.url).hash.slice(1));const body={ticket:params.get("ticket"),hostId:params.get("host"),fingerprint:params.get("fingerprint"),deviceName:"Android phone"};
 const redeem=()=>fetch(`${origin}/v1/device-pairing/redeem`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 const paired=await redeem();expect(paired.status, JSON.stringify(await paired.clone().json())).toBe(201);expect((await redeem()).status).toBe(400);
 const data=await paired.json();expect(f.store.authenticate(data.sessionToken)?.role).toBe("owner");
 const logout=await fetch(`${origin}/v1/auth/logout`,{method:"POST",headers:{Authorization:`Bearer ${data.sessionToken}`}});expect(logout.status).toBe(204);expect(f.store.authenticate(data.sessionToken)).toBeNull();
});

it("the native direct-device client verifies the real host and reads its agents without account services", async()=>{
 const fixture=await createTeamApiFixture("native-device");await fixture.store.configure("Dani-Dex","owner","secure-password");const {api,base}=await fixture.start({now:Date.now});
 const invitation=parseDeviceInvitation(api.createDevicePairingLink("https://native-host.example").url);if(!invitation)throw Error("Missing invitation");
 const bridge:typeof fetch=(input,init)=>{const url=new URL(String(input));return fetch(new URL(url.pathname+url.search,base),init);};
 const session=await redeemDeviceInvitation(invitation,"Android phone",bridge,"0.17.8");const client=new DeviceTeamClient(session,bridge,"0.17.8");await client.verifyHost();
 const agents=await client.request("GET","/v1/agents",value=>value);expect(Array.isArray(agents)).toBe(true);
 await client.request("POST","/v1/auth/logout",()=>undefined);
 await expect(client.verifyHost()).rejects.toThrow("session has ended");
});

it("redeems a code from a plain URL without URL secrets",async()=>{
 const f=await createTeamApiFixture("code-http",{configure:true});const {api,base}=await f.start({now:Date.now});
 const invitation=api.createDevicePairingLink("https://host.example");
 const response=await fetch(base+"/v1/device-pairing/redeem-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:invitation.code,deviceName:"Code phone"})});
 expect(response.status).toBe(201);const session=await response.json();expect(f.store.authenticate(session.sessionToken)?.role).toBe("owner");
 expect((await fetch(base+"/v1/device-pairing/redeem-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:invitation.code,deviceName:"Code phone"})})).status).toBe(400);
});
