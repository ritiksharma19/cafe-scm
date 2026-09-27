import { describe, expect, it } from "vitest";
import { loginEmail, normalizeUsername, PIN_PATTERN, USERNAME_PATTERN } from "./username";

describe("username helpers", () => {
  it("maps usernames to synthetic emails and passes real emails through", () => {
    expect(loginEmail("  Ravi ", "staff.example.app")).toBe("ravi@staff.example.app");
    expect(loginEmail("Owner@Gmail.com", "staff.example.app")).toBe("owner@gmail.com");
  });

  it("validates usernames like the database constraint", () => {
    expect(USERNAME_PATTERN.test(normalizeUsername("Cart1.Ravi"))).toBe(true);
    expect(USERNAME_PATTERN.test("r")).toBe(false);
    expect(USERNAME_PATTERN.test("ravi kumar")).toBe(false);
  });

  it("requires a 6-digit PIN", () => {
    expect(PIN_PATTERN.test("123456")).toBe(true);
    expect(PIN_PATTERN.test("12345")).toBe(false);
    expect(PIN_PATTERN.test("12a456")).toBe(false);
  });
});

describe("business login helpers", () => {
  it("normalises cafe codes and builds per-business sign-in addresses", async () => {
    const { normalizeBusinessCode, businessLoginEmail, BUSINESS_CODE_PATTERN } = await import("./username");
    expect(normalizeBusinessCode(" chai-point ")).toBe("CHAIPOINT");
    expect(BUSINESS_CODE_PATTERN.test("CHAIPOINT")).toBe(true);
    expect(BUSINESS_CODE_PATTERN.test("AB")).toBe(false);
    expect(businessLoginEmail("chaipoint", " Ravi ", "staff.example.app")).toBe("chaipoint.ravi@staff.example.app");
  });
});
