import assert from "node:assert/strict";
import test from "node:test";

process.env.PIN_PEPPER = "test-only-pepper";

const { hashPin, sameSecret, validateCredentials } = await import("../lib/backend.mjs");

test("normalizes names and validates four-digit PINs", () => {
  assert.deepEqual(validateCredentials("  Nova  ", "2017"), {
    ok: true,
    name: "Nova",
    pin: "2017",
  });
  assert.deepEqual(validateCredentials("", "2017"), {
    ok: false,
    error: "name_required",
  });
  assert.deepEqual(validateCredentials("Nova", "123"), {
    ok: false,
    error: "pin_must_be_4_digits",
  });
});

test("hashes PINs deterministically without storing the PIN", async () => {
  const first = await hashPin("Nova", "2017");
  const sameName = await hashPin("nova", "2017");
  const otherPin = await hashPin("Nova", "9999");
  assert.equal(first.length, 64);
  assert.equal(first, sameName);
  assert.notEqual(first, otherPin);
  assert.equal(first.includes("2017"), false);
});

test("compares secrets without early character exits", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "ab"), false);
});
