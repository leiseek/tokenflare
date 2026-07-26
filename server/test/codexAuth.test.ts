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

test("decodeAccountFromIdToken extracts the email from the JWT payload", () => {
  const acct = decodeAccountFromIdToken(
    fakeJwt({ email: "someone@example.com", name: "Real Name", sub: "user-123" }),
  );
  assert.equal(acct.email, "someone@example.com");
});

test("the account holder's name is never decoded", () => {
  // The display sits in the open on a desk. The email says which account the
  // quota belongs to; the name only adds a person's identity to the wall. Not
  // reading the claim at all means it cannot be surfaced by accident later.
  const acct = decodeAccountFromIdToken(
    fakeJwt({ email: "someone@example.com", name: "Real Name", sub: "user-123" }),
  );
  assert.deepEqual(Object.keys(acct), ["email"]);
  assert.ok(!JSON.stringify(acct).includes("Real Name"));
});

test("decodeAccountFromIdToken handles a payload with only email", () => {
  const acct = decodeAccountFromIdToken(fakeJwt({ email: "x@example.com" }));
  assert.equal(acct.email, "x@example.com");
});

test("a token carrying only a name yields no label at all", () => {
  // Better to fall back to a bare "Codex" header than to put a name up.
  const acct = decodeAccountFromIdToken(fakeJwt({ name: "Real Name", sub: "user-123" }));
  assert.deepEqual(acct, {});
});

test("decodeAccountFromIdToken returns {} for malformed/missing tokens", () => {
  assert.deepEqual(decodeAccountFromIdToken(null), {});
  assert.deepEqual(decodeAccountFromIdToken(""), {});
  assert.deepEqual(decodeAccountFromIdToken("not-a-jwt"), {});
  assert.deepEqual(decodeAccountFromIdToken("a.b"), {}); // only 2 segments
  assert.deepEqual(decodeAccountFromIdToken("header.!!!notbase64!!.sig"), {});
});
