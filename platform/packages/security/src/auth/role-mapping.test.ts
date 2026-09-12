import { describe, it, expect } from "vitest";
import { resolveRoles, resolveGroups, CIS2_ROLE_MAPPINGS } from "./role-mapping.js";

describe("resolveRoles", () => {
  it("maps array claims through mapping table", () => {
    const result = resolveRoles(
      { nhsroles: ["R8000", "R8001"] },
      CIS2_ROLE_MAPPINGS,
    );
    expect(result).toContain("clinician");
    expect(result).toContain("nurse_in_charge");
  });

  it("handles single string claim value", () => {
    const result = resolveRoles(
      { nhsroles: "R8003" },
      CIS2_ROLE_MAPPINGS,
    );
    expect(result).toEqual(["admin"]);
  });

  it("returns empty array when claim is missing", () => {
    const result = resolveRoles({}, CIS2_ROLE_MAPPINGS);
    expect(result).toEqual([]);
  });

  it("returns empty array when claim is null", () => {
    const result = resolveRoles({ nhsroles: null }, CIS2_ROLE_MAPPINGS);
    expect(result).toEqual([]);
  });

  it("deduplicates roles when multiple codes map to same role", () => {
    // R8000 and R8004 both map to "clinician"
    const result = resolveRoles(
      { nhsroles: ["R8000", "R8004"] },
      CIS2_ROLE_MAPPINGS,
    );
    expect(result).toEqual(["clinician"]);
  });

  it("ignores unmapped claim values", () => {
    const result = resolveRoles(
      { nhsroles: ["R8000", "UNKNOWN"] },
      CIS2_ROLE_MAPPINGS,
    );
    expect(result).toEqual(["clinician"]);
  });

  it("works with custom mapping configs", () => {
    const customMapping = {
      claimName: "app_roles",
      mappings: { "ROLE_ADMIN": "admin", "ROLE_USER": "user" },
    };
    const result = resolveRoles(
      { app_roles: ["ROLE_ADMIN"] },
      customMapping,
    );
    expect(result).toEqual(["admin"]);
  });
});

describe("resolveGroups", () => {
  it("extracts array groups", () => {
    const result = resolveGroups({ groups: ["ward-a", "cardiology"] });
    expect(result).toEqual(["ward-a", "cardiology"]);
  });

  it("wraps single string group into array", () => {
    const result = resolveGroups({ groups: "single-group" });
    expect(result).toEqual(["single-group"]);
  });

  it("returns empty array when groups claim is missing", () => {
    const result = resolveGroups({});
    expect(result).toEqual([]);
  });

  it("returns empty array when groups claim is null", () => {
    const result = resolveGroups({ groups: null });
    expect(result).toEqual([]);
  });
});
