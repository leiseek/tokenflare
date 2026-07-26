import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decodeAccountFromIdToken } from "../src/quota/codexAuth.js";

/** Build a fake JWT with a base64url payload (header.payload.signature). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "RS256" })}.${b64url(payload)}.signature`;
}

test("decodeAccountFromIdToken extracts name + email from the JWT payload", () => {
  const acct = decodeAccountFromIdToken(
    fakeJwt({ email: "you@example.com", name: "Example User", sub: "user-123" }),
  );
  assert.equal(acct.name, "Example User");
  assert.equal(acct.email, "you@example.com");
});

test("decodeAccountFromIdToken handles a payload with only email", () => {
  const acct = decodeAccountFromIdToken(fakeJwt({ email: "x@example.com" }));
  assert.equal(acct.email, "x@example.com");
  assert.equal(acct.name, undefined);
});

test("decodeAccountFromIdToken returns {} for malformed/missing tokens", () => {
  assert.deepEqual(decodeAccountFromIdToken(null), {});
  assert.deepEqual(decodeAccountFromIdToken(""), {});
  assert.deepEqual(decodeAccountFromIdToken("not-a-jwt"), {});
  assert.deepEqual(decodeAccountFromIdToken("a.b"), {}); // only 2 segments
  assert.deepEqual(decodeAccountFromIdToken("header.!!!notbase64!!.sig"), {});
});
