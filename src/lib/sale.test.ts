import { describe, expect, it } from "vitest";
import { isDefinitiveFailure } from "./sale";

describe("isDefinitiveFailure", () => {
  it("treats database and API errors as definitive (order not saved)", () => {
    expect(isDefinitiveFailure({ code: "22023" })).toBe(true);
    expect(isDefinitiveFailure({ code: "42501" })).toBe(true);
    expect(isDefinitiveFailure({ code: "PGRST202" })).toBe(true);
  });

  it("treats network failures as unknown (retry with the same id)", () => {
    expect(isDefinitiveFailure({ code: "" })).toBe(false);
    expect(isDefinitiveFailure(undefined)).toBe(false);
  });
});
